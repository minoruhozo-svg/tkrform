//! 同期（§15）。同期のタイミング: ロック解除時、変更後 5 秒の debounce、15 分ごと、手動。
//! ネットワーク通信中は保管庫のロックを持たない（拡張の match などを待たせないため）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tkrform_core::sync::{self, HttpTransport, SyncReport, SyncState};
use tkrform_core::vault::Vault;

use crate::core::{Core, SvcError};
use crate::sys;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    last_ok: Option<String>,
    last_error: Option<String>,
    report: Option<SyncReport>,
    needs_login: bool,
    running: bool,
}

pub struct SyncMgr {
    dirty_at: Mutex<Option<Instant>>,
    now: AtomicBool,
    busy: AtomicBool,
    status: Mutex<Status>,
}

impl SyncMgr {
    pub fn new() -> SyncMgr {
        SyncMgr { dirty_at: Mutex::new(None), now: AtomicBool::new(false), busy: AtomicBool::new(false), status: Mutex::new(Status::default()) }
    }

    /// ローカルの変更があった（5 秒後に同期する）。
    pub fn touch(&self) {
        *self.dirty_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }

    /// ロック解除時・手動: すぐ同期する。
    pub fn request_now(&self) {
        self.now.store(true, Ordering::SeqCst);
    }

    fn set(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
    }
}

