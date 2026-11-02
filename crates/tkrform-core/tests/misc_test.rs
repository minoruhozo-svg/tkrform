use tkrform_core::generator::{self, GenMode, GenOptions};
use tkrform_core::model::{Item, ItemType, MatchLevel};
use tkrform_core::portio;
use tkrform_core::prefs::Preferences;
use tkrform_core::throttle::Throttle;
use tkrform_core::totp;
use tkrform_core::urlmatch::{self, url_matches};

// ---------------------------------------------------------------- URL 照合

#[test]
fn registrable_domain_uses_psl() {
    assert_eq!(urlmatch::registrable_domain("www.example.com"), "example.com");
    assert_eq!(urlmatch::registrable_domain("a.b.example.co.jp"), "example.co.jp");
    assert_eq!(urlmatch::registrable_domain("foo.github.io"), "foo.github.io", "private suffix は別サイト扱い");
    assert_eq!(urlmatch::registrable_domain("www.ck"), "www.ck", "例外規則 !www.ck");
    assert_eq!(urlmatch::registrable_domain("a.b.kobe.jp"), "a.b.kobe.jp", "ワイルドカード規則 *.kobe.jp");
    assert_eq!(urlmatch::registrable_domain("localhost"), "localhost");
    assert_eq!(urlmatch::registrable_domain("192.168.0.1"), "192.168.0.1");
    assert_eq!(urlmatch::registrable_domain("example.unknowntld"), "example.unknowntld");
}

#[test]
fn match_levels() {
    let eq: Vec<Vec<String>> = vec![];
    let saved = "https://example.com/app/login";
    assert!(url_matches("https://www.example.com/x", saved, MatchLevel::Domain, &eq));
    assert!(url_matches("https://sub.example.com/x", saved, MatchLevel::Domain, &eq));
    assert!(!url_matches("https://sub.example.com/x", saved, MatchLevel::Host, &eq));
    assert!(url_matches("https://www.example.com/", saved, MatchLevel::Host, &eq));
    assert!(url_matches("https://example.com/app/login/step2", saved, MatchLevel::Prefix, &eq));
    assert!(!url_matches("https://example.com/application", saved, MatchLevel::Prefix, &eq));
    assert!(url_matches("https://example.com/app/login/", saved, MatchLevel::Exact, &eq));
    assert!(!url_matches("https://example.com/app/login/x", saved, MatchLevel::Exact, &eq));
    assert!(!url_matches("https://evil-example.com/", saved, MatchLevel::Domain, &eq));
    assert!(!url_matches("https://example.com.evil.com/", saved, MatchLevel::Domain, &eq));
    // https で保存したものを http のページへは出さない
    assert!(!url_matches("http://example.com/", saved, MatchLevel::Domain, &eq));
    assert!(url_matches("http://localhost:8080/", "https://localhost/", MatchLevel::Domain, &eq));
    assert!(!url_matches("ftp://example.com/", saved, MatchLevel::Domain, &eq));
    assert!(!url_matches("not a url", saved, MatchLevel::Domain, &eq));
}

#[test]
fn equivalent_domains() {
    let eq = vec![vec!["amazon.co.jp".to_string(), "amazon.com".to_string()]];
    assert!(url_matches("https://www.amazon.com/", "https://www.amazon.co.jp/", MatchLevel::Domain, &eq));
    assert!(!url_matches("https://www.amazon.com/", "https://www.amazon.co.jp/", MatchLevel::Domain, &[]));
}

// ---------------------------------------------------------------- 生成器

#[test]
fn random_password_respects_options() {
    let o = GenOptions::default();
    for _ in 0..200 {
        let g = generator::generate(&o).unwrap();
        let p = &g.password;
        assert_eq!(p.chars().count(), 16);
        assert!(p.chars().any(|c| c.is_ascii_uppercase()));
        assert!(p.chars().any(|c| c.is_ascii_lowercase()));
        assert!(p.chars().any(|c| c.is_ascii_digit()));
        assert!(p.chars().any(|c| "!@#$%^&*".contains(c)));
    }
    let g = generator::generate(&o).unwrap();
    let pool = 26 + 26 + 10 + 8;
    assert!((g.bits - 16.0 * (pool as f64).log2()).abs() < 1e-9);
}

