//! 共通 UI 文字列（`locales/*.json`）。デスクトップの Rust 側（トレイ・ウィンドウタイトル）と画面で共有する。

use std::collections::HashMap;
use std::sync::OnceLock;

const JA: &str = include_str!("../../../locales/ja.json");
const EN: &str = include_str!("../../../locales/en.json");

fn table(lang: &str) -> &'static HashMap<String, String> {
    static JA_MAP: OnceLock<HashMap<String, String>> = OnceLock::new();
    static EN_MAP: OnceLock<HashMap<String, String>> = OnceLock::new();
    if lang == "en" {
        EN_MAP.get_or_init(|| serde_json::from_str(EN).unwrap_or_default())
    } else {
        JA_MAP.get_or_init(|| serde_json::from_str(JA).unwrap_or_default())
    }
}

/// 文言を引く。英語で未定義なら日本語、それも無ければキー名を返す。
pub fn t(lang: &str, key: &str) -> String {
    table(lang).get(key).or_else(|| table("ja").get(key)).cloned().unwrap_or_else(|| key.to_string())
}

/// `%1`、`%2` を引数で置き換える。
pub fn tf(lang: &str, key: &str, args: &[&str]) -> String {
    let mut s = t(lang, key);
    for (i, a) in args.iter().enumerate() {
        s = s.replace(&format!("%{}", i + 1), a);
    }
    s
}

pub fn raw_json(lang: &str) -> &'static str {
    if lang == "en" {
        EN
    } else {
        JA
    }
}
