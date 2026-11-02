use std::fs;

use tkrform_core::crypto;
use tkrform_core::error::Error;
use tkrform_core::fsutil;
use tkrform_core::model::{Item, ItemType};
use tkrform_core::vault::{self, Vault};

const ITER: u32 = 1000; // テストでは反復回数を小さくする

fn new_vault(dir: &std::path::Path) -> Vault {
    Vault::create(dir, "correct horse battery", ITER).unwrap()
}

#[test]
fn crypto_round_trip_and_aad() {
    let key = crypto::random_bytes::<32>();
    let sealed = crypto::seal(&key, b"aad", b"hello");
    assert_eq!(&**crypto::open(&key, b"aad", &sealed).unwrap(), b"hello");
    assert!(crypto::open(&key, b"other", &sealed).is_err(), "AAD 違いは失敗する");
    let key2 = crypto::random_bytes::<32>();
    assert!(crypto::open(&key2, b"aad", &sealed).is_err(), "鍵違いは失敗する");
    // nonce は毎回違う
    assert_ne!(crypto::seal(&key, b"aad", b"hello"), crypto::seal(&key, b"aad", b"hello"));
}

#[test]
fn kdf_is_deterministic_and_salted() {
    let a = crypto::derive_kek(b"pw", b"salt-aaaaaaaaaaaa", 1000);
    let b = crypto::derive_kek(b"pw", b"salt-aaaaaaaaaaaa", 1000);
    let c = crypto::derive_kek(b"pw", b"salt-bbbbbbbbbbbb", 1000);
    assert_eq!(*a, *b);
    assert_ne!(*a, *c);
    assert_ne!(*crypto::derive_auth_key(b"pw", b"salt-aaaaaaaaaaaa", 1000), *a, "認証鍵は KEK と別の鍵");
}

#[test]
fn vault_create_open_crud() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let id;
    {
        let mut v = new_vault(dir);
        let mut it = Item::new_login("GitHub", "https://github.com/login", "taro", "s3cret!");
        v.save_item(&mut it).unwrap();
        assert_eq!(it.rev, 1);
        id = it.id.clone();
        let mut memo = Item::new(ItemType::Note, "メモ");
        memo.text = "秘密のメモ".into();
        v.save_item(&mut memo).unwrap();
    }
    // 再オープン（正しい MP）
    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert_eq!(v.len(), 2);
    let it = v.get_item(&id).unwrap();
    assert_eq!(it.login_user(), "taro");
    assert_eq!(it.login_password(), "s3cret!");
    // 平文がディスクに残っていない
    for e in fs::read_dir(dir.join("items")).unwrap().flatten() {
        let bytes = fs::read(e.path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("s3cret!"));
        assert!(!String::from_utf8_lossy(&bytes).contains("GitHub"));
    }
    let idx = fs::read(dir.join("index.tkx")).unwrap();
    assert!(!String::from_utf8_lossy(&idx).contains("github"));
    // 更新で rev が増え、履歴が積まれる
    let mut it = v.get_item(&id).unwrap();
    it.fields[1].value = "n3w-pass".into();
    v.save_item(&mut it).unwrap();
    let it = v.get_item(&id).unwrap();
    assert_eq!(it.rev, 2);
    assert_eq!(it.password_history.len(), 1);
    assert_eq!(it.password_history[0].value, "s3cret!");
    // ゴミ箱 → 復元 → 完全削除
    v.delete_item(&id).unwrap();
    assert!(v.entry(&id).unwrap().deleted);
    assert!(v.search("github", &[], 10).is_empty());
    v.restore_item(&id).unwrap();
    assert_eq!(v.search("github", &[], 10).len(), 1);
    v.purge_item(&id).unwrap();
    assert!(matches!(v.get_item(&id), Err(Error::NotFound(_))));
    assert_eq!(v.len(), 1);
}

