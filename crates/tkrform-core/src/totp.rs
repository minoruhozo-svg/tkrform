//! TOTP（RFC 6238、§12）。

use hmac::{Hmac, Mac};

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algo {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TotpParams {
    pub secret: Vec<u8>,
    pub algo: Algo,
    pub digits: u32,
    pub period: u64,
}

fn clean_base32(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '=').collect::<String>().to_uppercase()
}

/// Base32 キーまたは `otpauth://totp/...` を解釈する。
pub fn parse(input: &str) -> Result<TotpParams> {
    let input = input.trim();
    let bad = || Error::Invalid("TOTP キーの形式が正しくありません".into());
    if input.to_lowercase().starts_with("otpauth://") {
        let u = url::Url::parse(input).map_err(|_| bad())?;
        if u.host_str().map(|h| h.to_lowercase()) != Some("totp".into()) {
            return Err(bad());
        }
        let mut p = TotpParams { secret: vec![], algo: Algo::Sha1, digits: 6, period: 30 };
        let mut have_secret = false;
        for (k, v) in u.query_pairs() {
            match k.to_lowercase().as_str() {
                "secret" => {
                    p.secret = base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &clean_base32(&v)).ok_or_else(bad)?;
                    have_secret = true;
                }
                "algorithm" => {
                    p.algo = match v.to_uppercase().as_str() {
                        "SHA1" => Algo::Sha1,
                        "SHA256" => Algo::Sha256,
                        "SHA512" => Algo::Sha512,
                        _ => return Err(bad()),
                    }
                }
                "digits" => {
                    p.digits = v.parse().map_err(|_| bad())?;
                    if !(6..=8).contains(&p.digits) {
                        return Err(bad());
                    }
                }
                "period" => {
                    p.period = v.parse().map_err(|_| bad())?;
                    if p.period == 0 {
                        return Err(bad());
                    }
                }
                _ => {}
            }
        }
        if !have_secret || p.secret.is_empty() {
            return Err(bad());
        }
        return Ok(p);
    }
    let secret = base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &clean_base32(input)).ok_or_else(bad)?;
    if secret.is_empty() {
        return Err(bad());
    }
    Ok(TotpParams { secret, algo: Algo::Sha1, digits: 6, period: 30 })
}

fn mac(algo: Algo, key: &[u8], msg: &[u8]) -> Vec<u8> {
    match algo {
        Algo::Sha1 => {
            let mut m = <Hmac<sha1::Sha1> as Mac>::new_from_slice(key).expect("鍵長");
            m.update(msg);
            m.finalize().into_bytes().to_vec()
        }
        Algo::Sha256 => {
            let mut m = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("鍵長");
            m.update(msg);
            m.finalize().into_bytes().to_vec()
        }
        Algo::Sha512 => {
            let mut m = <Hmac<sha2::Sha512> as Mac>::new_from_slice(key).expect("鍵長");
            m.update(msg);
            m.finalize().into_bytes().to_vec()
        }
    }
}

/// 指定 UNIX 時刻でのコード。
pub fn code_at(p: &TotpParams, unix: u64) -> String {
    let counter = unix / p.period;
    let h = mac(p.algo, &p.secret, &counter.to_be_bytes());
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = ((h[off] as u32 & 0x7f) << 24) | ((h[off + 1] as u32) << 16) | ((h[off + 2] as u32) << 8) | h[off + 3] as u32;
    let m = 10u32.pow(p.digits);
    format!("{:0width$}", bin % m, width = p.digits as usize)
}

/// 現在のコードと、次のコードまでの残り秒数。
pub fn now(p: &TotpParams) -> (String, u64) {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    (code_at(p, t), p.period - (t % p.period))
}
