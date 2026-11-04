//! アプリの状態（保管庫・設定・失敗回数）と、ロック/解除の処理。

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tkrform_core::crypto::Key;
use tkrform_core::error::Error;
use tkrform_core::prefs::Preferences;
use tkrform_core::throttle::Throttle;
use tkrform_core::vault::{self, Vault};
use tkrform_ipc::pipe::PipeServer;
use tkrform_ipc::proto::{code, Event};

use crate::sys;

#[derive(Debug, Clone)]
pub struct SvcError {
    pub code: &'static str,
    pub message: String,
}

impl SvcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        SvcError { code, message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL, message)
    }

    pub fn locked() -> Self {
        Self::new(code::LOCKED, "ロックされています")
    }
}

impl From<Error> for SvcError {
    fn from(e: Error) -> Self {
        match e {
            Error::BadPassword => SvcError::new(code::BAD_PASSWORD, "マスターパスワードが違います"),
            Error::NotFound(_) => SvcError::new(code::NOT_FOUND, "アイテムが見つかりません"),
            other => SvcError::internal(other.to_string()),
        }
    }
}

impl std::fmt::Display for SvcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

struct Inner {
    vault: Option<Vault>,
    kek: Option<Key>,
    prefs: Preferences,
    throttle: Throttle,
}

pub struct Core {
    /// `%LOCALAPPDATA%\tkrform`
    pub root: PathBuf,
    /// `%LOCALAPPDATA%\tkrform\<accountId>`
    pub dir: PathBuf,
    inner: Mutex<Inner>,
    pub pipe: OnceLock<PipeServer>,
    pub app: OnceLock<AppHandle>,
    pub sync: crate::sync::SyncMgr,
    /// Ctrl+Alt+A で取り込んだ Windows アプリの情報（保存ダイアログが読む）
    pub pending_app: Mutex<Option<crate::winfill::Captured>>,
    /// 直近の自動バックアップの失敗（保存先に書けないなど）。成功すると消える。設定・エディタを開いたときに知らせる
    pub backup_error: Mutex<Option<String>>,
}