#[test]
fn wrong_master_password_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    new_vault(tmp.path());
    assert!(matches!(Vault::open(tmp.path(), "wrong"), Err(Error::BadPassword)));
    assert!(matches!(Vault::open(tmp.path(), ""), Err(Error::BadPassword)));
    assert!(Vault::open(tmp.path(), "correct horse battery").is_ok());
}

#[test]
fn header_tamper_is_detected() {
    let tmp = tempfile::tempdir().unwrap();
    new_vault(tmp.path());
    let p = tmp.path().join("vault.hdr");
    let mut b = fs::read(&p).unwrap();
    b[10] ^= 0x01; // 反復回数を書き換える
    fs::write(&p, &b).unwrap();
    assert!(Vault::open(tmp.path(), "correct horse battery").is_err());
}

#[test]
fn tampered_item_is_flagged_and_others_stay_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b);
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "p-a");
        let mut y = Item::new_login("B", "https://b-site.com", "u", "p-b");
        v.save_item(&mut x).unwrap();
        v.save_item(&mut y).unwrap();
        a = x.id;
        b = y.id;
    }
    // 暗号文を 1 バイト改変
    let path = dir.join("items").join(format!("{a}.tki"));
    let mut bytes = fs::read(&path).unwrap();
    let last = bytes.len() - 5;
    bytes[last] ^= 0xFF;
    fs::write(&path, &bytes).unwrap();

    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert!(v.entry(&a).unwrap().corrupt, "改変したアイテムは破損と表示される");
    assert!(!v.entry(&b).unwrap().corrupt);
    assert!(matches!(v.get_item(&a), Err(Error::CorruptItem(_))));
    assert_eq!(v.get_item(&b).unwrap().login_password(), "p-b");
    // 照合の対象から外れる
    assert!(v.match_logins("https://a-site.com/", &[]).is_empty());
    assert_eq!(v.check_integrity().unwrap(), vec![a]);
}

#[test]
fn header_field_tamper_of_item_is_detected() {
    // rev を書き換えると AAD が変わり復号に失敗する（ロールバック攻撃対策）
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let id;
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "p");
        v.save_item(&mut x).unwrap();
        id = x.id;
    }
    let path = dir.join("items").join(format!("{id}.tki"));
    let mut bytes = fs::read(&path).unwrap();
    bytes[9] = bytes[9].wrapping_add(1);
    fs::write(&path, &bytes).unwrap();
    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert!(matches!(v.get_item(&id), Err(Error::CorruptItem(_))));
}

#[test]
fn item_file_swapped_under_other_id_is_detected() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let (a, b);
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "pa");
        let mut y = Item::new_login("B", "https://b-site.com", "u", "pb");
        v.save_item(&mut x).unwrap();
        v.save_item(&mut y).unwrap();
        a = x.id;
        b = y.id;
    }
    fs::copy(dir.join("items").join(format!("{a}.tki")), dir.join("items").join(format!("{b}.tki"))).unwrap();
    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert!(matches!(v.get_item(&b), Err(Error::CorruptItem(_))), "ID を入れ替えたファイルは AAD で検知される");
}

#[test]
fn atomic_write_replaces_and_leaves_no_tmp() {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("f.bin");
    fsutil::write_atomic(&p, b"one").unwrap();
    fsutil::write_atomic(&p, b"two").unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"two");
    let leftovers: Vec<_> = fs::read_dir(tmp.path()).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(leftovers.len(), 1, "一時ファイルが残らない: {leftovers:?}");
}

