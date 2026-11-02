//! パスキー（WebAuthn の認証器の役割。§8.7）。
//!
//! 根拠は W3C WebAuthn Level 3 と CTAP2 の公開仕様のみ。鍵は ES256（ECDSA P-256 + SHA-256）で、
//! 秘密鍵は PKCS8 (DER) をログイン項目に保存する（保管庫の暗号化と同期にそのまま乗る）。
//!
//! 設計上の判断:
//! - signCount は 0 のまま変えない。複数の端末へ同期されるパスキー（BE=1, BS=1）では、端末ごとに数えても意味がなく、
//!   0 を返し続けることが仕様で認められている（0 のままなら、サーバは回数の検査をしない）。
//! - AAGUID は tkrform 固有の固定値。attestation は "none"。

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use sha2::{Digest, Sha256};

use crate::model::Passkey;
use crate::urlmatch;

/// tkrform 固有の AAGUID（固定）。
pub const AAGUID: [u8; 16] = [0x7b, 0x2f, 0x94, 0x1c, 0x5a, 0x63, 0x4e, 0x08, 0x9d, 0xa1, 0x3c, 0x57, 0xe2, 0x6b, 0x10, 0xf4];

pub const FLAG_UP: u8 = 0x01;
pub const FLAG_UV: u8 = 0x04;
pub const FLAG_BE: u8 = 0x08;
pub const FLAG_BS: u8 = 0x10;
pub const FLAG_AT: u8 = 0x40;

/// COSE のアルゴリズム ID: ES256。
pub const ALG_ES256: i64 = -7;

pub fn b64u(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

pub fn b64u_decode(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).map_err(|_| "base64url の値が正しくありません".to_string())
}

pub fn rp_id_hash(rp_id: &str) -> [u8; 32] {
    Sha256::digest(rp_id.as_bytes()).into()
}

/// オリジンのホスト名（小文字）。
pub fn origin_host(origin: &str) -> String {
    url::Url::parse(origin).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_default()
}

