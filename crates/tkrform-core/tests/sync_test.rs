//! 同期クライアントの単体テスト。サーバは仕様（§15）どおりに振る舞う偽物を使う。

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde_json::{json, Value};
use tkrform_core::error::{Error, Result};
use tkrform_core::model::Item;
use tkrform_core::sync::{self, SyncState, Transport};
use tkrform_core::vault::Vault;

const ITER: u32 = 1000;

#[derive(Default)]
struct Srv {
    users: BTreeMap<String, User>,
    tokens: BTreeMap<String, String>,
}
#[derive(Default, Clone)]
struct User {
    auth: String,
    salt: String,
    iter: u64,
    wrapped: String,
    head: u64,
    items: BTreeMap<String, (u64, String, bool)>,
}
struct Fake(RefCell<Srv>);

fn err(m: &str) -> Error {
    Error::Invalid(m.into())
}

impl Transport for Fake {
    fn post(&self, action: &str, b: &Value) -> Result<Value> {
        let mut s = self.0.borrow_mut();
        let g = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match action {
            "prelogin" => {
                let e = g("email");
                Ok(match s.users.get(&e) {
                    Some(u) => json!({"success": true, "salt": u.salt, "iter": u.iter}),
                    None => json!({"success": true, "salt": "AAAAAAAAAAAAAAAAAAAAAA==", "iter": 600000}),
                })
            }
            "register" => {
                let e = g("email");
                if s.users.contains_key(&e) {
                    return Err(err("既に登録されています"));
                }
                s.users.insert(e.clone(), User { auth: g("authHash"), salt: g("salt"), iter: b["iter"].as_u64().unwrap(), wrapped: g("wrappedVaultKey"), ..Default::default() });
                let t = format!("tok-{e}-{}", s.tokens.len());
                s.tokens.insert(t.clone(), e);
                Ok(json!({"success": true, "token": t}))
            }
            "login" => {
                let e = g("email");
                let u = s.users.get(&e).cloned().ok_or_else(|| err("メールアドレスまたはパスワードが違います"))?;
                if u.auth != g("authHash") {
                    return Err(err("メールアドレスまたはパスワードが違います"));
                }
                let t = format!("tok-{e}-{}", s.tokens.len());
                s.tokens.insert(t.clone(), e);
                Ok(json!({"success": true, "token": t, "wrappedVaultKey": u.wrapped, "salt": u.salt, "iter": u.iter}))
            }
            "pull" => {
                let e = s.tokens.get(&g("token")).cloned().ok_or_else(|| err("認証が必要です"))?;
                let since = b["sinceRev"].as_u64().unwrap();
                let u = &s.users[&e];
                let mut v: Vec<_> = u.items.iter().filter(|(_, x)| x.0 > since).collect();
                v.sort_by_key(|(_, x)| x.0);
                let items: Vec<Value> = v.iter().map(|(id, x)| json!({"id": id, "rev": x.0, "blob": x.1, "deleted": x.2})).collect();
                Ok(json!({"success": true, "items": items, "headRev": u.head}))
            }
            "push" => {
                let e = s.tokens.get(&g("token")).cloned().ok_or_else(|| err("認証が必要です"))?;
                let base = b["baseRev"].as_u64().unwrap();
                let u = s.users.get_mut(&e).unwrap();
                let mut conflicts = vec![];
                for it in b["items"].as_array().unwrap() {
                    let id = it["id"].as_str().unwrap().to_string();
                    if u.items.get(&id).map(|x| x.0 > base).unwrap_or(false) {
                        conflicts.push(id);
                        continue;
                    }
                    u.head += 1;
                    u.items.insert(id, (u.head, it["blob"].as_str().unwrap().to_string(), it["deleted"].as_bool().unwrap_or(false)));
                }
                Ok(json!({"success": true, "headRev": u.head, "conflicts": conflicts}))
            }
            "changeAuth" => {
                let e = s.tokens.get(&g("token")).cloned().ok_or_else(|| err("認証が必要です"))?;
                let u = s.users.get_mut(&e).unwrap();
                u.auth = g("newAuthHash");
                u.salt = g("newSalt");
                u.iter = b["newIter"].as_u64().unwrap();
                u.wrapped = g("newWrappedVaultKey");
                Ok(json!({"success": true}))
            }
            _ => Err(err("不明")),
        }
    }
}

struct Dev {
    dir: tempfile::TempDir,
    v: Vault,
    st: SyncState,
    tok: String,
}

fn device_a(srv: &Fake, mp: &str) -> Dev {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::create(dir.path(), mp, ITER).unwrap();
    let tok = sync::register(srv, &v, "a@example.jp", mp).unwrap();
    Dev { dir, v, st: SyncState::default(), tok }
}

fn device_b(srv: &Fake, mp: &str) -> Dev {
    let dir = tempfile::tempdir().unwrap();
    let (v, tok) = sync::join_new_device(srv, dir.path(), "a@example.jp", mp).unwrap();
    Dev { dir, v, st: SyncState::default(), tok }
}

fn sync_dev(srv: &Fake, d: &mut Dev) -> sync::SyncReport {
    sync::sync_once(srv, &mut d.v, &mut d.st, &d.tok).unwrap()
}

