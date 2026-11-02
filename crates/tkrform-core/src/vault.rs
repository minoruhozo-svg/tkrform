//! 保管庫（§6）。
//!
//! ```text
//! MP ──PBKDF2-HMAC-SHA256──▶ KEK ──AES-256-GCM で包む──▶ VaultKey
//! VaultKey ──HKDF(info="item")──▶ ItemKey ──AES-256-GCM(AAD=id|type|rev)──▶ items/<id>.tki
//! ```
//!
//! ファイル形式
//! - `vault.hdr`: `TKRV0001` ver(1) kdf(1) iter(u32 LE) salt(16) wrappedLen(u16 LE) wrapped tag(32)
//! - `items/<id>.tki`: `TKRI0001` type(1) rev(u64 LE) nonce(12) 暗号文
//! - `index.tkx`: `TKRX0001` nonce(12) 暗号文（インデックス JSON）

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::crypto::{self, Key, KEY_LEN, SALT_LEN};
use crate::error::{Error, Result};
use crate::fsutil;
use crate::model::{now_iso, popularity_score, Item, ItemType, MatchLevel, PwHistory, PASSWORD_HISTORY_MAX, TOUCH_DEDUP_SECS};
use crate::urlmatch;

const HDR_MAGIC: &[u8; 8] = b"TKRV0001";
const ITEM_MAGIC: &[u8; 8] = b"TKRI0001";
const IDX_MAGIC: &[u8; 8] = b"TKRX0001";
const HDR_VERSION: u8 = 1;
const KDF_PBKDF2_SHA256: u8 = 1;
const AAD_VAULTKEY: &[u8] = b"tkrv-vaultkey";
const AAD_INDEX: &[u8] = b"index";
const AAD_HISTORY: &[u8] = b"history";
const ITEM_HEADER_LEN: usize = 8 + 1 + 8;
pub const TRASH_RETENTION_DAYS: i64 = 30;
pub const GENERATED_HISTORY_MAX: usize = 20;

/// インデックスの 1 行。秘密（パスワード等）は含めない。インデックス自体も暗号化される。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemType,
    pub name: String,
    pub folder: String,
    /// 照合に使う URL（matchUrl、なければ url）
    pub url: String,
    pub match_level: MatchLevel,
    /// 照合用 URL の eTLD+1（インデックスは暗号化されているため、ハッシュ化はしない）
    pub domain: String,
    pub user: String,
    pub has_totp: bool,
    /// パスキーを持つログイン
    #[serde(default)]
    pub has_passkey: bool,
    pub modified: String,
    pub rev: u64,
    pub favorite: bool,
    pub pinned: u32,
    pub use_count: u32,
    pub last_used: Option<String>,
    #[serde(default)]
    pub use_score: f64,
    #[serde(default)]
    pub score_at: Option<String>,
    pub deleted: bool,
    pub deleted_at: Option<String>,
    /// 復号に失敗した（破損・改ざん）
    #[serde(default)]
    pub corrupt: bool,
}

impl IndexEntry {
    /// 今の時点の使用の点数（「よく使う」の並び順に使う）。
    pub fn popularity(&self, now: chrono::DateTime<chrono::Utc>) -> f64 {
        popularity_score(self.use_score, self.score_at.as_deref(), self.use_count, self.last_used.as_deref(), now)
    }

