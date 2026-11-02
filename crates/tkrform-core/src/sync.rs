//! 同期クライアント（§15）。サーバへ送るのは暗号化済みのアイテムファイル（blob）と最小限のメタ情報だけ。
//!
//! - 認証: MP → PBKDF2(salt, iter) → KEK → HKDF("auth") を `authHash` として送る。サーバは `password_hash()` で保存する。
//! - 保管庫の鍵: サーバの salt / iter はこの保管庫のヘッダと同じ。KEK で包んだ VaultKey も預けるので、
//!   別の端末は MP だけで参加できる（`Vault::join`）。
//! - 競合: アイテムの rev で判定する。両方が変更されていたら、サーバ側を「名前 (競合 yyyy-MM-dd)」の別アイテムとして残す。
//! - 完全削除は墓石（`deleted: true`）として送る。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::crypto::{self, SALT_LEN};
use crate::error::{Error, Result};
use crate::fsutil;
use crate::model::ItemType;
use crate::vault::{raw_item_header, Vault};

pub const PUSH_CHUNK: usize = 400;

/// サーバとの通信。テストでは偽のサーバに差し替える。
pub trait Transport {
    /// `action` を POST し、成功時は応答の JSON（`success` を含む）を返す。失敗は `Err(Invalid(日本語メッセージ))`。
    fn post(&self, action: &str, body: &Value) -> Result<Value>;
}

pub struct HttpTransport {
    pub url: String,
}

impl HttpTransport {
    /// https のみ許可する（localhost / 127.0.0.1 はテスト・自宅サーバ用に http も許可）。
    pub fn new(url: &str) -> Result<Self> {
        let u = url::Url::parse(url.trim()).map_err(|_| Error::Invalid("サーバの URL が正しくありません".into()))?;
        let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
        if u.scheme() != "https" && !(u.scheme() == "http" && local) {
            return Err(Error::Invalid("同期サーバの URL は https:// で始めてください".into()));
        }
        Ok(HttpTransport { url: u.to_string() })
    }
}

impl Transport for HttpTransport {
    fn post(&self, action: &str, body: &Value) -> Result<Value> {
        let sep = if self.url.contains('?') { '&' } else { '?' };
        let url = format!("{}{sep}action={action}", self.url);
        let resp = ureq::post(&url).timeout(Duration::from_secs(60)).send_json(body.clone());
        let json: Value = match resp {
            Ok(r) => r.into_json().map_err(|_| Error::Invalid("サーバの応答が JSON ではありません".into()))?,
            // 4xx/5xx でも本文の message を使う
            Err(ureq::Error::Status(_, r)) => r.into_json().map_err(|_| Error::Invalid("サーバでエラーが発生しました".into()))?,
            Err(_) => return Err(Error::Invalid("同期サーバに接続できません".into())),
        };
        if json.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(json)
        } else {
            Err(Error::Invalid(json.get("message").and_then(Value::as_str).unwrap_or("同期に失敗しました").to_string()))
        }
    }
}

/// `sync.json`（秘密は含まない）。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    pub server_url: String,
    pub email: String,
    /// 最後に pull したサーバの headRev
    pub last_rev: u64,
    /// アイテム ID → 最後に同期した時点のアイテム rev
    pub synced: BTreeMap<String, u64>,
}

