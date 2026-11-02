//! 暗号プリミティブ（§6）。RustCrypto の標準 API の組み合わせだけを使う。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;
pub const TAG_LEN: usize = 16;

/// 既定の PBKDF2 反復回数（§6.1）。
pub const DEFAULT_ITERATIONS: u32 = 600_000;
/// ユーザー設定で許す範囲（§6.1）。テストなどでは範囲外の値も `Vault::create` に渡せる。
pub const MIN_USER_ITERATIONS: u32 = 100_000;
pub const MAX_USER_ITERATIONS: u32 = 5_000_000;

pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// ユーザー入力の反復回数を許容範囲に収める。
pub fn clamp_user_iterations(n: u32) -> u32 {
    n.clamp(MIN_USER_ITERATIONS, MAX_USER_ITERATIONS)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

/// MP から KEK を導出する（PBKDF2-HMAC-SHA256、32 バイト）。
pub fn derive_kek(mp: &[u8], salt: &[u8], iterations: u32) -> Key {
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<Sha256>(mp, salt, iterations, &mut *out);
    out
}

/// HKDF-SHA256 で用途別の 32 バイト鍵を導出する。
pub fn hkdf_key(ikm: &[u8], info: &[u8]) -> Key {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(info, &mut *out).expect("32 バイトは HKDF の出力上限内");
    out
}

/// 同期サーバ用の認証鍵（§15.1）。KEK とは別用途の鍵になる。
pub fn derive_auth_key(mp: &[u8], salt: &[u8], iterations: u32) -> Key {
    let kek = derive_kek(mp, salt, iterations);
    hkdf_key(&*kek, b"auth")
}

/// AES-256-GCM で暗号化する。出力は `nonce(12B) || 暗号文+タグ`。nonce は毎回乱数。
pub fn seal(key: &[u8; KEY_LEN], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("鍵長は 32 バイト");
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), Payload { msg: plain, aad })
        .expect("AES-GCM の暗号化は失敗しない");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    out
}

/// `seal` の逆。タグの不一致（改ざん・鍵違い・AAD 違い）は `None` ではなく `Err(BadPassword)` ではなく
/// 呼び出し側が文脈に応じて変換できるよう `Err(Invalid)` で返す。
pub fn open(key: &[u8; KEY_LEN], aad: &[u8], data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.len() < NONCE_LEN + TAG_LEN {
        return Err(Error::Invalid("暗号文が短すぎます".into()));
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).expect("鍵長は 32 バイト");
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| Error::Invalid("復号に失敗しました".into()))
}

/// HMAC-SHA256。
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC は任意長の鍵を受け付ける");
    m.update(data);
    m.finalize().into_bytes().into()
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------- Windows Hello（§6.3）

const AAD_HELLO: &[u8] = b"tkrform-hello-kek";

/// Windows Hello（KeyCredential）が challenge に対して返した署名から鍵を導き、KEK を包む。
/// RSASSA-PKCS1-v1_5 の署名は同じ challenge に対して常に同じ値になるので、署名そのものが鍵の素材になる。
pub fn hello_wrap_kek(kek: &[u8; KEY_LEN], signature: &[u8]) -> Vec<u8> {
    let hk = hkdf_key(signature, b"hello");
    seal(&hk, AAD_HELLO, kek)
}

pub fn hello_unwrap_kek(wrapped: &[u8], signature: &[u8]) -> Result<Key> {
    let hk = hkdf_key(signature, b"hello");
    let plain = open(&hk, AAD_HELLO, wrapped).map_err(|_| Error::BadPassword)?;
    if plain.len() != KEY_LEN {
        return Err(Error::Invalid("Windows Hello の鍵の長さが不正です".into()));
    }
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    k.copy_from_slice(&plain);
    Ok(k)
}