#[test]
fn crash_before_rename_keeps_old_content_and_vault_opens() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let id;
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "old-pass");
        v.save_item(&mut x).unwrap();
        id = x.id.clone();
    }
    // 書き込み中のクラッシュを再現: 一時ファイルまで書いて rename 前に中断
    let path = dir.join("items").join(format!("{id}.tki"));
    let before = fs::read(&path).unwrap();
    let res = fsutil::write_atomic_hooked(&path, b"half-written garbage", &mut || Err(std::io::Error::other("crash")));
    assert!(res.is_err());
    assert_eq!(fs::read(&path).unwrap(), before, "本体は無傷");
    let tmp_left = fs::read_dir(dir.join("items")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
    assert_eq!(tmp_left, 1, "クラッシュ後は一時ファイルが残る");
    // 起動時の検証で一時ファイルが片付き、保管庫は通常どおり開く
    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert_eq!(v.get_item(&id).unwrap().login_password(), "old-pass");
    let tmp_left = fs::read_dir(dir.join("items")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
    assert_eq!(tmp_left, 0);
}

#[test]
fn stale_index_is_rebuilt() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    {
        let mut v = new_vault(dir);
        for i in 0..5 {
            let mut x = Item::new_login(&format!("S{i}"), &format!("https://s{i}.com"), "u", "p");
            v.save_item(&mut x).unwrap();
        }
    }
    fs::remove_file(dir.join("index.tkx")).unwrap();
    assert_eq!(Vault::open(dir, "correct horse battery").unwrap().len(), 5);
    fs::write(dir.join("index.tkx"), b"garbage").unwrap();
    assert_eq!(Vault::open(dir, "correct horse battery").unwrap().len(), 5);
}

#[test]
fn change_password_keeps_items_without_reencrypting() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let id;
    let before;
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "pw");
        v.save_item(&mut x).unwrap();
        id = x.id.clone();
        before = fs::read(dir.join("items").join(format!("{id}.tki"))).unwrap();
        assert!(matches!(v.change_password("bad", "new", ITER), Err(Error::BadPassword)));
        v.change_password("correct horse battery", "brand new pw", 2000).unwrap();
    }
    assert!(Vault::open(dir, "correct horse battery").is_err());
    let mut v = Vault::open(dir, "brand new pw").unwrap();
    assert_eq!(v.iterations(), 2000);
    assert_eq!(v.get_item(&id).unwrap().login_password(), "pw");
    assert_eq!(fs::read(dir.join("items").join(format!("{id}.tki"))).unwrap(), before, "アイテムのファイルは変わらない");
}

#[test]
fn open_with_kek_works() {
    let tmp = tempfile::tempdir().unwrap();
    new_vault(tmp.path());
    let kek = Vault::derive_kek_for(tmp.path(), "correct horse battery").unwrap();
    assert!(Vault::open_with_kek(tmp.path(), &kek).is_ok());
    let wrong = crypto::random_bytes::<32>();
    assert!(matches!(Vault::open_with_kek(tmp.path(), &wrong), Err(Error::BadPassword)));
}

#[test]
fn match_and_search() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut a = Item::new_login("Amazon JP", "https://www.amazon.co.jp/ap/signin", "a@x.jp", "p");
    let mut b = Item::new_login("Amazon US", "https://www.amazon.com/ap/signin", "b@x.com", "p");
    let mut c = Item::new_login("Other", "https://example.org", "c", "p");
    b.favorite = true;
    for it in [&mut a, &mut b, &mut c] {
        v.save_item(it).unwrap();
    }
    let m = v.match_logins("https://www.amazon.co.jp/foo", &[]);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].name, "Amazon JP");
    // 同等ドメイン表を使うと両方一致し、お気に入りが先頭になる
    let equiv = vec![vec!["amazon.co.jp".to_string(), "amazon.com".to_string()]];
    let m = v.match_logins("https://www.amazon.co.jp/foo", &equiv);
    assert_eq!(m.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Amazon US", "Amazon JP"]);
    assert_eq!(v.search("a@x", &[], 10).len(), 1, "ユーザー ID でも検索できる");
    assert_eq!(v.search("", &[ItemType::Login], 2).len(), 2);
}