#[test]
fn hex_and_similar_exclusion() {
    let o = GenOptions { hex_only: true, length: 64, ..GenOptions::default() };
    let p = generator::generate(&o).unwrap().password;
    assert!(p.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
    let o = GenOptions { exclude_similar: true, length: 512, ..GenOptions::default() };
    let p = generator::generate(&o).unwrap().password;
    assert!(!p.chars().any(|c| "Il1O0o".contains(c)));
}

#[test]
fn generator_validation() {
    assert!(generator::generate(&GenOptions { length: 3, ..GenOptions::default() }).is_err());
    assert!(generator::generate(&GenOptions { length: 513, ..GenOptions::default() }).is_err());
    let none = GenOptions { upper: false, lower: false, digits: false, symbols: false, ..GenOptions::default() };
    assert!(generator::generate(&none).is_err());
    assert!(generator::generate(&GenOptions { mode: GenMode::Passphrase, words: 2, ..GenOptions::default() }).is_err());
}

#[test]
fn passphrase() {
    let o = GenOptions { mode: GenMode::Passphrase, ..GenOptions::default() };
    let g = generator::generate(&o).unwrap();
    let parts: Vec<&str> = g.password.split('-').collect();
    assert_eq!(parts.len(), 5, "4 単語 + 数字: {}", g.password);
    assert!(parts[0].chars().next().unwrap().is_uppercase());
    assert!(parts[4].chars().all(|c| c.is_ascii_digit()));
    let expected = 4.0 * 7776f64.log2() + 100f64.log2();
    assert!((g.bits - expected).abs() < 1e-9);
}

#[test]
fn generator_is_not_constant() {
    let o = GenOptions::default();
    let a = generator::generate(&o).unwrap().password;
    let b = generator::generate(&o).unwrap().password;
    assert_ne!(a, b);
}

#[test]
fn strength_estimate() {
    assert!(generator::estimate_bits("password") < 50.0);
    assert!(generator::estimate_bits("aaaaaaaaaaaa") < 50.0);
    assert!(generator::estimate_bits("Xk9#mQ2$vLp7!wRz") > 80.0);
    assert_eq!(generator::strength_class(49.9), "weak");
    assert_eq!(generator::strength_class(50.0), "fair");
    assert_eq!(generator::strength_class(80.0), "strong");
}

// ---------------------------------------------------------------- TOTP（RFC 6238 付録 B のテストベクタ）

#[test]
fn totp_rfc6238_vectors() {
    let sha1 = totp::TotpParams { secret: b"12345678901234567890".to_vec(), algo: totp::Algo::Sha1, digits: 8, period: 30 };
    assert_eq!(totp::code_at(&sha1, 59), "94287082");
    assert_eq!(totp::code_at(&sha1, 1111111109), "07081804");
    assert_eq!(totp::code_at(&sha1, 20000000000), "65353130");
    let sha256 = totp::TotpParams { secret: b"12345678901234567890123456789012".to_vec(), algo: totp::Algo::Sha256, digits: 8, period: 30 };
    assert_eq!(totp::code_at(&sha256, 59), "46119246");
    let sha512 = totp::TotpParams {
        secret: b"1234567890123456789012345678901234567890123456789012345678901234".to_vec(),
        algo: totp::Algo::Sha512,
        digits: 8,
        period: 30,
    };
    assert_eq!(totp::code_at(&sha512, 59), "90693936");
}

#[test]
fn totp_parse() {
    let p = totp::parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").unwrap();
    assert_eq!(p.secret, b"12345678901234567890");
    assert_eq!(p.digits, 6);
    assert_eq!(totp::code_at(&p, 59), "287082");
    let p = totp::parse("otpauth://totp/Ex:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60").unwrap();
    assert_eq!((p.algo, p.digits, p.period), (totp::Algo::Sha256, 8, 60));
    assert!(totp::parse("!!!").is_err());
    assert!(totp::parse("otpauth://hotp/x?secret=ABCD").is_err());
    assert!(totp::parse("otpauth://totp/x").is_err());
    let (code, remain) = totp::now(&totp::parse("JBSWY3DPEHPK3PXP").unwrap());
    assert_eq!(code.len(), 6);
    assert!((1..=30).contains(&remain));
}

// ---------------------------------------------------------------- 待ち時間

#[test]
fn throttle_after_five_failures() {
    let mut t = Throttle::new();
    for i in 0..4 {
        t.failure(100 + i);
        assert!(t.check(100 + i).is_ok());
    }
    t.failure(1000);
    assert_eq!(t.check(1000), Err(30));
    assert!(t.check(1030).is_ok());
    t.failure(1030); // 6 回目 → 60 秒
    assert_eq!(t.check(1030), Err(60));
    t.failure(2000);
    assert_eq!(t.check(2000), Err(120));
    for _ in 0..20 {
        t.failure(5000);
    }
    assert_eq!(t.check(5000), Err(600), "上限は 10 分");
    t.success();
    assert!(t.check(5000).is_ok());
}

// ---------------------------------------------------------------- インポート / エクスポート

#[test]
fn chrome_csv_import() {
    let csv = "name,url,username,password,note\nGitHub,https://github.com/login,taro,pw1,メモ\n,https://example.com,hanako,pw2,\n";
    let items = portio::import_csv(csv.as_bytes(), None, "インポート 2026-10-19").unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].name, "GitHub");
    assert_eq!(items[0].login_user(), "taro");
    assert_eq!(items[0].login_password(), "pw1");
    assert_eq!(items[0].note, "メモ");
    assert_eq!(items[0].folder, "/インポート 2026-10-19");
    assert_eq!(items[1].name, "example.com", "名前がなければホスト名");
}

