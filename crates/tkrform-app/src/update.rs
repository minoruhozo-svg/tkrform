//! 自動更新（§10.5）。起動時と 24 時間ごとに `latest.json`（`{version, url, sha256, notes}`）を取得し、
//! 新しい版があれば通知する。ダウンロードとインストールは、利用者の同意を得てからだけ行い、
//! SHA-256 を照合してからインストーラを実行する。サービスとして常駐はしない。

use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tkrform_core::update::{is_newer, latest_url_from, parse_manifest, Manifest};

use crate::core::{Core, SvcError};
use crate::sys;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;

fn prompted() -> &'static Mutex<String> {
    static P: OnceLock<Mutex<String>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(String::new()))
}

/// 取得先。テスト中は環境変数 TKRFORM_UPDATE_URL、通常は設定の URL、なければ同期サーバと同じ場所の latest.json。
pub fn manifest_url(core: &Core) -> Option<String> {
    if sys::testing() {
        if let Ok(u) = std::env::var("TKRFORM_UPDATE_URL") {
            return Some(u);
        }
    }
    let p = core.prefs();
    if !p.general.update_url.trim().is_empty() {
        return Some(p.general.update_url.trim().to_string());
    }
    if p.sync.enabled {
        return latest_url_from(&p.sync.server_url);
    }
    None
}

fn http_get_limited(url: &str, max: u64) -> Result<Vec<u8>, SvcError> {
    let r = ureq::get(url).set("User-Agent", "TKRForm").timeout(Duration::from_secs(20)).call().map_err(|_| SvcError::internal("更新情報を取得できません"))?;
    let mut buf = Vec::new();
    r.into_reader().take(max + 1).read_to_end(&mut buf).map_err(|_| SvcError::internal("更新情報を読み取れません"))?;
    if buf.len() as u64 > max {
        return Err(SvcError::internal("更新情報が大きすぎます"));
    }
    Ok(buf)
}

/// 新しい版があれば返す。
pub fn check(core: &Core) -> Result<Option<Manifest>, SvcError> {
    let url = manifest_url(core).ok_or_else(|| SvcError::internal("更新情報の URL が設定されていません（設定の「一般」または同期サーバ）"))?;
    let body = http_get_limited(&url, MAX_MANIFEST_BYTES)?;
    let m = parse_manifest(&String::from_utf8_lossy(&body))?;
    Ok(is_newer(&m.version, env!("CARGO_PKG_VERSION")).then_some(m))
}

/// 同意の確認。テスト中だけ、環境変数 TKRFORM_UPDATE_ANSWER（yes/no）で自動応答する。
fn consent(app: &AppHandle, text: &str) -> bool {
    if sys::testing() {
        if let Ok(a) = std::env::var("TKRFORM_UPDATE_ANSWER") {
            return a == "yes";
        }
    }
    if sys::quiet() {
        return false; // 自動テスト中は、確認の画面を出さない
    }
    app.dialog()
        .message(text)
        .title("TKRForm")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("ダウンロードして更新".into(), "あとで".into()))
        .blocking_show()
}

fn download(url: &str, dest: &std::path::Path) -> Result<(), SvcError> {
    let r = ureq::get(url).set("User-Agent", "TKRForm").timeout(Duration::from_secs(600)).call().map_err(|_| SvcError::internal("ダウンロードに失敗しました"))?;
    let mut rd = r.into_reader().take(MAX_DOWNLOAD_BYTES + 1);
    let mut f = std::fs::File::create(dest).map_err(|e| SvcError::internal(e.to_string()))?;
    let mut h = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = rd.read(&mut buf).map_err(|_| SvcError::internal("ダウンロード中にエラーが発生しました"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        h.update(&buf[..n]);
        f.write_all(&buf[..n]).map_err(|e| SvcError::internal(e.to_string()))?;
    }
    if total > MAX_DOWNLOAD_BYTES {
        return Err(SvcError::internal("ダウンロードしたファイルが大きすぎます"));
    }
    f.sync_all().ok();
    Ok(())
}

/// 同意 → ダウンロード → SHA-256 照合 → インストーラの実行。一致しなければ実行しない。
pub fn install(core: &Arc<Core>, m: &Manifest) -> Result<(), SvcError> {
    let app = core.app.get().ok_or_else(|| SvcError::internal("アプリが初期化されていません"))?;
    let text = format!(
        "TKRForm {} を利用できます（現在 {}）。\n\n{}\n\nダウンロードして更新しますか？\n・ダウンロード後に SHA-256 を照合し、一致したものだけを実行します。\n・インストーラの実行前に、保管庫を閉じ（ロックし）、TKRForm を終了します。",
        m.version,
        env!("CARGO_PKG_VERSION"),
        m.notes
    );
    if !consent(app, &text) {
        return Err(SvcError::internal("更新をキャンセルしました"));
    }
    let dir = std::env::temp_dir().join("tkrform-update");
    std::fs::create_dir_all(&dir).map_err(|e| SvcError::internal(e.to_string()))?;
    let name = m.url.rsplit('/').next().filter(|n| n.ends_with(".exe") && n.chars().all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))).unwrap_or("tkrform-setup.exe");
    let dest = dir.join(name);
    download(&m.url, &dest)?;
    if let Err(e) = tkrform_core::update::verify_file(&dest, &m.sha256) {
        // 不一致のファイルは実行しない（アプリが作った一時ファイルなので、その場で片付ける）
        let _ = std::fs::remove_file(&dest);
        core.log("update.verify.failed", &m.version);
        return Err(e.into());
    }
    core.log("update.verified", &m.version);
    if sys::testing() && std::env::var_os("TKRFORM_UPDATE_DRYRUN").is_some() {
        // テスト: 実行せず、実行するはずだったパスだけを記録する
        let _ = std::fs::write(core.root.join("update-run.txt"), dest.to_string_lossy().as_bytes());
        return Ok(());
    }
    std::process::Command::new(&dest).spawn().map_err(|e| SvcError::internal(format!("インストーラを起動できません: {e}")))?;
    core.lock();
    app.exit(0);
    Ok(())
}

pub fn status_json(m: Option<&Manifest>) -> Value {
    json!({"current": env!("CARGO_PKG_VERSION"), "available": m.is_some(), "version": m.map(|m| m.version.clone()), "notes": m.map(|m| m.notes.clone())})
}

/// 起動 1 分後と 24 時間ごとに確認する。同じ版の通知は 1 回だけ。
pub fn start_thread(core: &Arc<Core>) {
    let core = core.clone();
    std::thread::Builder::new()
        .name("tkrform-update".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(if sys::testing() { 3 } else { 60 }));
            loop {
                if core.prefs().general.check_updates {
                    if let Ok(Some(m)) = check(&core) {
                        let seen = prompted().lock().map(|p| *p == m.version).unwrap_or(false);
                        if !seen {
                            if let Ok(mut p) = prompted().lock() {
                                *p = m.version.clone();
                            }
                            let _ = install(&core, &m);
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(24 * 3600));
            }
        })
        .ok();
}