#[test]
fn backup_and_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let id;
    let bk;
    {
        let mut v = new_vault(dir);
        let mut x = Item::new_login("A", "https://a-site.com", "u", "pw");
        v.save_item(&mut x).unwrap();
        id = x.id.clone();
        bk = v.backup_now().unwrap();
        assert!(bk.extension().unwrap() == "tkb");
        v.purge_item(&id).unwrap();
        assert_eq!(v.len(), 0);
    }
    vault::restore_backup(dir, &bk).unwrap();
    let mut v = Vault::open(dir, "correct horse battery").unwrap();
    assert_eq!(v.get_item(&id).unwrap().login_password(), "pw");
    // 世代管理（整理で最初のバックアップが消えることがあるので、中身は先に読んでおく）
    let zip_bytes = fs::read(&bk).unwrap();
    for _ in 0..12 {
        vault::make_backup(dir).unwrap();
    }
    assert!(vault::prune_backups(dir, 10) > 0);
    assert_eq!(vault::list_backups(dir).len(), 10);
    // バックアップに平文が含まれない
    assert!(!String::from_utf8_lossy(&zip_bytes).contains("pw"));
}

#[test]
fn backup_file_name_rule() {
    for ok in ["20260101-120000.tkb", "20260101-120000-1.tkb", "20260101-120000-12.tkb"] {
        assert!(vault::is_backup_name(ok), "{ok}");
    }
    for bad in ["20260101-120000.tkb.bak", "notes.tkb", "20260101-120000-.tkb", "20260101-12000.tkb", "2026010a-120000.tkb", "20260101_120000.tkb", "20260101-120000-x.tkb", "20260101-120000.TXT", ".tkb", "x20260101-120000.tkb"] {
        assert!(!vault::is_backup_name(bad), "{bad}");
    }
}

#[test]
fn backup_to_custom_dir_and_prune_only_own_files() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("vault");
    let target = tmp.path().join("shared");
    fs::create_dir_all(&target).unwrap();
    let mut v = new_vault(&dir);
    let mut x = Item::new_login("A", "https://a-site.com", "u", "pw");
    v.save_item(&mut x).unwrap();
    // 保存先を切り替えると、新しい保存先に作られ、既定の保存先には作られない
    let b1 = v.backup_now_in(&target).unwrap();
    assert!(b1.starts_with(&target) && b1.is_file());
    assert!(vault::list_backups(&dir).is_empty(), "既定の保存先には作られない");
    assert_eq!(vault::list_backups_in(&target).len(), 1);
    // 無関係なファイル・サブフォルダ・名前の近いファイルを置いておく
    fs::write(target.join("report.txt"), "keep").unwrap();
    fs::write(target.join("old-20200101-000000.tkb"), "keep").unwrap();
    fs::write(target.join("20200101-000000.tkb.bak"), "keep").unwrap();
    fs::create_dir_all(target.join("sub")).unwrap();
    fs::write(target.join("sub").join("20190101-000000.tkb"), "keep").unwrap();
    fs::create_dir_all(target.join("20180101-000000.tkb")).unwrap(); // ファイルでなくフォルダ
    for n in 0..5 {
        fs::write(target.join(format!("2021010{n}-000000.tkb")), b"old").unwrap();
    }
    let removed = vault::prune_backups_in(&target, 2);
    assert_eq!(removed, 4, "規則に合う 6 件のうち 4 件を整理");
    assert_eq!(vault::list_backups_in(&target).len(), 2);
    for keep in ["report.txt", "old-20200101-000000.tkb", "20200101-000000.tkb.bak"] {
        assert!(target.join(keep).is_file(), "{keep} は残る");
    }
    assert!(target.join("sub").join("20190101-000000.tkb").is_file(), "サブフォルダの中は触らない");
    assert!(target.join("20180101-000000.tkb").is_dir());
    // 保存先がなくなったら、黙って作り直さずエラーにする
    let gone = tmp.path().join("unplugged");
    assert!(v.backup_now_in(&gone).is_err());
    assert!(!gone.exists(), "存在しない保存先を作らない");
}