#[test]
fn firefox_and_roboform_detection() {
    let fx = "url,username,password,httpRealm,formActionOrigin,guid\nhttps://a.example.com,u,p,,,{x}\n";
    let t = portio::read_csv(fx.as_bytes()).unwrap();
    assert_eq!(portio::detect_format(&t.headers), portio::CsvFormat::Firefox);
    let items = portio::import_csv(fx.as_bytes(), None, "r").unwrap();
    assert_eq!(items[0].name, "a.example.com");

    let rf = "\u{feff}Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\nSite,https://s.example.com,,id1,pw,n,/仕事/EC,\n";
    let t = portio::read_csv(rf.as_bytes()).unwrap();
    assert_eq!(portio::detect_format(&t.headers), portio::CsvFormat::Roboform);
    let items = portio::import_csv(rf.as_bytes(), None, "r").unwrap();
    assert_eq!(items[0].login_user(), "id1");
    assert_eq!(items[0].login_password(), "pw");
    assert_eq!(items[0].folder, "/r/仕事/EC");
}

#[test]
fn roboform_default_value_is_treated_as_empty() {
    // 利用者が RoboForm から書き出した CSV では、未設定の値が $DefaultValue$ になっている（移行用の取り込み）
    let rf = "Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\nA8,https://www.a8.net,,$DefaultValue$,pw,$DefaultValue$,,\n";
    let items = portio::import_csv(rf.as_bytes(), None, "r").unwrap();
    assert_eq!(items[0].login_user(), "");
    assert_eq!(items[0].login_password(), "pw");
    assert_eq!(items[0].note, "");
}

#[test]
fn generic_csv_with_mapping() {
    let csv = "A,B,C\nx,https://z.example.com,secret\n";
    let m = portio::CsvMapping { name: Some(0), url: Some(1), password: Some(2), ..Default::default() };
    let items = portio::import_csv(csv.as_bytes(), Some(&m), "r").unwrap();
    assert_eq!(items[0].name, "x");
    assert_eq!(items[0].login_password(), "secret");
    assert!(portio::import_csv(csv.as_bytes(), Some(&portio::CsvMapping::default()), "r").is_err());
}

#[test]
fn csv_export_has_bom_and_round_trips_special_chars() {
    let mut it = Item::new_login("A,\"quoted\"", "https://a.example.com", "u", "p\nw");
    it.note = "line1\nline2".into();
    let bytes = portio::export_csv(&[it.clone()]).unwrap();
    assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
    let back = portio::import_csv(&bytes, None, "r").unwrap();
    assert_eq!(back[0].name, it.name);
    assert_eq!(back[0].login_password(), "p\nw");
    assert_eq!(back[0].note, "line1\nline2");
}

#[test]
fn json_export_round_trip() {
    let mut it = Item::new(ItemType::Note, "メモ");
    it.text = "本文".into();
    let l = Item::new_login("L", "https://l.example.com", "u", "p");
    let bytes = portio::export_json(&[it.clone(), l.clone()]).unwrap();
    let back = portio::import_tkrform_json(&bytes).unwrap();
    assert_eq!(back.len(), 2);
    assert_eq!(back[0].text, "本文");
    assert_ne!(back[0].id, it.id, "ID は付け替える");
    assert!(portio::import_tkrform_json(b"{\"format\":\"x\",\"version\":1,\"exported\":\"\",\"items\":[]}").is_err());
}