    fn from_item(it: &Item) -> IndexEntry {
        let url = it.effective_match_url().to_string();
        IndexEntry {
            id: it.id.clone(),
            kind: it.kind,
            name: it.name.clone(),
            folder: it.folder.clone(),
            domain: urlmatch::domain_of(&url).unwrap_or_default(),
            url,
            match_level: it.match_level,
            user: it.login_user().to_string(),
            has_totp: !it.totp_key.is_empty(),
            has_passkey: !it.passkeys.is_empty(),
            modified: it.modified.clone(),
            rev: it.rev,
            favorite: it.favorite,
            pinned: it.pinned,
            use_count: it.use_count,
            last_used: it.last_used.clone(),
            use_score: it.use_score,
            score_at: it.score_at.clone(),
            deleted: it.deleted,
            deleted_at: it.deleted_at.clone(),
            corrupt: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ImportReport {
    pub added: usize,
    /// 重複候補として除外した名前
    pub duplicates: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct GenHistory {
    value: String,
    at: String,
}

struct Header {
    iterations: u32,
    salt: [u8; SALT_LEN],
    wrapped: Vec<u8>,
}

fn encode_header(h: &Header, kek: &[u8; KEY_LEN]) -> Vec<u8> {
    let mut b = Vec::with_capacity(128);
    b.extend_from_slice(HDR_MAGIC);
    b.push(HDR_VERSION);
    b.push(KDF_PBKDF2_SHA256);
    b.extend_from_slice(&h.iterations.to_le_bytes());
    b.extend_from_slice(&h.salt);
    b.extend_from_slice(&(h.wrapped.len() as u16).to_le_bytes());
    b.extend_from_slice(&h.wrapped);
    let tag = crypto::hmac_sha256(&*crypto::hkdf_key(kek, b"hdr-verify"), &b);
    b.extend_from_slice(&tag);
    b
}

/// ヘッダを分解する。戻り値は (Header, タグ対象の本体, タグ)。
fn parse_header(b: &[u8]) -> Result<(Header, &[u8], &[u8])> {
    let bad = |m: &str| Error::CorruptHeader(m.to_string());
    if b.len() < 8 + 2 + 4 + SALT_LEN + 2 + 32 || &b[..8] != HDR_MAGIC {
        return Err(bad("マジックが一致しません"));
    }
    if b[8] != HDR_VERSION || b[9] != KDF_PBKDF2_SHA256 {
        return Err(bad("未対応のバージョンです"));
    }
    let iterations = u32::from_le_bytes(b[10..14].try_into().unwrap());
    if iterations == 0 {
        return Err(bad("反復回数が不正です"));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&b[14..14 + SALT_LEN]);
    let wl = u16::from_le_bytes(b[14 + SALT_LEN..16 + SALT_LEN].try_into().unwrap()) as usize;
    let body_end = 16 + SALT_LEN + wl;
    if b.len() != body_end + 32 {
        return Err(bad("長さが不正です"));
    }
    let wrapped = b[16 + SALT_LEN..body_end].to_vec();
    Ok((Header { iterations, salt, wrapped }, &b[..body_end], &b[body_end..]))
}

pub struct Vault {
    dir: PathBuf,
    header_iter: u32,
    header_salt: [u8; SALT_LEN],
    vault_key: Key,
    item_key: Key,
    index_key: Key,
    hist_key: Key,
    index: BTreeMap<String, IndexEntry>,
    dirty: bool,
    batch: bool,
}

fn hdr_path(dir: &Path) -> PathBuf {
    dir.join("vault.hdr")
}
fn items_dir(dir: &Path) -> PathBuf {
    dir.join("items")
}
fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.tkx")
}
/// パスワード履歴（と生成器の履歴）のファイル名。
pub const HISTORY_FILE: &str = "password-history.tkx";

fn history_path(dir: &Path) -> PathBuf {
    dir.join(HISTORY_FILE)
}

pub fn backups_dir(dir: &Path) -> PathBuf {
    dir.join("backups")
}

impl Vault {
    pub fn exists(dir: &Path) -> bool {
        hdr_path(dir).is_file()
    }

    /// 新しい保管庫を作る。`iterations` は通常 `crypto::DEFAULT_ITERATIONS`（テストでは小さくしてよい）。
    pub fn create(dir: &Path, mp: &str, iterations: u32) -> Result<Vault> {
        if Self::exists(dir) {
            return Err(Error::AlreadyExists);
        }
        if mp.is_empty() {
            return Err(Error::Invalid("マスターパスワードが空です".into()));
        }
        fs::create_dir_all(items_dir(dir))?;
        let salt = crypto::random_bytes::<SALT_LEN>();
        let kek = crypto::derive_kek(mp.as_bytes(), &salt, iterations);
        let vault_key: Key = Zeroizing::new(crypto::random_bytes::<KEY_LEN>());
        let wrapped = crypto::seal(&kek, AAD_VAULTKEY, &*vault_key);
        let h = Header { iterations, salt, wrapped };
        fsutil::write_atomic(&hdr_path(dir), &encode_header(&h, &kek))?;
        let mut v = Self::from_keys(dir, iterations, salt, vault_key);
        v.dirty = true;
        v.flush_index()?;
        Ok(v)
    }

    fn from_keys(dir: &Path, iter: u32, salt: [u8; SALT_LEN], vault_key: Key) -> Vault {
        let item_key = crypto::hkdf_key(&*vault_key, b"item");
        let index_key = crypto::hkdf_key(&*vault_key, b"index");
        let hist_key = crypto::hkdf_key(&*vault_key, b"history");
        Vault {
            dir: dir.to_path_buf(),
            header_iter: iter,
            header_salt: salt,
            vault_key,
            item_key,
            index_key,
            hist_key,
            index: BTreeMap::new(),
            dirty: false,
            batch: false,
        }
    }

    fn read_header(dir: &Path) -> Result<Vec<u8>> {
        match fs::read(hdr_path(dir)) {
            Ok(b) => Ok(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Error::NoVault),
            Err(e) => Err(e.into()),
        }
    }

    /// MP から KEK を求める（DPAPI での端末保護用に外へ出せる）。
    pub fn derive_kek_for(dir: &Path, mp: &str) -> Result<Key> {
        let raw = Self::read_header(dir)?;
        let (h, _, _) = parse_header(&raw)?;
        Ok(crypto::derive_kek(mp.as_bytes(), &h.salt, h.iterations))
    }

    pub fn open(dir: &Path, mp: &str) -> Result<Vault> {
        let kek = Self::derive_kek_for(dir, mp)?;
        Self::open_with_kek(dir, &kek)
    }

    pub fn open_with_kek(dir: &Path, kek: &[u8; KEY_LEN]) -> Result<Vault> {
        let raw = Self::read_header(dir)?;
        let (h, body, tag) = parse_header(&raw)?;
        let expect = crypto::hmac_sha256(&*crypto::hkdf_key(kek, b"hdr-verify"), body);
        if !bool::from(expect.ct_eq(tag)) {
            return Err(Error::BadPassword);
        }
        let vk = crypto::open(kek, AAD_VAULTKEY, &h.wrapped).map_err(|_| Error::BadPassword)?;
        if vk.len() != KEY_LEN {
            return Err(Error::CorruptHeader("VaultKey の長さが不正です".into()));
        }
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&vk);
        let mut v = Self::from_keys(dir, h.iterations, h.salt, key);
        fsutil::cleanup_stale_tmp(dir);
        fsutil::cleanup_stale_tmp(&items_dir(dir));
        v.load_index()?;
        Ok(v)
    }

    /// 再認証用（エクスポート・印刷の前）。
    pub fn verify_password(&self, mp: &str) -> bool {
        matches!(Self::derive_kek_for(&self.dir, mp).and_then(|k| {
            let raw = Self::read_header(&self.dir)?;
            let (_, body, tag) = parse_header(&raw)?;
            let expect = crypto::hmac_sha256(&*crypto::hkdf_key(&*k, b"hdr-verify"), body);
            Ok(bool::from(expect.ct_eq(tag)))
        }), Ok(true))
    }

    /// MP の変更。VaultKey は変えず包み直すだけなので、アイテムの再暗号化は不要。
    pub fn change_password(&mut self, old: &str, new: &str, iterations: u32) -> Result<()> {
        if !self.verify_password(old) {
            return Err(Error::BadPassword);
        }
        if new.is_empty() {
            return Err(Error::Invalid("マスターパスワードが空です".into()));
        }
        let salt = crypto::random_bytes::<SALT_LEN>();
        let kek = crypto::derive_kek(new.as_bytes(), &salt, iterations);
        let wrapped = crypto::seal(&kek, AAD_VAULTKEY, &*self.vault_key);
        let h = Header { iterations, salt, wrapped };
        fsutil::write_atomic(&hdr_path(&self.dir), &encode_header(&h, &kek))?;
        self.header_iter = iterations;
        self.header_salt = salt;
        Ok(())
    }

    pub fn iterations(&self) -> u32 {
        self.header_iter
    }

    pub fn salt(&self) -> [u8; SALT_LEN] {
        self.header_salt
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 同期用に VaultKey を KEK で包んだ blob を返す（§15）。
    pub fn wrapped_vault_key(&self, kek: &[u8; KEY_LEN]) -> Vec<u8> {
        crypto::seal(kek, AAD_VAULTKEY, &*self.vault_key)
    }

    // ------------------------------------------------------------------ アイテム

    fn item_path(&self, id: &str) -> PathBuf {
        items_dir(&self.dir).join(format!("{id}.tki"))
    }

    fn aad(id: &str, kind: u8, rev: u64) -> Vec<u8> {
        format!("{id}|{kind}|{rev}").into_bytes()
    }

    fn read_item_file(&self, id: &str) -> Result<Item> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Invalid("ID が不正です".into()));
        }
        let bytes = match fs::read(self.item_path(id)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotFound(id.to_string())),
            Err(e) => return Err(e.into()),
        };
        let corrupt = || Error::CorruptItem(id.to_string());
        if bytes.len() < ITEM_HEADER_LEN || &bytes[..8] != ITEM_MAGIC {
            return Err(corrupt());
        }
        let kind = bytes[8];
        let rev = u64::from_le_bytes(bytes[9..17].try_into().unwrap());
        let plain = crypto::open(&self.item_key, &Self::aad(id, kind, rev), &bytes[ITEM_HEADER_LEN..]).map_err(|_| corrupt())?;
        let item: Item = serde_json::from_slice(&plain).map_err(|_| corrupt())?;
        if item.id != id || item.rev != rev || item.kind as u8 != kind {
            return Err(corrupt());
        }
        Ok(item)
    }

    /// アイテムを読む。破損していれば `CorruptItem` を返し、インデックス上も「破損」にする。
    pub fn get_item(&mut self, id: &str) -> Result<Item> {
        match self.read_item_file(id) {
            Ok(it) => Ok(it),
            Err(Error::CorruptItem(i)) => {
                if let Some(e) = self.index.get_mut(&i) {
                    e.corrupt = true;
                }
                Err(Error::CorruptItem(i))
            }
            Err(e) => Err(e),
        }
    }

    fn write_item(&mut self, item: &Item) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(item)?);
        let kind = item.kind as u8;
        let sealed = crypto::seal(&self.item_key, &Self::aad(&item.id, kind, item.rev), &plain);
        let mut file = Vec::with_capacity(ITEM_HEADER_LEN + sealed.len());
        file.extend_from_slice(ITEM_MAGIC);
        file.push(kind);
        file.extend_from_slice(&item.rev.to_le_bytes());
        file.extend_from_slice(&sealed);
        fsutil::write_atomic(&self.item_path(&item.id), &file)?;
        self.index.insert(item.id.clone(), IndexEntry::from_item(item));
        self.dirty = true;
        self.flush_index_unless_batch()
    }

    /// 保存する。`rev` は単調増加させ、`modified` を更新する。
    /// ログインのパスワードが変わっていれば、旧パスワードを履歴（最大 20 件）に積む。
    pub fn save_item(&mut self, item: &mut Item) -> Result<()> {
        item.validate()?;
        let prev = match self.read_item_file(&item.id) {
            Ok(p) => Some(p),
            Err(Error::NotFound(_)) | Err(Error::CorruptItem(_)) => None,
            Err(e) => return Err(e),
        };
        let idx_rev = self.index.get(&item.id).map(|e| e.rev).unwrap_or(0);
        item.rev = item.rev.max(prev.as_ref().map(|p| p.rev).unwrap_or(0)).max(idx_rev) + 1;
        item.modified = now_iso();
        if let Some(p) = &prev {
            item.created = p.created.clone();
            if item.kind == ItemType::Login {
                let mut hist = p.password_history.clone();
                let old = p.login_password();
                if !old.is_empty() && old != item.login_password() {
                    hist.push(PwHistory { value: old.to_string(), changed: item.modified.clone() });
                }
                if hist.len() > PASSWORD_HISTORY_MAX {
                    let cut = hist.len() - PASSWORD_HISTORY_MAX;
                    hist.drain(..cut);
                }
                item.password_history = hist;
            }
        }
        self.write_item(item)
    }

    /// ゴミ箱へ移す（30 日保持）。
    pub fn delete_item(&mut self, id: &str) -> Result<()> {
        let mut it = self.get_item(id)?;
        it.deleted = true;
        it.deleted_at = Some(now_iso());
        self.save_item(&mut it)
    }

    pub fn restore_item(&mut self, id: &str) -> Result<()> {
        let mut it = self.get_item(id)?;
        it.deleted = false;
        it.deleted_at = None;
        self.save_item(&mut it)
    }

    /// 完全削除。**呼び出し側は必ず確認 UI を経ること**（§10.2 / §21-7）。
    pub fn purge_item(&mut self, id: &str) -> Result<()> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Invalid("ID が不正です".into()));
        }
        match fs::remove_file(self.item_path(id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.index.remove(id);
        self.dirty = true;
        self.flush_index_unless_batch()
    }

    /// 保持期間（30 日）を過ぎたゴミ箱のアイテムの ID を返す。削除は呼び出し側が行う。
    pub fn expired_trash(&self) -> Vec<String> {
        let limit = chrono::Utc::now() - chrono::Duration::days(TRASH_RETENTION_DAYS);
        self.index
            .values()
            .filter(|e| e.deleted)
            .filter(|e| {
                e.deleted_at
                    .as_deref()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d < limit)
                    .unwrap_or(false)
            })
            .map(|e| e.id.clone())
            .collect()
    }

    /// 使用を記録する（使用回数・最終使用日時・使用の点数）。
    /// 点数は「前の点数を今まで減衰させたもの + 1」。直前（`TOUCH_DEDUP_SECS` 秒以内）にも記録していれば、1 回とみなして何もしない。
    pub fn touch(&mut self, id: &str) -> Result<()> {
        self.touch_at(id, chrono::Utc::now())
    }

    /// `touch` の、時刻を指定できる版（テスト用）。
    pub fn touch_at(&mut self, id: &str, now: chrono::DateTime<chrono::Utc>) -> Result<()> {
        let mut it = self.get_item(id)?;
        let recent = it
            .last_used
            .as_deref()
            .and_then(|l| chrono::DateTime::parse_from_rfc3339(l).ok())
            .map(|l| (now - l.with_timezone(&chrono::Utc)).num_seconds())
            .is_some_and(|d| (0..TOUCH_DEDUP_SECS).contains(&d));
        if recent {
            return Ok(());
        }
        let prev = popularity_score(it.use_score, it.score_at.as_deref(), it.use_count, it.last_used.as_deref(), now);
        let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        it.use_score = prev + 1.0;
        it.score_at = Some(stamp.clone());
        it.use_count = it.use_count.saturating_add(1);
        it.last_used = Some(stamp);
        self.save_item(&mut it)
    }

    // ------------------------------------------------------------------ 一覧・検索・照合

    pub fn entries(&self) -> impl Iterator<Item = &IndexEntry> {
        self.index.values()
    }

    pub fn entry(&self, id: &str) -> Option<&IndexEntry> {
        self.index.get(id)
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// フォルダのパス一覧（フォルダ項目 + アイテムが使うフォルダ + その親）。
    pub fn folders(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for e in self.index.values().filter(|e| !e.deleted) {
            let path = if e.kind == ItemType::Folder { crate::model::join_folder(&e.folder, &e.name) } else { e.folder.clone() };
            let mut cur = String::new();
            for part in path.split('/').filter(|p| !p.is_empty()) {
                cur.push('/');
                cur.push_str(part);
                set.insert(cur.clone());
            }
        }
        set.into_iter().collect()
    }

    /// 名前・URL・ユーザー ID・フォルダのインクリメンタル検索。
    pub fn search(&self, q: &str, types: &[ItemType], limit: usize) -> Vec<&IndexEntry> {
        let q = q.trim().to_lowercase();
        let mut hits: Vec<(u8, &IndexEntry)> = Vec::new();
        for e in self.index.values() {
            if e.deleted || e.kind == ItemType::Folder || (!types.is_empty() && !types.contains(&e.kind)) {
                continue;
            }
            let rank = if q.is_empty() {
                2
            } else {
                let name = e.name.to_lowercase();
                if name.starts_with(&q) {
                    0
                } else if name.contains(&q) {
                    1
                } else if e.user.to_lowercase().contains(&q) || e.url.to_lowercase().contains(&q) || e.folder.to_lowercase().contains(&q) {
                    2
                } else {
                    continue;
                }
            };
            hits.push((rank, e));
        }
        sort_by_popularity(&mut hits, chrono::Utc::now());
        hits.into_iter().take(limit).map(|(_, e)| e).collect()
    }

    /// URL に一致するログインを、お気に入り → 使用の点数（最近の使用ほど重い）→ 最終使用日時 → 名前の順で返す（§8.2）。
    pub fn match_logins(&self, url: &str, equiv: &[Vec<String>]) -> Vec<&IndexEntry> {
        let Some(dom) = urlmatch::domain_of(url) else {
            return Vec::new();
        };
        let canon = urlmatch::canonical_domain(&dom, equiv);
        let v: Vec<&IndexEntry> = self
            .index
            .values()
            .filter(|e| e.kind == ItemType::Login && !e.deleted && !e.corrupt && !e.url.is_empty())
            .filter(|e| urlmatch::canonical_domain(&e.domain, equiv) == canon)
            .filter(|e| urlmatch::url_matches(url, &e.url, e.match_level, equiv))
            .collect();
        let mut ranked: Vec<(u8, &IndexEntry)> = v.into_iter().map(|e| (0, e)).collect();
        sort_by_popularity(&mut ranked, chrono::Utc::now());
        ranked.into_iter().map(|(_, e)| e).collect()
    }

    // ------------------------------------------------------------------ インデックス

    pub fn begin_batch(&mut self) {
        self.batch = true;
    }

    pub fn end_batch(&mut self) -> Result<()> {
        self.batch = false;
        self.flush_index()
    }

    fn flush_index_unless_batch(&mut self) -> Result<()> {
        if self.batch {
            Ok(())
        } else {
            self.flush_index()
        }
    }

    pub fn flush_index(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let entries: Vec<&IndexEntry> = self.index.values().collect();
        let plain = Zeroizing::new(serde_json::to_vec(&entries)?);
        let sealed = crypto::seal(&self.index_key, AAD_INDEX, &plain);
        let mut file = IDX_MAGIC.to_vec();
        file.extend_from_slice(&sealed);
        fsutil::write_atomic(&index_path(&self.dir), &file)?;
        self.dirty = false;
        Ok(())
    }

    fn item_files(&self) -> Vec<(String, Option<std::time::SystemTime>)> {
        let mut v = Vec::new();
        if let Ok(rd) = fs::read_dir(items_dir(&self.dir)) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(id) = name.strip_suffix(".tki") {
                    let m = e.metadata().ok().and_then(|m| m.modified().ok());
                    v.push((id.to_string(), m));
                }
            }
        }
        v
    }

    /// 起動時にインデックスを読み込む。壊れている・古い（アイテムが新しい）・件数が合わないときは作り直す。
    fn load_index(&mut self) -> Result<()> {
        let files = self.item_files();
        let idx_mtime = fs::metadata(index_path(&self.dir)).and_then(|m| m.modified()).ok();
        let loaded: Option<BTreeMap<String, IndexEntry>> = fs::read(index_path(&self.dir)).ok().and_then(|b| {
            if b.len() < 8 || &b[..8] != IDX_MAGIC {
                return None;
            }
            let plain = crypto::open(&self.index_key, AAD_INDEX, &b[8..]).ok()?;
            let list: Vec<IndexEntry> = serde_json::from_slice(&plain).ok()?;
            Some(list.into_iter().map(|e| (e.id.clone(), e)).collect())
        });
        let usable = match (&loaded, idx_mtime) {
            (Some(map), Some(im)) => {
                let ids: HashSet<&str> = files.iter().map(|(i, _)| i.as_str()).collect();
                map.len() == ids.len()
                    && map.keys().all(|k| ids.contains(k.as_str()))
                    && files.iter().all(|(_, m)| m.map(|m| m <= im).unwrap_or(true))
            }
            _ => false,
        };
        if usable {
            self.index = loaded.unwrap_or_default();
            Ok(())
        } else {
            self.rebuild_index()
        }
    }

    /// `items/` から索引を作り直す。復号できないアイテムは「破損」として載せる。
    pub fn rebuild_index(&mut self) -> Result<()> {
        let mut map = BTreeMap::new();
        for (id, _) in self.item_files() {
            match self.read_item_file(&id) {
                Ok(it) => {
                    map.insert(id, IndexEntry::from_item(&it));
                }
                Err(Error::CorruptItem(_)) | Err(Error::Invalid(_)) => {
                    map.insert(id.clone(), self.corrupt_entry(&id));
                }
                Err(Error::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        self.index = map;
        self.dirty = true;
        self.flush_index()
    }

    fn corrupt_entry(&self, id: &str) -> IndexEntry {
        let kind = fs::read(self.item_path(id))
            .ok()
            .and_then(|b| if b.len() > 8 { ItemType::from_u8(b[8]) } else { None })
            .unwrap_or(ItemType::Login);
        let short: String = id.chars().take(8).collect();
        IndexEntry {
            id: id.to_string(),
            kind,
            name: format!("(破損) {short}"),
            folder: "/".into(),
            url: String::new(),
            match_level: MatchLevel::Domain,
            domain: String::new(),
            user: String::new(),
            has_totp: false,
            has_passkey: false,
            modified: String::new(),
            rev: 0,
            favorite: false,
            pinned: 0,
            use_count: 0,
            last_used: None,
            use_score: 0.0,
            score_at: None,
            deleted: false,
            deleted_at: None,
            corrupt: true,
        }
    }

    /// 全アイテムを復号して整合性を確認する。破損した ID の一覧を返し、インデックスにも反映する。
    pub fn check_integrity(&mut self) -> Result<Vec<String>> {
        let ids: Vec<String> = self.item_files().into_iter().map(|(i, _)| i).collect();
        let mut bad = Vec::new();
        for id in ids {
            match self.read_item_file(&id) {
                Ok(it) => {
                    let mut e = IndexEntry::from_item(&it);
                    e.corrupt = false;
                    self.index.insert(id, e);
                }
                Err(Error::CorruptItem(_)) => {
                    let e = match self.index.get(&id) {
                        Some(old) => IndexEntry { corrupt: true, ..old.clone() },
                        None => self.corrupt_entry(&id),
                    };
                    self.index.insert(id.clone(), e);
                    bad.push(id);
                }
                Err(Error::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        self.dirty = true;
        self.flush_index()?;
        Ok(bad)
    }

    // ------------------------------------------------------------------ 生成履歴

    fn read_gen_history(&self) -> Vec<GenHistory> {
        fs::read(history_path(&self.dir))
            .ok()
            .and_then(|b| crypto::open(&self.hist_key, AAD_HISTORY, &b).ok())
            .and_then(|p| serde_json::from_slice(&p).ok())
            .unwrap_or_default()
    }

    fn write_gen_history(&self, h: &[GenHistory]) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(h)?);
        fsutil::write_atomic(&history_path(&self.dir), &crypto::seal(&self.hist_key, AAD_HISTORY, &plain))?;
        Ok(())
    }

    /// 生成したパスワードを履歴に積む（直近 20 件、暗号化して保存）。
    pub fn push_generated(&mut self, pw: &str) -> Result<()> {
        let mut h = self.read_gen_history();
        h.insert(0, GenHistory { value: pw.to_string(), at: now_iso() });
        h.truncate(GENERATED_HISTORY_MAX);
        self.write_gen_history(&h)
    }

    pub fn generated_history(&self) -> Vec<(String, String)> {
        self.read_gen_history().into_iter().map(|g| (g.value, g.at)).collect()
    }

    pub fn clear_generated_history(&mut self) -> Result<()> {
        self.write_gen_history(&[])
    }

    // ------------------------------------------------------------------ インポート

    /// 既存ログインとの重複判定キー（同じ URL と ID）。
    fn dup_key(url: &str, user: &str) -> String {
        match urlmatch::parse(url) {
            Some(p) => format!("{}{}|{}", p.host, p.path, user),
            None => format!("{url}|{user}"),
        }
    }

    /// 取り込む。`skip_duplicates` が真なら、同じ URL と ID の既存ログインがあるものは追加しない。
    pub fn import_items(&mut self, items: Vec<Item>, skip_duplicates: bool) -> Result<ImportReport> {
        let mut existing: HashSet<String> = self
            .index
            .values()
            .filter(|e| e.kind == ItemType::Login && !e.deleted)
            .map(|e| Self::dup_key(&e.url, &e.user))
            .collect();
        let mut report = ImportReport::default();
        self.begin_batch();
        let result = (|| -> Result<()> {
            for mut it in items {
                if it.kind == ItemType::Login {
                    let k = Self::dup_key(it.effective_match_url(), it.login_user());
                    if skip_duplicates && existing.contains(&k) {
                        report.duplicates.push(it.name.clone());
                        continue;
                    }
                    existing.insert(k);
                }
                self.save_item(&mut it)?;
                report.added += 1;
            }
            Ok(())
        })();
        let flush = self.end_batch();
        result?;
        flush?;
        Ok(report)
    }

    // ------------------------------------------------------------------ バックアップ

    pub fn backup_now(&mut self) -> Result<PathBuf> {
        self.flush_index()?;
        make_backup(&self.dir)
    }

    /// 保存先を指定して今すぐバックアップする。
    pub fn backup_now_in(&mut self, target: &Path) -> Result<PathBuf> {
        self.flush_index()?;
        make_backup_in(&self.dir, target)
    }
}

/// 「よく使う」の並び: お気に入りが先頭。その中と、それ以外の中を、使用の点数（今の時点まで減衰させたもの）の高い順、
/// 同じなら最終使用日時の新しい順、次に名前順。
/// 並べ替えの前に、項目ごとの点数（日時の解析を伴う）と小文字の名前を 1 回だけ作り、その値で比べる
/// （比較のたびに計算すると、1 万件で数十万回の日時の解析になる）。rank が小さいものが先。
fn sort_by_popularity(items: &mut Vec<(u8, &IndexEntry)>, now: chrono::DateTime<chrono::Utc>) {
    let mut keyed: Vec<(u8, f64, String, &IndexEntry)> =
        items.drain(..).map(|(rank, e)| (rank, e.popularity(now), e.name.to_lowercase(), e)).collect();
    keyed.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.3.favorite.cmp(&a.3.favorite))
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| b.3.last_used.cmp(&a.3.last_used))
            .then_with(|| a.2.cmp(&b.2))
    });
    items.extend(keyed.into_iter().map(|(rank, _, _, e)| (rank, e)));
}