#[test]
fn backup_dir_validation() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("vault");
    let _v = new_vault(&dir);
    let ok = tmp.path().join("ok");
    fs::create_dir_all(&ok).unwrap();
    assert!(vault::validate_backup_dir(&dir, &ok).is_ok());
    assert_eq!(fs::read_dir(&ok).unwrap().count(), 0, "試し書きの一時ファイルは消える");
    // 保管庫のフォルダの中は不可（既定の backups も、サブフォルダも）
    assert!(vault::validate_backup_dir(&dir, &dir).is_err());
    assert!(vault::validate_backup_dir(&dir, &dir.join("items")).is_err());
    fs::create_dir_all(dir.join("backups")).unwrap();
    assert!(vault::validate_backup_dir(&dir, &dir.join("backups")).is_err());
    // 存在しない・ファイル・相対パス・空
    assert!(vault::validate_backup_dir(&dir, &tmp.path().join("nope")).is_err());
    let f = tmp.path().join("file.txt");
    fs::write(&f, "x").unwrap();
    assert!(vault::validate_backup_dir(&dir, &f).is_err());
    assert!(vault::validate_backup_dir(&dir, std::path::Path::new("relative/dir")).is_err());
    assert!(vault::validate_backup_dir(&dir, std::path::Path::new("")).is_err());
    // 書き込めない（読み取り専用）
    let ro = tmp.path().join("ro");
    fs::create_dir_all(&ro).unwrap();
    let mut perm = fs::metadata(&ro).unwrap().permissions();
    perm.set_readonly(true);
    fs::set_permissions(&ro, perm).unwrap();
    // Windows では、フォルダの読み取り専用属性は書き込みを止めないことがある。書き込めないなら、検証がエラーにすること
    let writable = fs::write(ro.join("probe"), b"x").is_ok();
    let _ = fs::remove_file(ro.join("probe"));
    assert_eq!(vault::validate_backup_dir(&dir, &ro).is_ok(), writable);
}

#[test]
fn restore_rejects_path_traversal() {
    let tmp = tempfile::tempdir().unwrap();
    let evil = tmp.path().join("evil.tkb");
    {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(fs::File::create(&evil).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        zw.start_file("../escape.txt", o).unwrap();
        zw.write_all(b"x").unwrap();
        zw.finish().unwrap();
    }
    let dir = tmp.path().join("vault");
    assert!(vault::restore_backup(&dir, &evil).is_err());
    assert!(!tmp.path().join("escape.txt").exists());
}

#[test]
fn generated_history_is_encrypted_and_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    for i in 0..25 {
        v.push_generated(&format!("PW-VISIBLE-{i}")).unwrap();
    }
    let h = v.generated_history();
    assert_eq!(h.len(), 20);
    assert_eq!(h[0].0, "PW-VISIBLE-24");
    let raw = fs::read(tmp.path().join("password-history.tkx")).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("PW-VISIBLE"));
    v.clear_generated_history().unwrap();
    assert!(v.generated_history().is_empty());
}

#[test]
fn import_skips_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut x = Item::new_login("Exist", "https://example.com/login", "taro", "p");
    v.save_item(&mut x).unwrap();
    let items = vec![
        Item::new_login("Dup", "https://www.example.com/login", "taro", "q"),
        Item::new_login("New", "https://example.com/login", "hanako", "q"),
    ];
    let r = v.import_items(items, true).unwrap();
    assert_eq!(r.added, 1);
    assert_eq!(r.duplicates, vec!["Dup".to_string()]);
}

#[test]
fn folders_include_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut x = Item::new_login("A", "https://a-site.com", "u", "p");
    x.folder = "/仕事/EC".into();
    v.save_item(&mut x).unwrap();
    assert_eq!(v.folders(), vec!["/仕事".to_string(), "/仕事/EC".to_string()]);
}

#[test]
fn trash_retention() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut x = Item::new_login("A", "https://a-site.com", "u", "p");
    v.save_item(&mut x).unwrap();
    v.delete_item(&x.id).unwrap();
    assert!(v.expired_trash().is_empty());
    let mut it = v.get_item(&x.id).unwrap();
    it.deleted_at = Some("2020-01-01T00:00:00Z".into());
    v.save_item(&mut it).unwrap();
    assert_eq!(v.expired_trash(), vec![x.id]);
}