#[test]
fn two_devices_share_items_and_vault_key() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mp = "shared mp 123";
    let mut a = device_a(&srv, mp);
    let mut it = Item::new_login("GitHub", "https://github.com", "octocat", "pw-1");
    a.v.save_item(&mut it).unwrap();
    let r = sync_dev(&srv, &mut a);
    assert_eq!(r.pushed, 1);

    let mut b = device_b(&srv, mp); // MP だけで参加できる（VaultKey は同じ）
    let r = sync_dev(&srv, &mut b);
    assert_eq!(r.pulled, 1);
    assert_eq!(b.v.get_item(&it.id).unwrap().login_password(), "pw-1");
    let _ = (&a.dir, &b.dir);

    // B で更新 → A へ
    let mut x = b.v.get_item(&it.id).unwrap();
    x.fields[1].value = "pw-2".into();
    b.v.save_item(&mut x).unwrap();
    sync_dev(&srv, &mut b);
    let r = sync_dev(&srv, &mut a);
    assert_eq!(r.pulled, 1);
    assert_eq!(a.v.get_item(&it.id).unwrap().login_password(), "pw-2");
    // 何も変わらなければ何も送らない
    let r = sync_dev(&srv, &mut a);
    assert_eq!((r.pulled, r.pushed), (0, 0));
}

#[test]
fn wrong_password_cannot_join() {
    let srv = Fake(RefCell::new(Srv::default()));
    let _a = device_a(&srv, "right password");
    let dir = tempfile::tempdir().unwrap();
    assert!(sync::join_new_device(&srv, dir.path(), "a@example.jp", "wrong").is_err());
}

#[test]
fn conflict_keeps_both() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mut a = device_a(&srv, "mp");
    let mut it = Item::new_login("Site", "https://site.example", "u", "orig");
    a.v.save_item(&mut it).unwrap();
    sync_dev(&srv, &mut a);
    let mut b = device_b(&srv, "mp");
    sync_dev(&srv, &mut b);

    // 両方が同じアイテムを変更する
    let mut xa = a.v.get_item(&it.id).unwrap();
    xa.fields[1].value = "from-A".into();
    a.v.save_item(&mut xa).unwrap();
    let mut xb = b.v.get_item(&it.id).unwrap();
    xb.fields[1].value = "from-B".into();
    b.v.save_item(&mut xb).unwrap();
    sync_dev(&srv, &mut a); // A が先にサーバへ
    let r = sync_dev(&srv, &mut b);
    assert_eq!(r.conflicts_kept, 1, "{r:?}");
    // B: 自分の変更は元の名前で残り、A の版が「名前 (競合 日付)」で残る
    assert_eq!(b.v.get_item(&it.id).unwrap().login_password(), "from-B");
    let kept: Vec<_> = b.v.entries().filter(|e| e.name.starts_with("Site (競合 ")).collect();
    assert_eq!(kept.len(), 1);
    let kid = kept[0].id.clone();
    assert_eq!(b.v.get_item(&kid).unwrap().login_password(), "from-A");
    // 収束: B の版もサーバへ行き、A にも競合コピーが届く
    sync_dev(&srv, &mut b);
    sync_dev(&srv, &mut a);
    assert_eq!(a.v.entries().filter(|e| e.name.starts_with("Site")).count(), 2);
}

#[test]
fn purge_is_synced_as_tombstone() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mut a = device_a(&srv, "mp");
    let mut it = Item::new_login("Gone", "https://gone.example", "u", "p");
    a.v.save_item(&mut it).unwrap();
    sync_dev(&srv, &mut a);
    let mut b = device_b(&srv, "mp");
    sync_dev(&srv, &mut b);
    assert!(b.v.entry(&it.id).is_some());
    a.v.purge_item(&it.id).unwrap();
    sync_dev(&srv, &mut a);
    let r = sync_dev(&srv, &mut b);
    assert_eq!(r.purged, 1);
    assert!(b.v.entry(&it.id).is_none());
}

#[test]
fn trash_is_just_a_revision() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mut a = device_a(&srv, "mp");
    let mut it = Item::new_login("T", "https://t.example", "u", "p");
    a.v.save_item(&mut it).unwrap();
    sync_dev(&srv, &mut a);
    let mut b = device_b(&srv, "mp");
    sync_dev(&srv, &mut b);
    a.v.delete_item(&it.id).unwrap();
    sync_dev(&srv, &mut a);
    sync_dev(&srv, &mut b);
    assert!(b.v.entry(&it.id).unwrap().deleted);
}

#[test]
fn tampered_or_foreign_blob_is_rejected() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mut a = device_a(&srv, "mp");
    let mut it = Item::new_login("S", "https://s.example", "u", "p");
    a.v.save_item(&mut it).unwrap();
    sync_dev(&srv, &mut a);
    // サーバ上の blob を 1 バイト改変
    {
        let mut s = srv.0.borrow_mut();
        let u = s.users.get_mut("a@example.jp").unwrap();
        let e = u.items.get_mut(&it.id).unwrap();
        let mut bytes = base64_decode(&e.1);
        let n = bytes.len() - 2;
        bytes[n] ^= 1;
        e.1 = base64_encode(&bytes);
        u.head += 1;
        e.0 = u.head;
    }
    let mut b = device_b(&srv, "mp");
    let r = sync_dev(&srv, &mut b);
    assert_eq!((r.pulled, r.rejected), (0, 1));
    assert!(b.v.entry(&it.id).is_none());
}

#[test]
fn master_password_change_propagates() {
    let srv = Fake(RefCell::new(Srv::default()));
    let mut a = device_a(&srv, "old mp");
    let mut b = device_b(&srv, "old mp");
    a.v.change_password("old mp", "new mp", 2000).unwrap();
    sync::change_auth(&srv, &a.v, &a.tok, "new mp").unwrap();
    // 古い MP ではもう入れない
    assert!(sync::login_existing(&srv, &mut b.v, "a@example.jp", "old mp").is_err());
    // B は新しい MP でログインすると、ローカルのヘッダも新しいパラメータへ揃う
    b.tok = sync::login_existing(&srv, &mut b.v, "a@example.jp", "new mp").unwrap();
    assert_eq!(b.v.iterations(), 2000);
    drop(b.v);
    assert!(Vault::open(b.dir.path(), "new mp").is_ok());
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}