// ---------------------------------------------------------------------- バックアップ（ZIP）

fn backup_members(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut v = Vec::new();
    for name in ["vault.hdr", HISTORY_FILE, "preferences.json"] {
        let p = dir.join(name);
        if p.is_file() {
            v.push((name.to_string(), p));
        }
    }
    if let Ok(rd) = fs::read_dir(items_dir(dir)) {
        let mut items: Vec<_> = rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tki")).collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            v.push((format!("items/{}", e.file_name().to_string_lossy()), e.path()));
        }
    }
    v
}

/// 保管庫一式（暗号化済みのまま）を ZIP にして `dest` へ書く。
pub fn write_backup_zip(dir: &Path, dest: &Path) -> Result<()> {
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, path) in backup_members(dir) {
            zw.start_file(name, opts)?;
            zw.write_all(&fs::read(path)?)?;
        }
        zw.finish()?;
    }
    fsutil::write_atomic(dest, &buf)?;
    Ok(())
}

/// `backups/yyyyMMdd-HHmmss.tkb` を既定の保存先に作る。
pub fn make_backup(dir: &Path) -> Result<PathBuf> {
    make_backup_in(dir, &backups_dir(dir))
}

/// tkrform が作るバックアップのファイル名か（`yyyyMMdd-HHmmss.tkb`、同じ秒の重複は `-N` が付く）。
/// 世代の整理と一覧は、この規則に合うファイルだけを対象にする（利用者が選んだ共有フォルダの無関係なファイルに触れないため）。
pub fn is_backup_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tkb") else { return false };
    let (main, dup) = match stem.split_once('-') {
        Some((d, rest)) => match rest.split_once('-') {
            Some((t, n)) => (format!("{d}-{t}"), Some(n)),
            None => (stem.to_string(), None),
        },
        None => return false,
    };
    let ok_main = main.len() == 15 && main.as_bytes()[8] == b'-' && main.bytes().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit());
    ok_main && dup.map(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())).unwrap_or(true)
}