#[test]
fn validation_rejects_bad_items() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut x = Item::new_login("", "https://a-site.com", "u", "p");
    assert!(v.save_item(&mut x).is_err());
    let mut y = Item::new_login("ok", "https://a-site.com", "u", "p");
    y.id = "../evil".into();
    assert!(v.save_item(&mut y).is_err());
}

#[test]
fn many_items_batch_and_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    {
        let mut v = new_vault(dir);
        let items: Vec<Item> = (0..300).map(|i| Item::new_login(&format!("Site{i}"), &format!("https://site{i}.com"), "u", "p")).collect();
        let r = v.import_items(items, false).unwrap();
        assert_eq!(r.added, 300);
    }
    let v = Vault::open(dir, "correct horse battery").unwrap();
    assert_eq!(v.len(), 300);
    assert_eq!(v.match_logins("https://site42.com/x", &[]).len(), 1);
}

/// §19 の性能確認（1 万件、既定の反復回数）。`cargo test --release -- --ignored perf` で実行する。
#[test]
#[ignore]
fn perf_10k_items() {
    use std::time::Instant;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    {
        let mut v = Vault::create(dir, "perf-password", crypto::DEFAULT_ITERATIONS).unwrap();
        let items: Vec<Item> = (0..10_000)
            .map(|i| Item::new_login(&format!("Site {i}"), &format!("https://site{i}.example{}.com/login", i % 97), "user", "pass"))
            .collect();
        v.import_items(items, false).unwrap();
    }
    let t = Instant::now();
    let v = Vault::open(dir, "perf-password").unwrap();
    let unlock = t.elapsed();
    let t = Instant::now();
    let m = v.match_logins("https://site1234.example43.com/login", &[]);
    let matched = t.elapsed();
    println!("unlock={unlock:?} match={matched:?} hits={}", m.len());
    assert!(unlock.as_millis() < 1500, "ロック解除 1.5 秒以内: {unlock:?}");
    assert!(matched.as_millis() < 50, "match 50ms 以内: {matched:?}");
}

#[test]
fn hello_wrap_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    new_vault(tmp.path());
    let kek = Vault::derive_kek_for(tmp.path(), "correct horse battery").unwrap();
    let sig = b"pretend-rsa-signature-bytes-0123456789";
    let wrapped = crypto::hello_wrap_kek(&kek, sig);
    let back = crypto::hello_unwrap_kek(&wrapped, sig).unwrap();
    assert_eq!(*back, *kek);
    assert!(Vault::open_with_kek(tmp.path(), &back).is_ok(), "復元した KEK で保管庫を開ける");
    assert!(crypto::hello_unwrap_kek(&wrapped, b"another signature").is_err(), "署名が違えば開けない");
    let mut bad = wrapped.clone();
    let n = bad.len() - 1;
    bad[n] ^= 1;
    assert!(crypto::hello_unwrap_kek(&bad, sig).is_err(), "改変は検知される");
}