#[test]
fn bitwarden_import() {
    let j = r#"{"encrypted":false,"folders":[{"id":"f1","name":"仕事"}],"items":[
      {"type":1,"name":"GH","folderId":"f1","notes":"n","login":{"username":"u","password":"p","totp":"JBSWY3DPEHPK3PXP","uris":[{"uri":"https://github.com"}]}},
      {"type":2,"name":"memo","notes":"text"},{"type":3,"name":"card"}]}"#;
    let items = portio::import_bitwarden_json(j.as_bytes(), "R").unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].folder, "/R/仕事");
    assert_eq!(items[0].totp_key, "JBSWY3DPEHPK3PXP");
    assert_eq!(items[1].kind, ItemType::Note);
    assert!(portio::import_bitwarden_json(br#"{"encrypted":true}"#, "R").is_err());
}

// ---------------------------------------------------------------- モデル / 設定

#[test]
fn item_json_shape() {
    let it = Item::new_login("A", "https://a.example.com", "u", "p");
    let v = serde_json::to_value(&it).unwrap();
    assert_eq!(v["type"], 1);
    assert_eq!(v["fields"][0]["role"], "user");
    assert_eq!(v["fields"][1]["kind"], "password");
    assert!(v.get("text").is_none(), "使わない項目は省略する");
    let back: Item = serde_json::from_value(v).unwrap();
    assert_eq!(back, it);
}

#[test]
fn preferences_defaults_and_policy() {
    let p = Preferences::default();
    assert_eq!(p.security.auto_lock_minutes, 60);
    assert_eq!(p.security.iterations, 600_000);
    assert_eq!(p.autofill.mode, "suggest");
    assert_eq!(p.autofill.min_identity_fields, 3);
    assert_eq!(p.security.clipboard_clear_secs, 30);
    let q = p.with_policy(&serde_json::json!({"security": {"autoLockMinutes": 5}}));
    assert_eq!(q.security.auto_lock_minutes, 5);
    assert!(q.security.lock_on_session_lock);
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("preferences.json");
    q.save(&path).unwrap();
    assert_eq!(Preferences::load(&path), q);
    assert_eq!(Preferences::load(&tmp.path().join("none.json")), p);
}

#[test]
fn field_kind_reads_and_writes_names() {
    use tkrform_core::model::{Field, FieldKind};
    // 新しい名前も読め、書き出すのは新しい名前
    let new = [("text", FieldKind::Text), ("password", FieldKind::Password), ("checkbox", FieldKind::Checkbox), ("radio", FieldKind::Radio), ("textarea", FieldKind::Textarea), ("select", FieldKind::Select)];
    for (code, want) in new {
        let f: Field = serde_json::from_str(&format!(r#"{{"name":"n","value":"v","kind":"{code}"}}"#)).unwrap();
        assert_eq!(f.kind, want);
        let back = serde_json::to_value(&f).unwrap();
        assert_eq!(back["kind"], code, "書き出しは新しい名前");
        // 往復で値が変わらない
        let again: Field = serde_json::from_value(back).unwrap();
        assert_eq!(again, f);
    }
    // 種類がなければ text
    let f: Field = serde_json::from_str(r#"{"name":"n","value":"v"}"#).unwrap();
    assert_eq!(f.kind, FieldKind::Text);
    // 項目を書き出して読み戻しても、種類と値が変わらない
    let item_json = r#"{"id":"a1","type":1,"name":"x","folder":"/","created":"2026-01-01T00:00:00Z","modified":"2026-01-01T00:00:00Z","fields":[{"name":"u","value":"taro","kind":"text","role":"user"},{"name":"p","value":"secret","kind":"password","role":"password"},{"name":"r","value":"a","kind":"radio"}]}"#;
    let it: tkrform_core::Item = serde_json::from_str(item_json).unwrap();
    assert_eq!(it.login_user(), "taro");
    assert_eq!(it.login_password(), "secret");
    let out = serde_json::to_value(&it).unwrap();
    assert_eq!(out["fields"][0]["kind"], "text");
    assert_eq!(out["fields"][1]["kind"], "password");
    assert_eq!(out["fields"][2]["kind"], "radio");
    assert_eq!(out["fields"][1]["value"], "secret");
}

#[test]
fn item_and_pref_names() {
    // ログインのヒントと多段ログイン: hint / chain.previous / chain.next で読み書きする
    let new = r#"{"id":"a2","type":1,"name":"y","folder":"/","created":"2026-01-01T00:00:00Z","modified":"2026-01-01T00:00:00Z","hint":"h","chain":{"previous":["b1"],"next":["z"]}}"#;
    let it: tkrform_core::Item = serde_json::from_str(new).unwrap();
    assert_eq!((it.hint.as_str(), it.chain.previous.clone(), it.chain.next.clone()), ("h", vec!["b1".to_string()], vec!["z".to_string()]));
    let v = serde_json::to_value(&it).unwrap();
    assert_eq!(v["hint"], "h");
    assert_eq!(v["chain"]["next"][0], "z");

    // 設定: general.sortOrder
    use tkrform_core::prefs::Preferences;
    let p2: Preferences = serde_json::from_str(r#"{"general":{"sortOrder":"count"}}"#).unwrap();
    assert_eq!(p2.general.sort_order, "count");
    assert_eq!(serde_json::to_value(&p2).unwrap()["general"]["sortOrder"], "count");
    assert_eq!(Preferences::default().general.sort_order, "auto");
}
