use chrono::{Duration, Utc};
use tkrform_core::model::{Item, PwHistory};
use tkrform_core::security::{analyze, check_breaches, count_in_range, sha1_hex_upper};

fn login(name: &str, url: &str, user: &str, pw: &str) -> Item {
    Item::new_login(name, url, user, pw)
}

#[test]
fn weak_reused_old_duplicate_and_score() {
    let strong = "Xk9#mQ2$vLp7!wRz-8Tn";
    let mut a = login("A", "https://a.example.com", "u", "password");
    let b = login("B", "https://b.example.com", "u", strong);
    let c = login("C", "https://c.example.com", "u", strong); // B と使い回し
    let mut d = login("D", "https://d.example.com", "u", "Qw8!zT4#nB6@kP1%xY");
    d.created = (Utc::now() - Duration::days(400)).to_rfc3339(); // 古い
    let mut e = login("E", "https://www.d.example.com/", "u", "Rt5$hG9&mC3*jL7^vN"); // D と URL・ID が同じ
    e.created = Utc::now().to_rfc3339();
    a.created = Utc::now().to_rfc3339();
    let mut trashed = login("Gone", "https://x.example.com", "u", "abc");
    trashed.deleted = true;
    let rep = analyze(&[a, b, c, d, e, trashed], Utc::now());
    assert_eq!(rep.total, 5, "ごみ箱は数えない");
    assert_eq!(rep.weak.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["A"]);
    assert_eq!(rep.reused.len(), 1);
    assert_eq!(rep.reused[0].len(), 2);
    assert_eq!(rep.old.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["D"]);
    assert_eq!(rep.duplicates.len(), 1);
    assert!(rep.score < 100 && rep.score > 0, "score={}", rep.score);
    assert!(rep.reused[0].iter().all(|r| !r.id.is_empty()));
}

#[test]
fn clean_vault_scores_100_and_history_resets_age() {
    let mut a = login("A", "https://a.example.com", "u", "Xk9#mQ2$vLp7!wRz-8Tn");
    a.created = (Utc::now() - Duration::days(900)).to_rfc3339();
    a.password_history.push(PwHistory { value: "old".into(), changed: (Utc::now() - Duration::days(10)).to_rfc3339() });
    let rep = analyze(&[a], Utc::now());
    assert!(rep.old.is_empty(), "最近パスワードを変えていれば古くない");
    assert_eq!(rep.score, 100);
    assert_eq!(analyze(&[], Utc::now()).score, 100);
}

#[test]
fn hibp_k_anonymity() {
    // 公開されているテストベクタ: "password" の SHA-1
    assert_eq!(sha1_hex_upper("password"), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
    let body = "003D68EB55068C33ACE09247EE4C639306B:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\r\n";
    assert_eq!(count_in_range(body, "1E4C9B93F3F0682250B6CF8331B7EE68FD8"), 9545824);
    assert_eq!(count_in_range(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"), 0, "パディング行は 0");
    let hashes = vec![("a".to_string(), sha1_hex_upper("password")), ("b".to_string(), sha1_hex_upper("Xk9#mQ2$vLp7!wRz-8Tn"))];
    let mut sent = Vec::new();
    let hits = check_breaches(&hashes, |prefix| {
        sent.push(prefix.to_string());
        Ok(if prefix == "5BAA6" { body.to_string() } else { String::new() })
    })
    .unwrap();
    assert_eq!(hits, vec![("a".to_string(), 9545824)]);
    assert!(sent.iter().all(|p| p.len() == 5), "送るのは先頭 5 文字だけ: {sent:?}");
    assert!(check_breaches(&[("x".into(), "zz".into())], |_| Ok(String::new())).is_err());
}