/// バックアップの保存先として使えるか確かめる（設定で変えるとき）。
/// 存在するフォルダで、書き込めて（試しに一時ファイルを書いて、自分で消す）、保管庫のフォルダの中ではないこと。
pub fn validate_backup_dir(vault_dir: &Path, target: &Path) -> Result<()> {
    if target.as_os_str().is_empty() || !target.is_absolute() {
        return Err(Error::Invalid("保存先は、ドライブ名から始まるフォルダを指定してください".into()));
    }
    let md = fs::metadata(target).map_err(|_| Error::Invalid("保存先のフォルダが見つかりません（ドライブが接続されているか確認してください）".into()))?;
    if !md.is_dir() {
        return Err(Error::Invalid("保存先にはフォルダを指定してください".into()));
    }
    let t = fs::canonicalize(target)?;
    let v = fs::canonicalize(vault_dir).unwrap_or_else(|_| vault_dir.to_path_buf());
    if t.starts_with(&v) {
        return Err(Error::Invalid("保管庫のフォルダの中は保存先にできません".into()));
    }
    let probe = target.join(format!(".tkrform-write-test-{}", uuid::Uuid::new_v4()));
    match fs::write(&probe, b"x") {
        Ok(()) => {
            let _ = fs::remove_file(&probe); // 消すのは、いま自分が作った一時ファイルだけ
            Ok(())
        }
        Err(_) => Err(Error::Invalid("保存先のフォルダに書き込めません".into())),
    }
}