/// オリジンと rpId を検証する。
/// - オリジンは https（localhost だけ http も可）。
/// - rpId は、オリジンのホストと同じか、そのドットで区切った上位で、公開サフィックス（com, co.jp など）ではないこと。
/// - IP アドレスは rpId にできない。
pub fn validate_origin_rp(origin: &str, rp_id: &str) -> Result<(), String> {
    let u = url::Url::parse(origin).map_err(|_| "オリジンが正しくありません".to_string())?;
    let host = u.host_str().ok_or("オリジンにホスト名がありません")?.to_lowercase();
    let local = host == "localhost" || host.ends_with(".localhost");
    match u.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("パスキーは https のサイトでだけ使えます".into()),
    }
    let rp = rp_id.to_lowercase();
    if rp.is_empty() || rp != rp_id || rp.contains(['/', ':', '@', ' ']) || rp.starts_with('.') || rp.ends_with('.') {
        return Err("rpId が正しくありません".into());
    }
    if host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok() {
        return Err("IP アドレスのサイトではパスキーを使えません".into());
    }
    if host != rp && !host.ends_with(&format!(".{rp}")) {
        return Err("rpId がサイトのドメインと一致しません".into());
    }
    if !local && urlmatch::is_public_suffix(&rp) {
        return Err("rpId に公開サフィックス（com や co.jp など）は使えません".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- 最小限の CBOR（書き出しのみ）

fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n < 0x100 {
        out.push(m | 24);
        out.push(n as u8);
    } else if n < 0x1_0000 {
        out.push(m | 25);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(m | 26);
        out.extend_from_slice(&(n as u32).to_be_bytes());
    }
}

fn cbor_int(out: &mut Vec<u8>, v: i64) {
    if v >= 0 {
        cbor_head(out, 0, v as u64);
    } else {
        cbor_head(out, 1, (-1 - v) as u64);
    }
}

fn cbor_bytes(out: &mut Vec<u8>, b: &[u8]) {
    cbor_head(out, 2, b.len() as u64);
    out.extend_from_slice(b);
}

fn cbor_text(out: &mut Vec<u8>, s: &str) {
    cbor_head(out, 3, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

/// COSE_Key（EC2, ES256, P-256）。キーの並びは CTAP2 の正規形（1, 3, -1, -2, -3）。
pub fn cose_es256_key(x: &[u8], y: &[u8]) -> Vec<u8> {
    let mut o = Vec::new();
    cbor_head(&mut o, 5, 5);
    cbor_int(&mut o, 1);
    cbor_int(&mut o, 2); // kty: EC2
    cbor_int(&mut o, 3);
    cbor_int(&mut o, ALG_ES256);
    cbor_int(&mut o, -1);
    cbor_int(&mut o, 1); // crv: P-256
    cbor_int(&mut o, -2);
    cbor_bytes(&mut o, x);
    cbor_int(&mut o, -3);
    cbor_bytes(&mut o, y);
    o
}

/// attestationObject（fmt "none"）。キーの並びは CTAP2 の正規形（短い順: fmt, attStmt, authData）。
pub fn attestation_object_none(auth_data: &[u8]) -> Vec<u8> {
    let mut o = Vec::new();
    cbor_head(&mut o, 5, 3);
    cbor_text(&mut o, "fmt");
    cbor_text(&mut o, "none");
    cbor_text(&mut o, "attStmt");
    cbor_head(&mut o, 5, 0);
    cbor_text(&mut o, "authData");
    cbor_bytes(&mut o, auth_data);
    o
}

// ---------------------------------------------------------------- 登録と認証

/// 登録の結果（ページへ返す値）。
pub struct Created {
    pub passkey: Passkey,
    pub credential_id: Vec<u8>,
    pub auth_data: Vec<u8>,
    pub attestation_object: Vec<u8>,
    /// SubjectPublicKeyInfo (DER)
    pub public_key_spki: Vec<u8>,
}

/// 新しい鍵ペアを作り、登録のレスポンスを組み立てる。`uv` は利用者の確認（Hello など）が済んでいるか。
pub fn create(rp_id: &str, user_id: &[u8], user_name: &str, user_display_name: &str, uv: bool) -> Result<Created, String> {
    let sk = SigningKey::random(&mut rand::rngs::OsRng);
    let pkcs8 = sk.to_pkcs8_der().map_err(|e| e.to_string())?;
    let vk = VerifyingKey::from(&sk);
    let spki = vk.to_public_key_der().map_err(|e| e.to_string())?.as_bytes().to_vec();
    let pt = vk.to_encoded_point(false);
    let (x, y) = (pt.x().ok_or("公開鍵を作れません")?, pt.y().ok_or("公開鍵を作れません")?);
    let mut cred_id = vec![0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut cred_id);

    let mut flags = FLAG_UP | FLAG_AT | FLAG_BE | FLAG_BS;
    if uv {
        flags |= FLAG_UV;
    }
    let mut ad = Vec::new();
    ad.extend_from_slice(&rp_id_hash(rp_id));
    ad.push(flags);
    ad.extend_from_slice(&0u32.to_be_bytes()); // signCount: 0 のまま
    ad.extend_from_slice(&AAGUID);
    ad.extend_from_slice(&(cred_id.len() as u16).to_be_bytes());
    ad.extend_from_slice(&cred_id);
    ad.extend_from_slice(&cose_es256_key(x, y));

    let passkey = Passkey {
        rp_id: rp_id.to_string(),
        credential_id: b64u(&cred_id),
        user_handle: b64u(user_id),
        user_name: user_name.to_string(),
        user_display_name: user_display_name.to_string(),
        private_key: STANDARD.encode(pkcs8.as_bytes()),
        sign_count: 0,
        created: crate::model::now_iso(),
        last_used: None,
    };
    let attestation_object = attestation_object_none(&ad);
    Ok(Created { passkey, credential_id: cred_id, auth_data: ad, attestation_object, public_key_spki: spki })
}

/// clientDataJSON。キーの順序は type, challenge, origin, crossOrigin（WebAuthn の既定の直列化）。
pub fn client_data_json(kind: &str, challenge_b64u: &str, origin: &str, cross_origin: bool) -> String {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    format!("{{\"type\":{},\"challenge\":{},\"origin\":{},\"crossOrigin\":{}}}", q(kind), q(challenge_b64u), q(origin), cross_origin)
}

/// 認証: authenticatorData（AT なし）と、authenticatorData || SHA-256(clientDataJSON) への ES256 署名（DER）を返す。
pub fn assert(pk: &Passkey, client_data_json: &str, uv: bool) -> Result<(Vec<u8>, Vec<u8>), String> {
    let der = STANDARD.decode(&pk.private_key).map_err(|_| "保存されたパスキーの鍵が壊れています".to_string())?;
    let sk = SigningKey::from_pkcs8_der(&der).map_err(|_| "保存されたパスキーの鍵が壊れています".to_string())?;
    let mut flags = FLAG_UP | FLAG_BE | FLAG_BS;
    if uv {
        flags |= FLAG_UV;
    }
    let mut ad = Vec::new();
    ad.extend_from_slice(&rp_id_hash(&pk.rp_id));
    ad.push(flags);
    ad.extend_from_slice(&0u32.to_be_bytes());
    let mut msg = ad.clone();
    msg.extend_from_slice(&Sha256::digest(client_data_json.as_bytes()));
    let sig: Signature = sk.sign(&msg);
    Ok((ad, sig.to_der().as_bytes().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::pkcs8::DecodePublicKey;

    #[test]
    fn rp_validation_cases() {
        // 同じホスト・サブドメインから上位の登録可能ドメイン
        assert!(validate_origin_rp("https://example.com", "example.com").is_ok());
        assert!(validate_origin_rp("https://login.example.com", "example.com").is_ok());
        assert!(validate_origin_rp("https://a.b.example.com", "b.example.com").is_ok());
        assert!(validate_origin_rp("https://login.example.co.jp", "example.co.jp").is_ok());
        // 別のドメイン・紛らわしいドメイン
        assert!(validate_origin_rp("https://example.com", "other.com").is_err());
        assert!(validate_origin_rp("https://notexample.com", "example.com").is_err());
        assert!(validate_origin_rp("https://example.com", "login.example.com").is_err());
        // 公開サフィックスの境界
        assert!(validate_origin_rp("https://example.com", "com").is_err());
        assert!(validate_origin_rp("https://example.co.jp", "co.jp").is_err());
        assert!(validate_origin_rp("https://foo.github.io", "github.io").is_err());
        assert!(validate_origin_rp("https://foo.github.io", "foo.github.io").is_ok());
        // http は拒否（localhost だけ許可）
        assert!(validate_origin_rp("http://example.com", "example.com").is_err());
        assert!(validate_origin_rp("http://localhost:8080", "localhost").is_ok());
        assert!(validate_origin_rp("https://localhost", "localhost").is_ok());
        // IP・形式不正・大文字
        assert!(validate_origin_rp("https://127.0.0.1", "127.0.0.1").is_err());
        assert!(validate_origin_rp("https://example.com", "Example.com").is_err());
        assert!(validate_origin_rp("https://example.com", "example.com:443").is_err());
        assert!(validate_origin_rp("https://example.com", "").is_err());
        assert!(validate_origin_rp("ftp://example.com", "example.com").is_err());
    }

    #[test]
    fn auth_data_layout_and_cose_key() {
        let c = create("example.com", b"user-1", "taro", "Taro", true).unwrap();
        let ad = &c.auth_data;
        assert_eq!(&ad[..32], &rp_id_hash("example.com"));
        assert_eq!(ad[32], FLAG_UP | FLAG_UV | FLAG_AT | FLAG_BE | FLAG_BS);
        assert_eq!(&ad[33..37], &[0, 0, 0, 0], "signCount は 0");
        assert_eq!(&ad[37..53], &AAGUID);
        let len = u16::from_be_bytes([ad[53], ad[54]]) as usize;
        assert_eq!(len, c.credential_id.len());
        assert!(len >= 16);
        assert_eq!(&ad[55..55 + len], &c.credential_id[..]);
        let cose = &ad[55 + len..];
        // map(5) { 1:2, 3:-7, -1:1, -2:x(32), -3:y(32) }
        assert_eq!(cose[0], 0xa5);
        assert_eq!(&cose[1..9], &[0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58]);
        assert_eq!(cose[9], 32);
        assert_eq!(cose[9 + 1 + 32], 0x22);
        assert_eq!(cose.len(), 9 + 1 + 32 + 1 + 2 + 32);
        // UV なし
        let c2 = create("example.com", b"u", "a", "a", false).unwrap();
        assert_eq!(c2.auth_data[32] & FLAG_UV, 0);
    }

    #[test]
    fn attestation_object_is_none_format() {
        let o = attestation_object_none(&[1, 2, 3]);
        assert_eq!(o[0], 0xa3); // map(3)
        assert_eq!(&o[1..5], &[0x63, b'f', b'm', b't']);
        assert_eq!(&o[5..10], &[0x64, b'n', b'o', b'n', b'e']);
        assert_eq!(&o[10..18], &[0x67, b'a', b't', b't', b'S', b't', b'm', b't']);
        assert_eq!(o[18], 0xa0); // 空の map
        assert!(o.ends_with(&[0x43, 1, 2, 3]));
    }

    #[test]
    fn client_data_order_and_escape() {
        let j = client_data_json("webauthn.get", "abc_-", "https://example.com", false);
        assert_eq!(j, r#"{"type":"webauthn.get","challenge":"abc_-","origin":"https://example.com","crossOrigin":false}"#);
        let v: serde_json::Value = serde_json::from_str(&client_data_json("webauthn.create", "x", "https://a\"b", true)).unwrap();
        assert_eq!(v["origin"], "https://a\"b");
    }

    #[test]
    fn assertion_signature_verifies_with_registered_key() {
        let c = create("example.com", b"user-1", "taro", "Taro", true).unwrap();
        let cd = client_data_json("webauthn.get", &b64u(b"challenge-bytes"), "https://example.com", false);
        let (ad, sig) = assert(&c.passkey, &cd, true).unwrap();
        assert_eq!(ad.len(), 37);
        assert_eq!(ad[32], FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS);
        let vk = VerifyingKey::from_public_key_der(&c.public_key_spki).unwrap();
        let mut msg = ad.clone();
        msg.extend_from_slice(&Sha256::digest(cd.as_bytes()));
        let sig = Signature::from_der(&sig).unwrap();
        assert!(vk.verify(&msg, &sig).is_ok(), "公開鍵で署名を検証できる");
        // 別の clientDataJSON では検証に失敗する
        let mut bad = ad.clone();
        bad.extend_from_slice(&Sha256::digest(b"other"));
        assert!(vk.verify(&bad, &sig).is_err());
        // UV なしの認証
        let (ad2, _) = assert(&c.passkey, &cd, false).unwrap();
        assert_eq!(ad2[32] & FLAG_UV, 0);
    }

    #[test]
    fn credential_ids_are_unique_and_long() {
        let a = create("example.com", b"u", "a", "a", false).unwrap();
        let b = create("example.com", b"u", "a", "a", false).unwrap();
        assert_ne!(a.credential_id, b.credential_id);
        assert!(a.credential_id.len() >= 16);
    }
}
