//! URL 照合（§8.2）。
//!
//! 公開サフィックスリスト（`data/public_suffix_list.dat`、MPL-2.0）で eTLD+1 を求める。

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::model::MatchLevel;

const PSL_DATA: &str = include_str!("../data/public_suffix_list.dat");

struct Psl {
    rules: HashSet<String>,
    wild: HashSet<String>,
    except: HashSet<String>,
}

fn to_ascii_host(rule: &str) -> String {
    if rule.is_ascii() {
        return rule.to_string();
    }
    url::Url::parse(&format!("http://{rule}/"))
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| rule.to_string())
}

fn psl() -> &'static Psl {
    static PSL: OnceLock<Psl> = OnceLock::new();
    PSL.get_or_init(|| {
        let mut p = Psl { rules: HashSet::new(), wild: HashSet::new(), except: HashSet::new() };
        for line in PSL_DATA.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            let rule = line.split_whitespace().next().unwrap_or("");
            if let Some(r) = rule.strip_prefix('!') {
                p.except.insert(to_ascii_host(&r.to_lowercase()));
            } else if let Some(r) = rule.strip_prefix("*.") {
                p.wild.insert(to_ascii_host(&r.to_lowercase()));
            } else {
                p.rules.insert(to_ascii_host(&rule.to_lowercase()));
            }
        }
        p
    })
}

fn is_ip_like(host: &str) -> bool {
    host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok()
}

/// ホスト名そのものが公開サフィックス（com, co.jp, github.io など）か。
pub fn is_public_suffix(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_lowercase();
    if is_ip_like(&host) || host.is_empty() {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    let p = psl();
    if p.except.contains(&host) {
        return false;
    }
    p.rules.contains(&host) || (n >= 2 && p.wild.contains(&labels[1..].join(".")))
}

/// ホスト名から eTLD+1（登録可能ドメイン）を求める。IP やドットなしのホストはそのまま返す。
pub fn registrable_domain(host: &str) -> String {
    let host = host.trim_end_matches('.').to_lowercase();
    if is_ip_like(&host) || !host.contains('.') {
        return host;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    let p = psl();
    let mut best = 1usize;
    let mut exc: Option<usize> = None;
    for i in 0..n {
        let cand = labels[i..].join(".");
        let len = n - i;
        if p.except.contains(&cand) {
            exc = Some(len - 1);
            break;
        }
        if p.rules.contains(&cand) {
            best = best.max(len);
        }
        if i + 1 < n && p.wild.contains(&labels[i + 1..].join(".")) {
            best = best.max(len);
        }
    }
    let suffix_len = exc.unwrap_or(best);
    if n > suffix_len {
        labels[n - suffix_len - 1..].join(".")
    } else {
        host
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub scheme: String,
    /// 小文字・`www.` 除去済み
    pub host: String,
    pub port: Option<u16>,
    /// 末尾の `/` を除いたパス（ルートは空文字）
    pub path: String,
}

/// URL を正規化して分解する。スキームがなければ `https://` を補う。http/https 以外は `None`。
pub fn parse(input: &str) -> Option<Parsed> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let u = url::Url::parse(&with_scheme).ok()?;
    let scheme = u.scheme().to_string();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").map(str::to_string).unwrap_or(host);
    let path = u.path().trim_end_matches('/').to_string();
    Some(Parsed { scheme, host, port: u.port(), path })
}

/// 保存先 URL から eTLD+1 を求める（インデックス用）。
pub fn domain_of(url: &str) -> Option<String> {
    parse(url).map(|p| registrable_domain(&p.host))
}

/// 同等ドメインの表で正規化する（§8.2-4）。グループの先頭を代表値とする。
pub fn canonical_domain(domain: &str, equiv: &[Vec<String>]) -> String {
    let d = domain.to_lowercase();
    for g in equiv {
        if g.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
            if let Some(first) = g.first() {
                return first.to_lowercase();
            }
        }
    }
    d
}

fn is_local_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// `request` の URL が、保存された `saved`（matchUrl）と `level` で一致するか。
///
/// 安全のため、`https` で保存されたものは `http` のページには一致させない（localhost を除く）。
pub fn url_matches(request: &str, saved: &str, level: MatchLevel, equiv: &[Vec<String>]) -> bool {
    let (Some(req), Some(sv)) = (parse(request), parse(saved)) else {
        return false;
    };
    if sv.scheme == "https" && req.scheme == "http" && !is_local_host(&req.host) {
        return false;
    }
    match level {
        MatchLevel::Domain => {
            let a = canonical_domain(&registrable_domain(&req.host), equiv);
            let b = canonical_domain(&registrable_domain(&sv.host), equiv);
            a == b
        }
        MatchLevel::Host => req.host == sv.host,
        MatchLevel::Prefix => {
            req.host == sv.host
                && req.port == sv.port
                && (sv.path.is_empty()
                    || req.path == sv.path
                    || req.path.starts_with(&format!("{}/", sv.path)))
        }
        MatchLevel::Exact => req.host == sv.host && req.port == sv.port && req.path == sv.path,
    }
}

#[cfg(test)]
mod psl_tests {
    #[test]
    fn public_suffix_detection() {
        assert!(super::is_public_suffix("com"));
        assert!(super::is_public_suffix("co.jp"));
        assert!(super::is_public_suffix("github.io"));
        assert!(!super::is_public_suffix("example.com"));
        assert!(!super::is_public_suffix("foo.github.io"));
        assert!(!super::is_public_suffix("localhost"));
    }
}