impl SyncMgr {
    /// 全初期化のあと、同期の状態（最終同期・エラーなど）を空に戻す。
    pub fn reset(&self) {
        self.set(|s| *s = Status::default());
        *self.dirty_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Default for SyncMgr {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------- トークン（DPAPI で保護して保存）

fn token_path(core: &Core) -> std::path::PathBuf {
    core.dir.join("sync.token")
}

fn load_token(core: &Core) -> Option<String> {
    let blob = std::fs::read(token_path(core)).ok()?;
    String::from_utf8(sys::dpapi_unprotect(&blob).ok()?).ok()
}

fn save_token(core: &Core, token: &str) -> Result<(), SvcError> {
    let blob = sys::dpapi_protect(token.as_bytes()).map_err(SvcError::internal)?;
    tkrform_core::fsutil::write_atomic(&token_path(core), &blob).map_err(|e| SvcError::internal(e.to_string()))
}

fn transport(url: &str) -> Result<HttpTransport, SvcError> {
    Ok(HttpTransport::new(url)?)
}

fn mark_error(core: &Core, e: &SvcError) {
    let needs = e.message.contains("有効期限") || e.message.contains("認証が必要");
    core.sync.set(|s| {
        s.last_error = Some(e.message.clone());
        s.needs_login = needs;
    });
}

// ---------------------------------------------------------------------- 操作

pub fn status(core: &Core) -> Value {
    let prefs = core.prefs();
    let st = SyncState::load(&core.dir);
    let s = core.sync.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut v = serde_json::to_value(&s).unwrap_or_default();
    v["enabled"] = json!(prefs.sync.enabled);
    v["serverUrl"] = json!(prefs.sync.server_url);
    v["email"] = json!(st.email);
    v["loggedIn"] = json!(token_path(core).exists());
    v["busy"] = json!(core.sync.busy.load(Ordering::SeqCst));
    v
}

fn enable(core: &Arc<Core>, url: &str, email: &str, token: &str) -> Result<(), SvcError> {
    save_token(core, token)?;
    let st = SyncState { server_url: url.to_string(), email: email.to_string(), ..Default::default() };
    st.save(&core.dir)?;
    let mut p = core.prefs();
    p.sync.enabled = true;
    p.sync.server_url = url.to_string();
    core.set_prefs(p)?;
    core.sync.set(|s| {
        s.needs_login = false;
        s.last_error = None;
    });
    core.sync.request_now();
    Ok(())
}

/// 既にある保管庫でアカウントを作る（`register`）、または既存のアカウントでログインする（`login`）。
pub fn connect(core: &Arc<Core>, mode: &str, url: &str, email: &str, password: &str) -> Result<(), SvcError> {
    let t = transport(url)?;
    let token = core.with_vault(|v, _| {
        Ok(match mode {
            "register" => sync::register(&t, v, email, password)?,
            _ => sync::login_existing(&t, v, email, password)?,
        })
    })?;
    // 別端末で MP が変わっていた場合はヘッダが更新されるので、端末保護キーも作り直す
    enable(core, &t.url, email, &token)?;
    core.log("sync.connect", mode);
    Ok(())
}

/// 初回セットアップ: 同期サーバのアカウントに参加して、この端末の保管庫を作る。
pub fn setup_join(core: &Arc<Core>, url: &str, email: &str, mp: &str, hint: &str) -> Result<(), SvcError> {
    if core.exists() {
        return Err(SvcError::internal("保管庫は既に作成されています"));
    }
    let t = transport(url)?;
    let (v, token): (Vault, String) = sync::join_new_device(&t, &core.dir, email, mp)?;
    if !hint.trim().is_empty() {
        let _ = tkrform_core::fsutil::write_atomic(&core.dir.join("hint.txt"), hint.trim().as_bytes());
    }
    let kek = Vault::derive_kek_for(&core.dir, mp)?;
    core.install_vault(v, kek);
    enable(core, &t.url, email, &token)
}

/// 同期をやめる。サーバのトークンを破棄し、この端末の同期状態（sync.json / sync.token）を消す。保管庫そのものは残る。
pub fn disconnect(core: &Arc<Core>) -> Result<(), SvcError> {
    let prefs = core.prefs();
    if let (Some(tok), Ok(t)) = (load_token(core), HttpTransport::new(&prefs.sync.server_url)) {
        sync::logout(&t, &tok);
    }
    let _ = std::fs::remove_file(token_path(core));
    let _ = std::fs::remove_file(core.dir.join("sync.json"));
    let mut p = prefs;
    p.sync.enabled = false;
    core.set_prefs(p)?;
    core.sync.set(|s| *s = Status::default());
    core.log("sync.disconnect", "-");
    Ok(())
}

/// MP を変更したあと、サーバの認証情報も更新する。
pub fn after_mp_change(core: &Arc<Core>, new_mp: &str) {
    let prefs = core.prefs();
    if !prefs.sync.enabled {
        return;
    }
    let (Some(tok), Ok(t)) = (load_token(core), HttpTransport::new(&prefs.sync.server_url)) else { return };
    let r = core.with_vault(|v, _| Ok(sync::change_auth(&t, v, &tok, new_mp)?));
    if let Err(e) = r {
        mark_error(core, &e);
    }
}

/// 同期の実行権を取る。ほかの同期が実行中なら、終わるまで最大 `wait` 待つ。取れたら true。
fn acquire(busy: &AtomicBool, wait: std::time::Duration) -> bool {
    let t0 = std::time::Instant::now();
    while busy.swap(true, Ordering::SeqCst) {
        if t0.elapsed() >= wait {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    true
}

/// 手動の同期（「今すぐ同期」・トレイ）。自動同期が実行中なら、エラーにせず、その完了を待ってから、改めて 1 回同期して結果を返す
/// （実行中の同期は、その時点の変更しか見ていないため）。
pub fn run_once(core: &Arc<Core>) -> Result<SyncReport, SvcError> {
    if !acquire(&core.sync.busy, std::time::Duration::from_secs(120)) {
        return Err(SvcError::internal("同期中です。しばらくしてからもう一度お試しください"));
    }
    run_locked(core)
}

/// 自動同期（ロック解除時・変更後・定期）。ほかの同期が実行中なら、何もしない。
pub fn run_auto(core: &Arc<Core>) -> Result<SyncReport, SvcError> {
    if core.sync.busy.swap(true, Ordering::SeqCst) {
        return Err(SvcError::internal("同期中です"));
    }
    run_locked(core)
}

/// 同期を 1 回行う（pull → 反映 → push。競合で送れなかったものがあれば 1 回だけやり直す）。実行権を取ってから呼ぶ。
fn run_locked(core: &Arc<Core>) -> Result<SyncReport, SvcError> {
    core.sync.set(|s| s.running = true);
    let r = run_inner(core);
    core.sync.busy.store(false, Ordering::SeqCst);
    core.sync.set(|s| s.running = false);
    match &r {
        Ok(rep) => {
            let (rep, now) = (rep.clone(), tkrform_core::model::now_iso());
            core.sync.set(|s| {
                s.last_ok = Some(now);
                s.last_error = None;
                s.needs_login = false;
                s.report = Some(rep);
            });
            core.emit("sync-done", json!({}));
        }
        Err(e) => {
            mark_error(core, e);
            core.emit("sync-done", json!({}));
        }
    }
    r
}

fn run_inner(core: &Arc<Core>) -> Result<SyncReport, SvcError> {
    let prefs = core.prefs();
    if !prefs.sync.enabled {
        return Err(SvcError::internal("同期はオフです"));
    }
    let t = transport(&prefs.sync.server_url)?;
    let tok = load_token(core).ok_or_else(|| SvcError::internal("認証が必要です。もう一度ログインしてください"))?;
    let mut total = SyncReport::default();
    for _ in 0..2 {
        let mut st = SyncState::load(&core.dir);
        let (remote, head) = sync::run_pull(&t, &tok, st.last_rev)?;
        let (rep, plan) = core.with_vault(|v, _| {
            let rep = sync::apply_pull(v, &mut st, remote)?;
            st.last_rev = head;
            Ok((rep, sync::plan_push(v, &st)))
        })?;
        let mut st2 = st.clone();
        let (pushed, conflicts) = sync::run_push(&t, &tok, head, &plan, &mut st2)?;
        st2.save(&core.dir)?;
        total.pulled += rep.pulled;
        total.purged += rep.purged;
        total.rejected += rep.rejected;
        total.conflicts_kept += rep.conflicts_kept;
        total.pushed += pushed;
        if rep.pulled + rep.purged + rep.conflicts_kept > 0 {
            core.emit("vault-changed", json!({}));
            if let Some(app) = core.app.get() {
                crate::tray::refresh_soon(app, core);
            }
        }
        if conflicts.is_empty() {
            break;
        }
    }
    Ok(total)
}

/// 背景スレッド: 5 秒の debounce・15 分ごと・要求があれば同期する。
pub fn start_thread(core: &Arc<Core>) {
    let core = core.clone();
    std::thread::Builder::new()
        .name("tkrform-sync".into())
        .spawn(move || {
            let mut last = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                if core.is_locked() || !core.prefs().sync.enabled || !token_path(&core).exists() {
                    continue;
                }
                let due_debounce = core.sync.dirty_at.lock().unwrap_or_else(|e| e.into_inner()).map(|t| t.elapsed() >= Duration::from_secs(5)).unwrap_or(false);
                let manual = core.sync.now.load(Ordering::SeqCst);
                let periodic = last.elapsed() >= Duration::from_secs(15 * 60);
                if due_debounce || manual || periodic {
                    *core.sync.dirty_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    core.sync.now.store(false, Ordering::SeqCst);
                    last = Instant::now();
                    let _ = run_auto(&core);
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    /// 実行中の同期があっても、手動の同期は完了を待って実行権を取る（エラーにしない）。自動は待たない。
    #[test]
    fn acquire_waits_for_running_sync() {
        let busy = Arc::new(AtomicBool::new(true));
        let b2 = busy.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            b2.store(false, Ordering::SeqCst);
        });
        assert!(acquire(&busy, Duration::from_secs(5)), "完了を待って取れる");
        assert!(busy.load(Ordering::SeqCst), "取った側が実行中になる");
        t.join().unwrap();
        assert!(!acquire(&busy, Duration::from_millis(150)), "実行中のままなら、待ち時間を過ぎたら諦める");
    }
}