/// `target` に `yyyyMMdd-HHmmss.tkb` を作る（フォルダがなければ、既定の保存先のときだけ呼び出し側で作る）。
pub fn make_backup_in(dir: &Path, target: &Path) -> Result<PathBuf> {
    let bdir = target.to_path_buf();
    if bdir == backups_dir(dir) {
        fs::create_dir_all(&bdir)?;
    } else if !bdir.is_dir() {
        return Err(Error::Invalid("バックアップの保存先が見つかりません".into()));
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dest = bdir.join(format!("{stamp}.tkb"));
    let mut n = 1;
    while dest.exists() {
        dest = bdir.join(format!("{stamp}-{n}.tkb"));
        n += 1;
    }
    write_backup_zip(dir, &dest)?;
    Ok(dest)
}

/// 既定の保存先のバックアップ一覧（新しい順）。
pub fn list_backups(dir: &Path) -> Vec<PathBuf> {
    list_backups_in(&backups_dir(dir))
}

/// `target` の中の、tkrform が作った名前のバックアップ（新しい順）。サブフォルダと、規則に合わないファイルは対象外。
pub fn list_backups_in(target: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(target)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| is_backup_name(&e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.reverse();
    v
}

/// 古い世代を削除して `keep` 世代に収める。削除した数を返す（自動バックアップの世代管理）。
pub fn prune_backups(dir: &Path, keep: usize) -> usize {
    prune_backups_in(&backups_dir(dir), keep)
}

/// `target` の中で、tkrform が作った名前のバックアップだけを対象に世代を整理する。ほかのファイルやサブフォルダには触れない。
pub fn prune_backups_in(target: &Path, keep: usize) -> usize {
    let mut n = 0;
    for p in list_backups_in(target).into_iter().skip(keep) {
        if fs::remove_file(p).is_ok() {
            n += 1;
        }
    }
    n
}

/// 今日すでに自動バックアップがあるか（既定の保存先）。
pub fn has_backup_today(dir: &Path) -> bool {
    has_backup_today_in(&backups_dir(dir))
}

pub fn has_backup_today_in(target: &Path) -> bool {
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    list_backups_in(target).iter().any(|p| p.file_name().map(|n| n.to_string_lossy().starts_with(&today)).unwrap_or(false))
}

/// バックアップ（.tkb）から復元する。**呼び出し側は必ず確認 UI を経ること。**
/// 現在の内容は先に `backups/` へ退避する。復元後は索引を作り直す必要があるため `index.tkx` を消す。
pub fn restore_backup(dir: &Path, tkb: &Path) -> Result<()> {
    let data = fs::read(tkb)?;
    let mut za = zip::ZipArchive::new(std::io::Cursor::new(data))?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..za.len() {
        let mut f = za.by_index(i)?;
        let name = f.name().to_string();
        let ok = name == "vault.hdr"
            || name == HISTORY_FILE
            || name == "preferences.json"
            || (name.starts_with("items/") && name.ends_with(".tki") && !name[6..].contains(['/', '\\']) && !name.contains(".."));
        if !ok {
            return Err(Error::Invalid(format!("バックアップに不正なエントリがあります: {name}")));
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        entries.push((name, buf));
    }
    let hdr = entries.iter().find(|(n, _)| n == "vault.hdr").ok_or_else(|| Error::Invalid("vault.hdr がありません".into()))?;
    parse_header(&hdr.1)?;
    if Vault::exists(dir) {
        make_backup(dir)?;
    }
    // 現在の items を入れ替える（確認 UI 済みの前提）
    let idir = items_dir(dir);
    if idir.exists() {
        fs::remove_dir_all(&idir)?;
    }
    fs::create_dir_all(&idir)?;
    for (name, bytes) in &entries {
        fsutil::write_atomic(&dir.join(name), bytes)?;
    }
    let _ = fs::remove_file(index_path(dir));
    Ok(())
}

impl Vault {
    /// 全アイテムを復号して返す（エクスポート・セキュリティ検査用）。破損したものは ID を別に返す。
    pub fn load_all(&mut self, include_deleted: bool) -> Result<(Vec<Item>, Vec<String>)> {
        let ids: Vec<String> = self.index.values().filter(|e| include_deleted || !e.deleted).map(|e| e.id.clone()).collect();
        let mut items = Vec::with_capacity(ids.len());
        let mut bad = Vec::new();
        for id in ids {
            match self.get_item(&id) {
                Ok(it) => items.push(it),
                Err(Error::CorruptItem(i)) => bad.push(i),
                Err(Error::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok((items, bad))
    }
}

// ---------------------------------------------------------------------- 同期用の下回り（§15）

/// サーバへ渡す認証情報。サーバは salt・反復回数・包んだ VaultKey・認証ハッシュだけを持つ。
pub struct AuthMaterial {
    pub salt: [u8; SALT_LEN],
    pub iterations: u32,
    /// HKDF(PBKDF2(MP), "auth")。サーバは password_hash() で保存する
    pub auth_key: Key,
    /// KEK で包んだ VaultKey
    pub wrapped: Vec<u8>,
}

/// ファイル先頭の平文ヘッダから (type, rev) を読む。
pub fn raw_item_header(bytes: &[u8]) -> Option<(u8, u64)> {
    if bytes.len() < ITEM_HEADER_LEN + crypto::NONCE_LEN + crypto::TAG_LEN || &bytes[..8] != ITEM_MAGIC {
        return None;
    }
    Some((bytes[8], u64::from_le_bytes(bytes[9..17].try_into().ok()?)))
}

impl Vault {
    /// 同期サーバ用の認証情報（MP の再入力が必要）。
    pub fn auth_material(&self, mp: &str) -> Result<AuthMaterial> {
        if !self.verify_password(mp) {
            return Err(Error::BadPassword);
        }
        let kek = crypto::derive_kek(mp.as_bytes(), &self.header_salt, self.header_iter);
        Ok(AuthMaterial {
            salt: self.header_salt,
            iterations: self.header_iter,
            auth_key: crypto::hkdf_key(&*kek, b"auth"),
            wrapped: crypto::seal(&kek, AAD_VAULTKEY, &*self.vault_key),
        })
    }

    /// 別の端末で作られた保管庫に参加する。サーバが持つ salt・反復回数・包んだ VaultKey から、ローカルの保管庫を作る。
    pub fn join(dir: &Path, mp: &str, salt: [u8; SALT_LEN], iterations: u32, wrapped: &[u8]) -> Result<Vault> {
        if Self::exists(dir) {
            return Err(Error::AlreadyExists);
        }
        let kek = crypto::derive_kek(mp.as_bytes(), &salt, iterations);
        let vk = crypto::open(&kek, AAD_VAULTKEY, wrapped).map_err(|_| Error::BadPassword)?;
        if vk.len() != KEY_LEN {
            return Err(Error::CorruptHeader("VaultKey の長さが不正です".into()));
        }
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&vk);
        fs::create_dir_all(items_dir(dir))?;
        let h = Header { iterations, salt, wrapped: wrapped.to_vec() };
        fsutil::write_atomic(&hdr_path(dir), &encode_header(&h, &kek))?;
        let mut v = Self::from_keys(dir, iterations, salt, key);
        v.dirty = true;
        v.flush_index()?;
        Ok(v)
    }

    /// サーバ側の（別端末で変更された）MP のパラメータに、ローカルのヘッダを合わせる。
    /// `wrapped` を新しい MP で開いて VaultKey が一致することを確かめてから書き換える。
    pub fn adopt_params(&mut self, mp: &str, salt: [u8; SALT_LEN], iterations: u32, wrapped: &[u8]) -> Result<()> {
        let kek = crypto::derive_kek(mp.as_bytes(), &salt, iterations);
        let vk = crypto::open(&kek, AAD_VAULTKEY, wrapped).map_err(|_| Error::BadPassword)?;
        if vk.as_slice() != &self.vault_key[..] {
            return Err(Error::Invalid("サーバの保管庫鍵がこの保管庫と一致しません".into()));
        }
        let h = Header { iterations, salt, wrapped: wrapped.to_vec() };
        fsutil::write_atomic(&hdr_path(&self.dir), &encode_header(&h, &kek))?;
        self.header_iter = iterations;
        self.header_salt = salt;
        Ok(())
    }

    pub fn item_ids(&self) -> Vec<String> {
        self.index.keys().cloned().collect()
    }

    /// 暗号化済みのアイテムファイルをそのまま読む（サーバへ送る blob）。
    pub fn read_raw(&self, id: &str) -> Result<Vec<u8>> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Invalid("ID が不正です".into()));
        }
        Ok(fs::read(self.item_path(id))?)
    }

    /// サーバから受け取った blob を検証して書き込む。復号できない（鍵違い・改変・ID 違い）ものは拒否して `Ok(false)`。
    pub fn write_raw(&mut self, id: &str, bytes: &[u8]) -> Result<bool> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Ok(false);
        }
        let Some((kind, rev)) = raw_item_header(bytes) else { return Ok(false) };
        let Ok(plain) = crypto::open(&self.item_key, &Self::aad(id, kind, rev), &bytes[ITEM_HEADER_LEN..]) else { return Ok(false) };
        let Ok(item) = serde_json::from_slice::<Item>(&plain) else { return Ok(false) };
        if item.id != id || item.rev != rev || item.kind as u8 != kind {
            return Ok(false);
        }
        fsutil::write_atomic(&self.item_path(id), bytes)?;
        self.index.insert(id.to_string(), IndexEntry::from_item(&item));
        self.dirty = true;
        self.flush_index_unless_batch()?;
        Ok(true)
    }

    /// 完全削除の同期（墓石）用に、索引にあるアイテムの rev を返す。
    pub fn local_rev(&self, id: &str) -> Option<u64> {
        self.index.get(id).map(|e| e.rev)
    }
}

