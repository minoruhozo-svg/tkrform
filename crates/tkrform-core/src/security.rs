//! セキュリティセンター（§13）。弱いパスワード・使い回し・古いパスワード・重複を調べ、0〜100 のスコアを出す。
//! 漏洩チェック（HIBP の k-anonymity API）は、SHA-1 の先頭 5 文字だけを送る。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::generator::estimate_bits;
use crate::model::{Item, ItemType};
use crate::urlmatch;

/// 弱いとみなすビット強度（§13）
pub const WEAK_BITS: f64 = 50.0;
/// 古いとみなす日数（§13）
pub const OLD_DAYS: i64 = 365;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub name: String,
    pub user: String,
    pub url: String,
    /// パスワードを最後に変えた日（yyyy-MM-dd。履歴の最新、なければ作成日）
    pub changed: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// パスワードを持つログインの数
    pub total: usize,
    pub weak: Vec<Row>,
    /// 同じパスワードを使っているグループ（2 件以上）
    pub reused: Vec<Vec<Row>>,
    pub old: Vec<Row>,
    /// URL とユーザー ID が同じアイテムのグループ（2 件以上）
    pub duplicates: Vec<Vec<Row>>,
    /// 0〜100
    pub score: u32,
}

fn row(it: &Item) -> Row {
    let changed = it.password_history.last().map(|h| h.changed.as_str()).unwrap_or(&it.created);
    Row { id: it.id.clone(), name: it.name.clone(), user: it.login_user().to_string(), url: it.url.clone(), changed: changed.chars().take(10).collect() }
}

/// 最後にパスワードを変えた日（履歴の最新、なければ作成日）。
fn last_changed(it: &Item) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let s = it.password_history.last().map(|h| h.changed.as_str()).unwrap_or(&it.created);
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

/// ごみ箱のものを除いたログインを調べる。`now` はテストのために渡す。
pub fn analyze(items: &[Item], now: chrono::DateTime<chrono::Utc>) -> Report {
    let logins: Vec<&Item> = items.iter().filter(|i| i.kind == ItemType::Login && !i.deleted && !i.login_password().is_empty()).collect();
    let mut rep = Report { total: logins.len(), ..Default::default() };
    let mut by_pw: BTreeMap<&str, Vec<&Item>> = BTreeMap::new();
    let mut penalty = 0.0f64;
    for it in &logins {
        let mut p = 0.0;
        if estimate_bits(it.login_password()) < WEAK_BITS {
            rep.weak.push(row(it));
            p += 40.0;
        }
        by_pw.entry(it.login_password()).or_default().push(it);
        if last_changed(it).map(|d| (now - d.with_timezone(&chrono::Utc)).num_days() >= OLD_DAYS).unwrap_or(false) {
            rep.old.push(row(it));
            p += 20.0;
        }
        penalty += p;
    }
    for group in by_pw.values().filter(|g| g.len() >= 2) {
        rep.reused.push(group.iter().map(|i| row(i)).collect());
        penalty += 40.0 * group.len() as f64;
    }
    // 重複: 正規化した URL（ホスト + パス）とユーザー ID が同じ
    let mut dup: BTreeMap<String, Vec<&Item>> = BTreeMap::new();
    for it in items.iter().filter(|i| i.kind == ItemType::Login && !i.deleted && !i.url.is_empty()) {
        let key = match urlmatch::parse(&it.url) {
            Some(p) => format!("{}{}|{}", p.host, p.path, it.login_user()),
            None => format!("{}|{}", it.url, it.login_user()),
        };
        dup.entry(key).or_default().push(it);
    }
    for g in dup.values().filter(|g| g.len() >= 2) {
        rep.duplicates.push(g.iter().map(|i| row(i)).collect());
    }
    rep.score = if rep.total == 0 { 100 } else { (100.0 - (penalty / rep.total as f64)).clamp(0.0, 100.0).round() as u32 };
    rep
}

// ---------------------------------------------------------------------- 漏洩チェック（HIBP Pwned Passwords）

pub fn sha1_hex_upper(pw: &str) -> String {
    Sha1::digest(pw.as_bytes()).iter().map(|b| format!("{b:02X}")).collect()
}

/// 応答（`SUFFIX:COUNT` の行）から、`suffix` の出現回数を返す。パディング行（回数 0）は無視する。
pub fn count_in_range(body: &str, suffix: &str) -> u64 {
    for line in body.lines() {
        if let Some((s, c)) = line.trim().split_once(':') {
            if s.eq_ignore_ascii_case(suffix) {
                return c.trim().parse().unwrap_or(0);
            }
        }
    }
    0
}

/// `hashes`（大文字 40 桁の SHA-1）を調べる。`fetch(prefix5)` はレンジ API の本文を返す。
/// 送るのは先頭 5 文字だけで、同じ先頭のものは 1 回の問い合わせにまとめる。
pub fn check_breaches(hashes: &[(String, String)], mut fetch: impl FnMut(&str) -> Result<String>) -> Result<Vec<(String, u64)>> {
    let mut by_prefix: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for (id, h) in hashes {
        if h.len() != 40 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::Invalid("ハッシュの形式が不正です".into()));
        }
        by_prefix.entry(&h[..5]).or_default().push((id.as_str(), &h[5..]));
    }
    let mut hits = Vec::new();
    for (prefix, list) in by_prefix {
        let body = fetch(prefix)?;
        for (id, suffix) in list {
            let n = count_in_range(&body, suffix);
            if n > 0 {
                hits.push((id.to_string(), n));
            }
        }
    }
    Ok(hits)
}

/// 本物のレンジ API を呼ぶ。`base` は `https://api.pwnedpasswords.com/range/`。
pub fn fetch_range_http(base: &str, prefix: &str) -> Result<String> {
    let url = format!("{base}{prefix}");
    let r = ureq::get(&url)
        .set("Add-Padding", "true") // 応答の大きさから推測されないようにする
        .set("User-Agent", "tkrform")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|_| Error::Invalid("漏洩チェックのサーバに接続できません".into()))?;
    r.into_string().map_err(|_| Error::Invalid("漏洩チェックの応答を読み取れません".into()))
}