#[test]
fn move_folder_moves_everything_underneath() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let mut f = Item::new(ItemType::Folder, "EC");
    f.folder = "/仕事".into();
    v.save_item(&mut f).unwrap();
    let mut a = Item::new_login("Shop", "https://shop-a.com", "u", "p");
    a.folder = "/仕事/EC".into();
    let mut b = Item::new_login("Deep", "https://deep-b.com", "u", "p");
    b.folder = "/仕事/EC/海外".into();
    let mut c = Item::new_login("Other", "https://other-c.com", "u", "p");
    c.folder = "/仕事".into();
    let mut gone = Item::new_login("Trashed", "https://gone-d.com", "u", "p");
    gone.folder = "/仕事/EC".into();
    for it in [&mut a, &mut b, &mut c, &mut gone] {
        v.save_item(it).unwrap();
    }
    v.delete_item(&gone.id).unwrap();
    let rev_before = v.get_item(&a.id).unwrap().rev;

    let new = v.move_folder("/仕事/EC", "/個人").unwrap();
    assert_eq!(new, "/個人/EC");
    assert_eq!(v.get_item(&a.id).unwrap().folder, "/個人/EC");
    assert_eq!(v.get_item(&b.id).unwrap().folder, "/個人/EC/海外");
    assert_eq!(v.get_item(&c.id).unwrap().folder, "/仕事", "対象外は動かない");
    assert_eq!(v.get_item(&gone.id).unwrap().folder, "/個人/EC", "ごみ箱のアイテムも付け替える");
    assert!(v.get_item(&a.id).unwrap().rev > rev_before, "rev が上がる");
    let fi = v.entries().find(|e| e.kind == ItemType::Folder).unwrap();
    assert_eq!((fi.folder.as_str(), fi.name.as_str()), ("/個人", "EC"), "フォルダ項目も移る");
    assert_eq!(v.folders(), vec!["/仕事".to_string(), "/個人".to_string(), "/個人/EC".to_string(), "/個人/EC/海外".to_string()]);
    // 移動後も検索・照合できる（再オープンしても同じ）
    assert_eq!(v.search("shop", &[], 10).len(), 1);
    assert_eq!(v.match_logins("https://shop-a.com/", &[]).len(), 1);
    drop(v);
    let mut v = Vault::open(tmp.path(), "correct horse battery").unwrap();
    assert_eq!(v.get_item(&b.id).unwrap().folder, "/個人/EC/海外");
    // ルートへ戻す
    assert_eq!(v.move_folder("/個人/EC", "/").unwrap(), "/EC");
    assert_eq!(v.get_item(&a.id).unwrap().folder, "/EC");
}

#[test]
fn move_folder_rejections() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    for (name, folder) in [("a", "/A"), ("b", "/A/B"), ("c", "/C"), ("d", "/C/A")] {
        let mut it = Item::new_login(name, &format!("https://{name}-x.com"), "u", "p");
        it.folder = folder.into();
        v.save_item(&mut it).unwrap();
    }
    assert!(v.move_folder("/", "/C").is_err(), "ルートは移動できない");
    assert!(v.move_folder("/A", "/A").is_err(), "自分自身へは不可");
    assert!(v.move_folder("/A", "/A/B").is_err(), "子孫へは不可");
    let e = v.move_folder("/A", "/C").unwrap_err();
    assert!(e.to_string().contains("同じ名前"), "同名の衝突: {e}");
    assert_eq!(v.move_folder("/A/B", "/A").unwrap(), "/A/B", "同じ場所へは何もしない");
    assert!(v.move_folder("A", "/C").is_err());
}

// ---------------------------------------------------------------- 「よく使う」の並び（使用の点数）

fn ts(now: chrono::DateTime<chrono::Utc>, days_ago: i64) -> chrono::DateTime<chrono::Utc> {
    now - chrono::Duration::days(days_ago)
}

#[test]
fn popularity_recent_use_beats_old_heavy_use() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let now = chrono::Utc::now();
    let mut old = Item::new_login("昔よく使った", "https://old.example.com", "u", "p");
    let mut recent = Item::new_login("最近使っている", "https://recent.example.com", "u", "p");
    v.save_item(&mut old).unwrap();
    v.save_item(&mut recent).unwrap();
    // 120 日前に、1 日おきに 30 回（累計は多い）。最近は、昨日までの 3 回だけ
    for i in 0..30 {
        v.touch_at(&old.id, ts(now, 120) + chrono::Duration::days(i * 2)).unwrap();
    }
    for d in [3, 2, 1] {
        v.touch_at(&recent.id, ts(now, d)).unwrap();
    }
    assert!(v.get_item(&old.id).unwrap().use_count > v.get_item(&recent.id).unwrap().use_count, "累計は昔のほうが多い");
    let hits = v.search("", &[ItemType::Login], 10);
    assert_eq!(hits[0].name, "最近使っている", "最近の使用が上に来る");
    assert_eq!(hits[1].name, "昔よく使った");
    // URL 照合の並びも同じ
    assert_eq!(v.match_logins("https://recent.example.com/", &[])[0].name, "最近使っている");
}

