//! Tauri のコマンド。実体は `service::dispatch`。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::core::Core;
use crate::locale;
use crate::service::{self, Source};

/// 画面から保管庫の操作を呼ぶ唯一の入口。エラーは `{code, message}` で返す。
#[tauri::command(async)]
pub fn rpc(core: State<'_, Arc<Core>>, cmd: String, args: Option<Value>) -> Result<Value, Value> {
    let t0 = std::time::Instant::now();
    let r = service::dispatch(&core, &cmd, args.unwrap_or(Value::Null), Source::Ui).map_err(|e| json!({"code": e.code, "message": e.message}));
    // 画面が止まって見える原因を調べられるよう、時間のかかった呼び出しをログに残す（引数や結果は書かない）
    let ms = t0.elapsed().as_millis();
    if ms >= 300 {
        core.log("rpc.slow", &format!("{cmd} {ms}ms"));
    }
    r
}

/// 画面用の文言（`locales/*.json` をそのまま返す）。
#[tauri::command]
pub fn get_locale(core: State<'_, Arc<Core>>, lang: Option<String>) -> String {
    let l = lang.unwrap_or_else(|| core.prefs().general.language);
    locale::raw_json(&l).to_string()
}

/// 秘密をクリップボードへ入れ、設定した秒数後に「まだ同じ値なら」消す（§8.5）。
#[tauri::command(async)]
pub fn copy_secret(core: State<'_, Arc<Core>>, text: String, secret: Option<bool>) -> Result<(), String> {
    crate::clip::copy(&core, &text, secret.unwrap_or(true))
}

#[tauri::command(async)]
pub fn pick_open(app: AppHandle, title: String, name: String, exts: Vec<String>) -> Option<String> {
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    app.dialog().file().set_title(title).add_filter(name, &ext_refs).blocking_pick_file().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

/// フォルダを選ぶ（バックアップの保存先など）。自動テストでは TKRFORM_PICK_FOLDER の値を返す（ダイアログを出さない）。
#[tauri::command(async)]
pub fn pick_folder(app: AppHandle, title: String) -> Option<String> {
    if crate::sys::testing() {
        return std::env::var("TKRFORM_PICK_FOLDER").ok().filter(|s| !s.is_empty());
    }
    app.dialog().file().set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn pick_save(app: AppHandle, title: String, file_name: String, name: String, exts: Vec<String>) -> Option<String> {
    let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(name, &ext_refs)
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// 呼び出したウィンドウを閉じる。
#[tauri::command]
pub fn close_self(window: tauri::WebviewWindow) {
    let _ = window.destroy();
}

#[tauri::command]
pub fn set_on_top(window: tauri::WebviewWindow, on: bool) {
    if !crate::sys::quiet() {
        let _ = window.set_always_on_top(on);
    }
}

/// 直前にアクティブだった欄へ文字列を入力する（パスワード生成器の「記入」）。
#[tauri::command(async)]
pub fn type_to_last(text: String) -> Result<(), String> {
    crate::sys::type_into_last_window(&text)
}