impl SyncState {
    pub fn load(dir: &Path) -> SyncState {
        std::fs::read(dir.join("sync.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        fsutil::write_atomic(&dir.join("sync.json"), &serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pulled: usize,
    pub pushed: usize,
    /// 「両方残す」で別アイテムとして残した数
    pub conflicts_kept: usize,
    /// 復号できず取り込まなかった数
    pub rejected: usize,
    pub purged: usize,
}

fn dec_salt(s: &str) -> Result<[u8; SALT_LEN]> {
    let v = B64.decode(s).or_else(|_| URL_SAFE_NO_PAD.decode(s.trim_end_matches('='))).map_err(|_| Error::Invalid("サーバの salt が不正です".into()))?;
    v.try_into().map_err(|_| Error::Invalid("サーバの salt の長さが不正です".into()))
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| Error::Invalid(format!("サーバの応答に {k} がありません")))
}

pub fn auth_hash(mp: &str, salt: &[u8], iter: u32) -> String {
    B64.encode(*crypto::derive_auth_key(mp.as_bytes(), salt, iter))
}

// ---------------------------------------------------------------------- アカウント

/// この保管庫でサーバにアカウントを作る。トークンを返す。
pub fn register(t: &dyn Transport, vault: &Vault, email: &str, mp: &str) -> Result<String> {
    let m = vault.auth_material(mp)?;
    let r = t.post(
        "register",
        &json!({"email": email, "authHash": B64.encode(*m.auth_key), "salt": B64.encode(m.salt), "iter": m.iterations, "wrappedVaultKey": B64.encode(&m.wrapped)}),
    )?;
    Ok(s(&r, "token")?.to_string())
}

pub struct LoginInfo {
    pub token: String,
    pub salt: [u8; SALT_LEN],
    pub iter: u32,
    pub wrapped: Vec<u8>,
}

fn login_raw(t: &dyn Transport, email: &str, mp: &str) -> Result<LoginInfo> {
    let pre = t.post("prelogin", &json!({"email": email}))?;
    let salt = dec_salt(s(&pre, "salt")?)?;
    let iter = pre.get("iter").and_then(Value::as_u64).ok_or_else(|| Error::Invalid("サーバの iter が不正です".into()))? as u32;
    let r = t.post("login", &json!({"email": email, "authHash": auth_hash(mp, &salt, iter)}))?;
    let salt = dec_salt(s(&r, "salt")?)?;
    let iter = r.get("iter").and_then(Value::as_u64).unwrap_or(iter as u64) as u32;
    let wrapped = B64.decode(s(&r, "wrappedVaultKey")?).map_err(|_| Error::Invalid("サーバの鍵が不正です".into()))?;
    Ok(LoginInfo { token: s(&r, "token")?.to_string(), salt, iter, wrapped })
}

/// この端末にまだ保管庫がないとき: サーバのアカウントでログインし、保管庫を作って参加する。
pub fn join_new_device(t: &dyn Transport, dir: &Path, email: &str, mp: &str) -> Result<(Vault, String)> {
    let li = login_raw(t, email, mp)?;
    std::fs::create_dir_all(dir)?;
    let v = Vault::join(dir, mp, li.salt, li.iter, &li.wrapped)?;
    Ok((v, li.token))
}

/// 既にある保管庫でサーバにログインする。別の端末で MP が変更されていれば、ローカルのヘッダも合わせる。
pub fn login_existing(t: &dyn Transport, vault: &mut Vault, email: &str, mp: &str) -> Result<String> {
    let li = login_raw(t, email, mp)?;
    if li.salt != vault.salt() || li.iter != vault.iterations() {
        vault.adopt_params(mp, li.salt, li.iter, &li.wrapped)?;
    }
    Ok(li.token)
}

/// ローカルで MP を変更したあとに、サーバの認証情報を更新する。
pub fn change_auth(t: &dyn Transport, vault: &Vault, token: &str, new_mp: &str) -> Result<()> {
    let m = vault.auth_material(new_mp)?;
    t.post(
        "changeAuth",
        &json!({"token": token, "newAuthHash": B64.encode(*m.auth_key), "newSalt": B64.encode(m.salt), "newIter": m.iterations, "newWrappedVaultKey": B64.encode(&m.wrapped)}),
    )?;
    Ok(())
}

pub fn logout(t: &dyn Transport, token: &str) {
    let _ = t.post("logout", &json!({"token": token}));
}

// ---------------------------------------------------------------------- 差分の同期

#[derive(Clone, Debug)]
pub struct PushItem {
    pub id: String,
    pub rev: u64,
    pub blob: String,
    pub deleted: bool,
}

#[derive(Clone, Debug)]
pub struct RemoteItem {
    pub id: String,
    pub server_rev: u64,
    pub blob: String,
    pub deleted: bool,
}

/// 送るものを決める: 前回の同期から rev が変わったアイテムと、ローカルで完全削除されたもの（墓石）。
pub fn plan_push(vault: &Vault, st: &SyncState) -> Vec<PushItem> {
    let mut out = Vec::new();
    for e in vault.entries().filter(|e| !e.corrupt) {
        if st.synced.get(&e.id) != Some(&e.rev) {
            if let Ok(bytes) = vault.read_raw(&e.id) {
                out.push(PushItem { id: e.id.clone(), rev: e.rev, blob: B64.encode(bytes), deleted: false });
            }
        }
    }
    for id in st.synced.keys() {
        if vault.local_rev(id).is_none() {
            out.push(PushItem { id: id.clone(), rev: 0, blob: String::new(), deleted: true });
        }
    }
    out
}

pub fn run_pull(t: &dyn Transport, token: &str, since: u64) -> Result<(Vec<RemoteItem>, u64)> {
    let mut all = Vec::new();
    let mut cur = since;
    loop {
        let r = t.post("pull", &json!({"token": token, "sinceRev": cur}))?;
        let head = r.get("headRev").and_then(Value::as_u64).unwrap_or(cur);
        let items = r.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let n = items.len();
        for it in items {
            let rev = it.get("rev").and_then(Value::as_u64).unwrap_or(0);
            cur = cur.max(rev);
            all.push(RemoteItem {
                id: it.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                server_rev: rev,
                blob: it.get("blob").and_then(Value::as_str).unwrap_or("").to_string(),
                deleted: it.get("deleted").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        if n < 1000 {
            return Ok((all, head));
        }
    }
}

/// 受け取ったものをローカルへ反映する。
pub fn apply_pull(vault: &mut Vault, st: &mut SyncState, items: Vec<RemoteItem>) -> Result<SyncReport> {
    let mut rep = SyncReport::default();
    vault.begin_batch();
    let res = (|| -> Result<()> {
        for r in items {
            if r.id.is_empty() {
                continue;
            }
            let local = vault.local_rev(&r.id);
            let synced = st.synced.get(&r.id).copied();
            if r.deleted {
                if let Some(lr) = local {
                    if Some(lr) == synced {
                        vault.purge_item(&r.id)?;
                        rep.purged += 1;
                    }
                    // ローカルで変更されていれば残す（次の push で復活する）
                }
                st.synced.remove(&r.id);
                continue;
            }
            let Ok(bytes) = B64.decode(&r.blob) else {
                rep.rejected += 1;
                continue;
            };
            let Some((_, remote_rev)) = raw_item_header(&bytes) else {
                rep.rejected += 1;
                continue;
            };
            // rev が同じでも、別々の端末での変更かもしれない。中身（暗号化ファイル）で同一かを判定する
            let same = local.is_some() && vault.read_raw(&r.id).map(|b| b == bytes).unwrap_or(false);
            match local {
                None if synced == Some(remote_rev) => {} // ローカルで完全削除済み（次の push で墓石を送る）
                None => {
                    if vault.write_raw(&r.id, &bytes)? {
                        st.synced.insert(r.id.clone(), remote_rev);
                        rep.pulled += 1;
                    } else {
                        rep.rejected += 1;
                    }
                }
                Some(lr) if same => {
                    st.synced.insert(r.id.clone(), lr);
                }
                Some(lr) if Some(lr) == synced => {
                    if vault.write_raw(&r.id, &bytes)? {
                        st.synced.insert(r.id.clone(), remote_rev);
                        rep.pulled += 1;
                    } else {
                        rep.rejected += 1;
                    }
                }
                Some(_) if synced == Some(remote_rev) => {} // 自分が送ったものの写し。ローカルのほうが新しい
                Some(_) => {
                    // 両方が変更された: サーバ側を別アイテムとして残す
                    match vault.decrypt_raw(&r.id, &bytes) {
                        Some(mut copy) => {
                            copy.id = uuid::Uuid::new_v4().to_string();
                            copy.name = format!("{} (競合 {})", copy.name, chrono::Local::now().format("%Y-%m-%d"));
                            copy.rev = 0;
                            if copy.kind == ItemType::Folder {
                                copy.name = format!("{}-競合", copy.name);
                            }
                            vault.save_item(&mut copy)?;
                            rep.conflicts_kept += 1;
                        }
                        None => rep.rejected += 1,
                    }
                }
            }
        }
        Ok(())
    })();
    let flush = vault.end_batch();
    res?;
    flush?;
    Ok(rep)
}

/// 送る。競合として戻された ID は送れていないので、状態を更新しない。
pub fn run_push(t: &dyn Transport, token: &str, base_rev: u64, items: &[PushItem], st: &mut SyncState) -> Result<(usize, Vec<String>)> {
    let mut pushed = 0;
    let mut conflicts = Vec::new();
    for chunk in items.chunks(PUSH_CHUNK) {
        let body: Vec<Value> = chunk.iter().map(|i| json!({"id": i.id, "rev": i.rev, "blob": i.blob, "deleted": i.deleted})).collect();
        let r = t.post("push", &json!({"token": token, "baseRev": base_rev, "items": body}))?;
        let c: Vec<String> = r.get("conflicts").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        for i in chunk {
            if c.contains(&i.id) {
                continue;
            }
            if i.deleted {
                st.synced.remove(&i.id);
            } else {
                st.synced.insert(i.id.clone(), i.rev);
            }
            pushed += 1;
        }
        conflicts.extend(c);
    }
    Ok((pushed, conflicts))
}

/// pull → 反映 → push を 1 回行う。競合で送れなかったものがあれば、もう一度だけやり直す。
pub fn sync_once(t: &dyn Transport, vault: &mut Vault, st: &mut SyncState, token: &str) -> Result<SyncReport> {
    let mut total = SyncReport::default();
    for _ in 0..2 {
        let (remote, head) = run_pull(t, token, st.last_rev)?;
        let rep = apply_pull(vault, st, remote)?;
        st.last_rev = head;
        let plan = plan_push(vault, st);
        let (pushed, conflicts) = run_push(t, token, head, &plan, st)?;
        total.pulled += rep.pulled;
        total.conflicts_kept += rep.conflicts_kept;
        total.rejected += rep.rejected;
        total.purged += rep.purged;
        total.pushed += pushed;
        if conflicts.is_empty() {
            break;
        }
    }
    Ok(total)
}