impl Vault {
    /// 同期で受け取った blob を復号して中身を見る（競合時に「両方残す」ため）。書き込みはしない。
    pub fn decrypt_raw(&self, id: &str, bytes: &[u8]) -> Option<Item> {
        let (kind, rev) = raw_item_header(bytes)?;
        let plain = crypto::open(&self.item_key, &Self::aad(id, kind, rev), &bytes[ITEM_HEADER_LEN..]).ok()?;
        let item: Item = serde_json::from_slice(&plain).ok()?;
        (item.id == id && item.rev == rev).then_some(item)
    }
}

// ---------------------------------------------------------------------- フォルダの移動

fn path_in(path: &str, base: &str) -> bool {
    path == base || path.starts_with(&format!("{}/", base.trim_end_matches('/')))
}

impl Vault {
    /// フォルダ `path` を、フォルダ `to` の中へ移す。配下の全アイテム（サブフォルダ・フォルダ項目・ごみ箱のものを含む）の
    /// `folder` を付け替える（rev が上がる）。移動後のパスを返す。
    ///
    /// 拒否: ルートの移動、自分自身や子孫への移動、移動先に同じ名前のフォルダがある場合。
    pub fn move_folder(&mut self, path: &str, to: &str) -> Result<String> {
        let bad = |m: &str| Error::Invalid(m.to_string());
        if path == "/" || path.is_empty() || !path.starts_with('/') || !to.starts_with('/') {
            return Err(bad("このフォルダは移動できません"));
        }
        if path_in(to, path) {
            return Err(bad("フォルダを自分自身やその中へは移動できません"));
        }
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        let new = crate::model::join_folder(to, &name);
        if new == path {
            return Ok(new); // すでにそこにある
        }
        let exists = self.index.values().any(|e| {
            !e.deleted && (if e.kind == ItemType::Folder { path_in(&crate::model::join_folder(&e.folder, &e.name), &new) } else { path_in(&e.folder, &new) })
        });
        if exists {
            return Err(bad("移動先に同じ名前のフォルダがあります"));
        }
        let ids: Vec<String> = self.index.values().filter(|e| !e.corrupt).map(|e| e.id.clone()).collect();
        self.begin_batch();
        let res = (|| -> Result<()> {
            for id in ids {
                let mut it = self.get_item(&id)?;
                let changed = if it.kind == ItemType::Folder && path_in(&it.folder_path(), path) {
                    let own = it.folder_path();
                    let moved = format!("{new}{}", &own[path.len()..]);
                    let (parent, nm) = match moved.rfind('/') {
                        Some(0) | None => ("/".to_string(), moved.trim_start_matches('/').to_string()),
                        Some(i) => (moved[..i].to_string(), moved[i + 1..].to_string()),
                    };
                    it.folder = parent;
                    it.name = nm;
                    true
                } else if it.kind != ItemType::Folder && path_in(&it.folder, path) {
                    it.folder = format!("{new}{}", &it.folder[path.len()..]);
                    true
                } else {
                    false
                };
                if changed {
                    self.save_item(&mut it)?;
                }
            }
            Ok(())
        })();
        let flush = self.end_batch();
        res?;
        flush?;
        Ok(new)
    }
}