#[test]
fn popularity_decays_by_half_life() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let now = chrono::Utc::now();
    let mut it = Item::new_login("A", "https://a.example.com", "u", "p");
    v.save_item(&mut it).unwrap();
    v.touch_at(&it.id, ts(now, 14)).unwrap();
    let e = v.entries().find(|e| e.id == it.id).unwrap();
    let s = e.popularity(now);
    assert!((s - 0.5).abs() < 0.01, "半減期（14 日）で半分になる: {s}");
    assert!((e.popularity(ts(now, 14)) - 1.0).abs() < 0.001, "使った時点では 1");
}

#[test]
fn popularity_favorite_stays_on_top() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let now = chrono::Utc::now();
    let mut fav = Item::new_login("お気に入り", "https://fav.example.com", "u", "p");
    fav.favorite = true;
    let mut hot = Item::new_login("よく使う", "https://hot.example.com", "u", "p");
    v.save_item(&mut fav).unwrap();
    v.save_item(&mut hot).unwrap();
    for d in [5, 4, 3, 2, 1] {
        v.touch_at(&hot.id, ts(now, d)).unwrap();
    }
    let hits = v.search("", &[ItemType::Login], 10);
    assert_eq!(hits[0].name, "お気に入り", "お気に入りは、使用の点数が低くても先頭");
    assert_eq!(hits[1].name, "よく使う");
}

#[test]
fn touch_within_60_seconds_counts_once() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let now = chrono::Utc::now();
    let mut it = Item::new_login("A", "https://a.example.com", "u", "p");
    v.save_item(&mut it).unwrap();
    v.touch_at(&it.id, now).unwrap();
    v.touch_at(&it.id, now + chrono::Duration::seconds(10)).unwrap(); // アプリからのログイン + 拡張の記入、のような連続
    v.touch_at(&it.id, now + chrono::Duration::seconds(59)).unwrap();
    let a = v.get_item(&it.id).unwrap();
    assert_eq!(a.use_count, 1, "60 秒以内の連続は 1 回");
    assert!((a.use_score - 1.0).abs() < 1e-9);
    v.touch_at(&it.id, now + chrono::Duration::seconds(61)).unwrap();
    let b = v.get_item(&it.id).unwrap();
    assert_eq!(b.use_count, 2, "60 秒を過ぎたら別の 1 回");
    assert!(b.use_score > 1.9 && b.use_score <= 2.0, "{}", b.use_score);
}

#[test]
fn item_without_score_uses_use_count() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = new_vault(tmp.path());
    let now = chrono::Utc::now();
    // 点数の欄がない JSON を読める（serde の default）
    let json = serde_json::to_value(Item::new_login("点数なし", "https://legacy.example.com", "u", "p")).unwrap();
    let mut obj = json.as_object().unwrap().clone();
    obj.remove("useScore");
    obj.remove("scoreAt");
    obj.insert("useCount".into(), serde_json::json!(4));
    obj.insert("lastUsed".into(), serde_json::json!(ts(now, 1).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)));
    let mut legacy: Item = serde_json::from_value(serde_json::Value::Object(obj)).unwrap();
    assert_eq!(legacy.use_score, 0.0);
    assert!(legacy.score_at.is_none());
    v.save_item(&mut legacy).unwrap();
    let mut other = Item::new_login("新しい形式", "https://new.example.com", "u", "p");
    v.save_item(&mut other).unwrap();
    v.touch_at(&other.id, ts(now, 1)).unwrap();
    // 使用回数 4 回（昨日）とみなされ、1 回（昨日）より上に来る
    let hits = v.search("", &[ItemType::Login], 10);
    assert_eq!(hits[0].name, "点数なし");
    // 使うと、使用回数を土台にして点数が付く
    v.touch_at(&legacy.id, now).unwrap();
    let after = v.get_item(&legacy.id).unwrap();
    assert_eq!(after.use_count, 5);
    assert!(after.use_score > 4.0, "{}", after.use_score);
}
