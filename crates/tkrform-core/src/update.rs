//! 自動更新（§10.5）の、通信と画面に依存しない部分: `latest.json` の検証、版の比較、SHA-256 の照合。

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: String,
}

/// `{version, url, sha256, notes}` を検証して読む。ダウンロード元は https のみ。
pub fn parse_manifest(json: &str) -> Result<Manifest> {
    let m: Manifest = serde_json::from_str(json).map_err(|_| Error::Invalid("更新情報の形式が正しくありません".into()))?;
    if parse_version(&m.version).is_none() {
        return Err(Error::Invalid("更新情報の版が正しくありません".into()));
    }
    let u = url::Url::parse(&m.url).map_err(|_| Error::Invalid("更新情報の URL が正しくありません".into()))?;
    if u.scheme() != "https" && !(u.scheme() == "http" && matches!(u.host_str(), Some("localhost") | Some("127.0.0.1"))) {
        return Err(Error::Invalid("更新ファイルの URL は https である必要があります".into()));
    }
    if m.sha256.len() != 64 || !m.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::Invalid("更新情報の SHA-256 が正しくありません".into()));
    }
    Ok(m)
}

fn parse_version(v: &str) -> Option<Vec<u64>> {
    let v = v.trim().trim_start_matches('v');
    let parts: Option<Vec<u64>> = v.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty() && p.len() <= 4)
}

/// `candidate` が `current` より新しいか。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(mut a), Some(mut b)) => {
            let n = a.len().max(b.len());
            a.resize(n, 0);
            b.resize(n, 0);
            a > b
        }
        _ => false,
    }
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// ダウンロードしたファイルの SHA-256 が一致するか確かめる。
pub fn verify_file(path: &Path, expected: &str) -> Result<()> {
    if sha256_file(path)?.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(Error::Invalid("ダウンロードしたファイルの SHA-256 が一致しません。実行しません".into()))
    }
}

/// 同期サーバの URL（…/tkrform/sync.php）と同じ場所にある `latest.json` の URL。
pub fn latest_url_from(server_url: &str) -> Option<String> {
    let u = url::Url::parse(server_url).ok()?;
    u.join("latest.json").ok().map(|x| x.to_string())
}