pub const ACCOUNT_ID: &str = "main";

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Core {
    pub fn new() -> Arc<Core> {
        let root = std::env::var_os("TKRFORM_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("tkrform")))
            .unwrap_or_else(|| PathBuf::from("tkrform-data"));
        let dir = root.join(ACCOUNT_ID);
        let prefs = Preferences::load(&dir.join("preferences.json"));
        Arc::new(Core {
            root,
            dir,
            inner: Mutex::new(Inner { vault: None, kek: None, prefs, throttle: Throttle::new() }),
            pipe: OnceLock::new(),
            app: OnceLock::new(),
            sync: crate::sync::SyncMgr::new(),
            pending_app: Mutex::new(None),
            backup_error: Mutex::new(None),
        })
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn exists(&self) -> bool {
        Vault::exists(&self.dir)
    }

    pub fn is_locked(&self) -> bool {
        self.lock_inner().vault.is_none()
    }

    pub fn prefs(&self) -> Preferences {
        self.lock_inner().prefs.clone()
    }

    pub fn hint(&self) -> String {
        std::fs::read_to_string(self.dir.join("hint.txt")).unwrap_or_default()
    }

    /// 保管庫を使う処理。ロック中は `LOCKED`。
    pub fn with_vault<R>(&self, f: impl FnOnce(&mut Vault, &Preferences) -> Result<R, SvcError>) -> Result<R, SvcError> {
        let mut g = self.lock_inner();
        let Inner { vault, prefs, .. } = &mut *g;
        match vault {
            Some(v) => f(v, prefs),
            None => Err(SvcError::locked()),
        }
    }

    /// 設定を保存して反映する。
    pub fn set_prefs(&self, new: Preferences) -> Result<(), SvcError> {
        let (old_remember, dir) = {
            let mut g = self.lock_inner();
            let old = g.prefs.security.remember_mp;
            g.prefs = new.clone();
            (old, self.dir.clone())
        };
        new.save(&dir.join("preferences.json")).map_err(SvcError::from)?;
        sys::set_autostart(new.general.start_with_windows);
        if new.security.remember_mp != old_remember {
            if new.security.remember_mp {
                self.save_device_key();
            } else {
                // アプリ自身が作った端末保護キーを、設定オフに合わせて消す
                let _ = std::fs::remove_file(self.dir.join("device.key"));
            }
        }
        self.emit("prefs-changed", json!({}));
        Ok(())
    }

    fn save_device_key(&self) {
        let g = self.lock_inner();
        if let Some(kek) = &g.kek {
            if let Ok(blob) = sys::dpapi_protect(&**kek) {
                let _ = tkrform_core::fsutil::write_atomic(&self.dir.join("device.key"), &blob);
            }
        }
    }

    pub fn log(&self, event: &str, id: &str) {
        use std::io::Write;
        let dir = self.root.join("logs");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("tkrform.log");
        if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
            let _ = std::fs::rename(&path, dir.join("tkrform.old.log"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            // 記録するのはイベント名と ID だけ（§19）
            let _ = writeln!(f, "{} {} {}", tkrform_core::model::now_iso(), event, id);
        }
    }

    pub fn emit(&self, name: &str, payload: Value) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(name, payload);
        }
    }

    /// ロック状態の変化を、拡張・画面・トレイへ伝える。
    fn on_state_changed(self: &Arc<Self>) {
        let locked = self.is_locked();
        if let Some(p) = self.pipe.get() {
            p.broadcast(&Event::new("lockState", json!({ "locked": locked })));
        }
        self.emit("vault-state", json!({ "locked": locked }));
        if let Some(app) = self.app.get() {
            crate::tray::refresh(app, self);
        }
    }

    /// 保管庫の変更（保存・削除など）を通知する。
    pub fn notify_changed(self: &Arc<Self>) {
        self.sync.touch();
        self.emit("vault-changed", json!({}));
        if let Some(app) = self.app.get() {
            crate::tray::refresh_soon(app, self);
        }
    }

    /// 同期で参加した保管庫を、解除済みの状態でセットする。
    pub fn install_vault(self: &Arc<Self>, v: Vault, kek: Key) {
        {
            let mut g = self.lock_inner();
            g.vault = Some(v);
            g.kek = Some(kek);
            g.throttle.success();
        }
        self.log("vault.joined", "-");
        self.on_state_changed();
    }

    pub fn create_vault(self: &Arc<Self>, mp: &str, hint: &str, iterations: u32) -> Result<(), SvcError> {
        if self.exists() {
            return Err(SvcError::internal("保管庫は既に作成されています"));
        }
        let iterations = tkrform_core::crypto::clamp_user_iterations(iterations);
        std::fs::create_dir_all(&self.dir).map_err(|e| SvcError::internal(e.to_string()))?;
        let v = Vault::create(&self.dir, mp, iterations)?;
        if !hint.trim().is_empty() {
            let _ = tkrform_core::fsutil::write_atomic(&self.dir.join("hint.txt"), hint.trim().as_bytes());
        }
        let kek = Vault::derive_kek_for(&self.dir, mp)?;
        {
            let mut g = self.lock_inner();
            g.prefs.security.iterations = iterations;
            let p = g.prefs.clone();
            let _ = p.save(&self.dir.join("preferences.json"));
            g.vault = Some(v);
            g.kek = Some(kek);
            g.throttle.success();
        }
        self.log("vault.created", "-");
        self.on_state_changed();
        Ok(())
    }

    pub fn unlock(self: &Arc<Self>, mp: &str) -> Result<(), SvcError> {
        if !self.exists() {
            return Err(SvcError::new(code::NOT_FOUND, "保管庫がまだ作成されていません"));
        }
        if !self.is_locked() {
            return Ok(());
        }
        if let Err(wait) = self.lock_inner().throttle.check(now_secs()) {
            return Err(SvcError::new(code::RATE_LIMITED, format!("失敗が続いたため、{wait} 秒待ってからやり直してください")));
        }
        let res = Vault::derive_kek_for(&self.dir, mp).and_then(|kek| Vault::open_with_kek(&self.dir, &kek).map(|v| (v, kek)));
        match res {
            Ok((v, kek)) => {
                self.finish_unlock(v, kek);
                Ok(())
            }
            Err(Error::BadPassword) => {
                let mut g = self.lock_inner();
                g.throttle.failure(now_secs());
                let wait = g.throttle.check(now_secs()).err();
                drop(g);
                self.log("unlock.failed", "-");
                match wait {
                    Some(w) => Err(SvcError::new(code::RATE_LIMITED, format!("失敗が続いたため、{w} 秒待ってからやり直してください"))),
                    None => Err(SvcError::new(code::BAD_PASSWORD, "マスターパスワードが違います")),
                }
            }
            Err(e) => Err(e.into()),
        }
    }

    /// 「この端末で MP を記憶」が有効なら、保存した KEK で解除する。
    pub fn try_device_unlock(self: &Arc<Self>) -> bool {
        if !self.is_locked() || !self.prefs().security.remember_mp {
            return false;
        }
        let Ok(blob) = std::fs::read(self.dir.join("device.key")) else { return false };
        let Ok(raw) = sys::dpapi_unprotect(&blob) else { return false };
        let Ok(kek): Result<[u8; 32], _> = raw.as_slice().try_into() else { return false };
        match Vault::open_with_kek(&self.dir, &kek) {
            Ok(v) => {
                self.finish_unlock(v, zeroize::Zeroizing::new(kek));
                true
            }
            Err(_) => false,
        }
    }

    fn finish_unlock(self: &Arc<Self>, v: Vault, kek: Key) {
        let prefs = {
            let mut g = self.lock_inner();
            g.vault = Some(v);
            g.kek = Some(kek);
            g.throttle.success();
            g.prefs.clone()
        };
        if prefs.security.remember_mp && !self.dir.join("device.key").exists() {
            self.save_device_key();
        }
        // 自動バックアップ（毎日・世代管理）。暗号化済みファイルを zip にするだけなので別スレッドで行う。
        if prefs.backup.auto {
            let core = self.clone();
            std::thread::spawn(move || core.auto_backup());
        }
        self.log("unlock", "-");
        self.sync.request_now();
        self.on_state_changed();
    }

    /// バックアップの保存先（設定の backup.dir。空なら既定の保存先）。
    pub fn backup_target(&self, p: &Preferences) -> PathBuf {
        if p.backup.dir.trim().is_empty() {
            vault::backups_dir(&self.dir)
        } else {
            PathBuf::from(p.backup.dir.trim())
        }
    }

    /// 保存先が既定でないとき、使える状態か確かめる（ドライブ未接続・書き込み不可など）。
    pub fn check_backup_target(&self, p: &Preferences) -> Result<PathBuf, SvcError> {
        let t = self.backup_target(p);
        if !p.backup.dir.trim().is_empty() {
            vault::validate_backup_dir(&self.dir, &t)?;
        }
        Ok(t)
    }

    /// バックアップの失敗を記録する。黙って既定の保存先に切り替えない（利用者が気づけないため）。
    pub fn backup_failed(&self, msg: &str) {
        self.log("backup.failed", msg);
        *self.backup_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg.to_string());
    }

    /// 毎日の自動バックアップ（1 日 1 回、世代管理つき）。解除のたびに別スレッドで呼ばれる。
    fn auto_backup(&self) {
        let p = self.prefs();
        let target = match self.check_backup_target(&p) {
            Ok(t) => t,
            Err(e) => return self.backup_failed(&format!("保存先を使えません: {}", e.message)),
        };
        if vault::has_backup_today_in(&target) {
            return;
        }
        match vault::make_backup_in(&self.dir, &target) {
            Ok(_) => {
                vault::prune_backups_in(&target, p.backup.generations.max(1) as usize);
                *self.backup_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => self.backup_failed(&format!("バックアップを作れません: {e}")),
        }
    }

    /// 全初期化: 保管庫・設定・同期の接続・Windows Hello の登録・端末保護キーを消す。
    /// バックアップ（既定の保存先と、利用者が指定した保存先）とログには触れない。**呼び出し側は、マスターパスワードの確認を必ず経ること。**
    pub fn factory_reset(self: &Arc<Self>) -> Result<(), SvcError> {
        // 安全のため、削除するのは「アカウントのフォルダ」だけ（想定外のパスなら何も消さない）
        if self.dir.file_name().map(|n| n != ACCOUNT_ID).unwrap_or(true) || self.dir.parent() != Some(self.root.as_path()) {
            return Err(SvcError::internal("データフォルダの場所が想定と違うため、初期化できません"));
        }
        self.lock();
        crate::hello::delete(ACCOUNT_ID);
        self.sync.reset();
        // バックアップ（backups フォルダ）は消さない。それ以外（保管庫・設定・鍵・同期の接続など）をすべて消す
        let entries = std::fs::read_dir(&self.dir).map_err(|e| SvcError::internal(format!("データを読み取れませんでした: {e}")))?;
        for e in entries.flatten() {
            if e.file_name() == "backups" {
                continue;
            }
            let p = e.path();
            let r = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
            r.map_err(|err| SvcError::internal(format!("データを削除できませんでした: {err}")))?;
        }
        {
            let mut g = self.lock_inner();
            g.prefs = Preferences::default();
            g.throttle = Throttle::new();
        }
        *self.backup_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.log("factory.reset", "-");
        self.on_state_changed();
        Ok(())
    }

    pub fn lock(self: &Arc<Self>) {
        let was_unlocked = {
            let mut g = self.lock_inner();
            let was = g.vault.is_some();
            if let Some(v) = g.vault.as_mut() {
                let _ = v.flush_index();
            }
            g.vault = None; // Zeroizing により鍵は drop 時に消去される
            g.kek = None;
            was
        };
        if was_unlocked {
            self.log("lock", "-");
            self.on_state_changed();
        }
    }

    /// 保管庫の KEK を使う処理（MP 変更後の端末保護キー更新など）。
    /// Hello の失敗を、段階と HRESULT つきで記録する（メッセージに秘密は含まれない）。キャンセルは記録しない。
    fn log_hello_notes(&self) {
        for n in crate::hello::take_notes() {
            self.log("hello.dialog", &n);
        }
    }

    fn log_hello_fail(&self, e: &SvcError) {
        self.log_hello_notes();
        if !e.message.contains("キャンセル") {
            self.log("hello.failed", &e.message);
        }
    }

    /// Windows Hello の署名を取る。確認画面の見張りの記録（見つけた・見つからない）は、確認が終わるのを待たず、すぐログに書く
    /// （利用者が確認を待たせている間も、原因を調べられるように）。
    fn hello_sign(self: &Arc<Self>) -> Result<Vec<u8>, SvcError> {
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let d2 = done.clone();
        let me = self.clone();
        let drain = std::thread::spawn(move || {
            while !d2.load(std::sync::atomic::Ordering::Relaxed) {
                me.log_hello_notes();
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
        let r = crate::hello::sign(ACCOUNT_ID);
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = drain.join();
        r.inspect(|_| self.log_hello_notes()).inspect_err(|e| self.log_hello_fail(e))
    }

    /// Windows Hello の確認を通して KEK を取り出し、解除する（時間がかかるので UI のスレッドで呼ばない）。
    pub fn hello_unlock(self: &Arc<Self>) -> Result<(), SvcError> {
        if !self.is_locked() {
            return Ok(());
        }
        let wrapped = std::fs::read(self.dir.join("hello.key")).map_err(|_| SvcError::internal("Windows Hello が登録されていません"))?;
        let sig = self.hello_sign()?;
        let kek = tkrform_core::crypto::hello_unwrap_kek(&wrapped, &sig)?;
        let v = Vault::open_with_kek(&self.dir, &kek)?;
        self.finish_unlock(v, kek);
        Ok(())
    }

    /// 登録済みの hello.key があるのに設定が無効になっているとき、利用者の操作で有効に戻す。
    /// Windows Hello の確認を通して hello.key を開き、今の保管庫の鍵と一致することを確かめてから戻す（黙って戻さない）。
    pub fn hello_reenable(self: &Arc<Self>) -> Result<(), SvcError> {
        self.hello_verify()?;
        let mut p = self.prefs();
        p.security.windows_hello = true;
        self.set_prefs(p)?;
        self.log("hello.reenabled", "-");
        Ok(())
    }

    /// Windows Hello の確認を通して、利用者本人であることと、登録が今の保管庫と一致することを確かめる（解除済みのとき）。
    /// パスキーの利用者確認（UV）などに使う。
    pub fn hello_verify(self: &Arc<Self>) -> Result<(), SvcError> {
        let kek = {
            let g = self.lock_inner();
            g.kek.as_ref().map(|k| **k).ok_or_else(SvcError::locked)?
        };
        let wrapped = std::fs::read(self.dir.join("hello.key")).map_err(|_| SvcError::internal("Windows Hello が登録されていません"))?;
        let sig = self.hello_sign()?;
        let back = tkrform_core::crypto::hello_unwrap_kek(&wrapped, &sig)?;
        if *back != kek {
            return Err(SvcError::internal("登録済みの Windows Hello がこの保管庫と一致しません。登録し直してください"));
        }
        Ok(())
    }

    /// 解除中に Windows Hello を登録する（KEK を Hello の署名で包んで保存）。
    pub fn hello_enable(self: &Arc<Self>) -> Result<(), SvcError> {
        let kek = {
            let g = self.lock_inner();
            g.kek.as_ref().map(|k| **k).ok_or_else(SvcError::locked)?
        };
        let sig = crate::hello::enroll(ACCOUNT_ID).inspect(|_| self.log_hello_notes()).inspect_err(|e| self.log_hello_fail(e))?;
        let wrapped = tkrform_core::crypto::hello_wrap_kek(&kek, &sig);
        tkrform_core::fsutil::write_atomic(&self.dir.join("hello.key"), &wrapped).map_err(|e| SvcError::internal(e.to_string()))?;
        let mut p = self.prefs();
        p.security.windows_hello = true;
        self.set_prefs(p)?;
        self.log("hello.enabled", "-");
        Ok(())
    }

    /// Windows Hello をやめる。資格情報と、アプリ自身が作った hello.key を消す（設定の操作が確認を兼ねる）。
    pub fn hello_disable(self: &Arc<Self>) -> Result<(), SvcError> {
        crate::hello::delete(ACCOUNT_ID);
        let _ = std::fs::remove_file(self.dir.join("hello.key"));
        let mut p = self.prefs();
        p.security.windows_hello = false;
        self.set_prefs(p)?;
        self.log("hello.disabled", "-");
        Ok(())
    }

    pub fn change_master_password(self: &Arc<Self>, old: &str, new: &str) -> Result<(), SvcError> {
        let iterations = self.prefs().security.iterations;
        {
            let mut g = self.lock_inner();
            let v = g.vault.as_mut().ok_or_else(SvcError::locked)?;
            v.change_password(old, new, iterations)?;
        }
        let kek = Vault::derive_kek_for(&self.dir, new)?;
        self.lock_inner().kek = Some(kek);
        if self.prefs().security.remember_mp {
            self.save_device_key();
        }
        if self.prefs().security.windows_hello {
            // KEK が変わったので Windows Hello の登録は古くなる。解除して、再登録を促す
            let _ = self.hello_disable();
        }
        self.log("mp.changed", "-");
        Ok(())
    }
}
