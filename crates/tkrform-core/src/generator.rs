//! パスワード生成器（§11）。

use std::sync::OnceLock;

use rand::rngs::OsRng;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// EFF Large Wordlist（CC-BY 3.0）。ライセンス表記は LICENSES.md を参照。
const WORDLIST: &str = include_str!("../data/eff_large_wordlist.txt");

fn words() -> &'static Vec<&'static str> {
    static W: OnceLock<Vec<&'static str>> = OnceLock::new();
    W.get_or_init(|| WORDLIST.lines().filter_map(|l| l.split_whitespace().nth(1)).collect())
}

pub const SIMILAR_CHARS: &str = "Il1O0o";
pub const DEFAULT_SYMBOLS: &str = "!@#$%^&*";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GenMode {
    #[default]
    Random,
    Passphrase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenOptions {
    pub mode: GenMode,
    pub length: usize,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
    pub symbol_chars: String,
    pub hex_only: bool,
    pub exclude_similar: bool,
    pub require_each: bool,
    pub words: usize,
    pub separator: char,
    pub capitalize: bool,
    pub add_number: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        GenOptions {
            mode: GenMode::Random,
            length: 16,
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
            symbol_chars: DEFAULT_SYMBOLS.to_string(),
            hex_only: false,
            exclude_similar: false,
            require_each: true,
            words: 4,
            separator: '-',
            capitalize: true,
            add_number: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Generated {
    pub password: String,
    pub bits: f64,
}

fn classes(o: &GenOptions) -> Vec<Vec<char>> {
    let keep = |c: &char| !(o.exclude_similar && SIMILAR_CHARS.contains(*c));
    let mut v: Vec<Vec<char>> = Vec::new();
    if o.hex_only {
        v.push("0123456789ABCDEF".chars().filter(keep).collect());
    } else {
        if o.upper {
            v.push(('A'..='Z').filter(keep).collect());
        }
        if o.lower {
            v.push(('a'..='z').filter(keep).collect());
        }
        if o.digits {
            v.push(('0'..='9').filter(keep).collect());
        }
        if o.symbols {
            let mut s: Vec<char> = o.symbol_chars.chars().filter(keep).filter(|c| !c.is_control()).collect();
            s.sort_unstable();
            s.dedup();
            v.push(s);
        }
    }
    v.retain(|c| !c.is_empty());
    v
}

/// 剰余バイアスのない一様乱数（`gen_range` は棄却法を使う）。
fn pick<T: Copy>(set: &[T]) -> T {
    set[OsRng.gen_range(0..set.len())]
}

pub fn generate(o: &GenOptions) -> Result<Generated> {
    match o.mode {
        GenMode::Random => generate_random(o),
        GenMode::Passphrase => generate_passphrase(o),
    }
}

fn generate_random(o: &GenOptions) -> Result<Generated> {
    if !(4..=512).contains(&o.length) {
        return Err(Error::Invalid("文字数は 4〜512 の範囲で指定してください".into()));
    }
    let cls = classes(o);
    if cls.is_empty() {
        return Err(Error::Invalid("使う文字の種類を 1 つ以上選んでください".into()));
    }
    let mut pool: Vec<char> = cls.iter().flatten().copied().collect();
    pool.sort_unstable();
    pool.dedup();
    let mut out: Vec<char> = Vec::with_capacity(o.length);
    if o.require_each && o.length >= cls.len() {
        for c in &cls {
            out.push(pick(c));
        }
    }
    while out.len() < o.length {
        out.push(pick(&pool));
    }
    // Fisher–Yates
    for i in (1..out.len()).rev() {
        let j = OsRng.gen_range(0..=i);
        out.swap(i, j);
    }
    let bits = o.length as f64 * (pool.len() as f64).log2();
    Ok(Generated { password: out.into_iter().collect(), bits })
}

fn generate_passphrase(o: &GenOptions) -> Result<Generated> {
    if !(3..=12).contains(&o.words) {
        return Err(Error::Invalid("単語数は 3〜12 の範囲で指定してください".into()));
    }
    let w = words();
    let mut parts: Vec<String> = Vec::with_capacity(o.words + 1);
    for _ in 0..o.words {
        let word = pick(w);
        let mut s = word.to_string();
        if o.capitalize {
            let mut ch = s.chars();
            if let Some(f) = ch.next() {
                s = f.to_uppercase().collect::<String>() + ch.as_str();
            }
        }
        parts.push(s);
    }
    let mut bits = o.words as f64 * (w.len() as f64).log2();
    if o.add_number {
        parts.push(format!("{:02}", OsRng.gen_range(0..100)));
        bits += 100f64.log2();
    }
    Ok(Generated { password: parts.join(&o.separator.to_string()), bits })
}

/// 既存の文字列の強度を推定する（MP の強度メーター用、§7.1）。
pub fn estimate_bits(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut pool = 0u32;
    if s.chars().any(|c| c.is_ascii_lowercase()) {
        pool += 26;
    }
    if s.chars().any(|c| c.is_ascii_uppercase()) {
        pool += 26;
    }
    if s.chars().any(|c| c.is_ascii_digit()) {
        pool += 10;
    }
    if s.chars().any(|c| c.is_ascii_punctuation() || c == ' ') {
        pool += 33;
    }
    if !s.is_ascii() {
        pool += 100;
    }
    // 同じ文字の繰り返しは数えない
    let mut uniq: Vec<char> = s.chars().collect();
    uniq.sort_unstable();
    uniq.dedup();
    let eff_len = (s.chars().count() as f64).min(uniq.len() as f64 * 2.0);
    eff_len * (pool.max(2) as f64).log2()
}

/// 強度の区分（§11）。
pub fn strength_class(bits: f64) -> &'static str {
    if bits < 50.0 {
        "weak"
    } else if bits < 80.0 {
        "fair"
    } else {
        "strong"
    }
}
