//! ウィンドウの表示とグローバルホットキー。

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::core::Core;
use crate::locale::t;

fn lang(core: &Core) -> String {
    core.prefs().general.language
}

struct Spec<'a> {
    label: &'a str,
    url: String,
    title: String,
    size: (f64, f64),
    resizable: bool,
    on_top: bool,
}

// ---------------------------------------------------------------- 白い画面の調査用（ログに残すだけで、動作は変えない）

static MAIN_TID: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();
/// 直前に見た WebView2 のブラウザプロセス ID（新しく起動されたか＝冷えた起動かを、ログで見分ける）
static LAST_BROWSER_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// main() の最初に呼ぶ（UI スレッドを覚えておき、ウィンドウを開いたスレッドがどれかをログに残す）。
pub fn mark_main_thread() {
    let _ = MAIN_TID.set(std::thread::current().id());
}

fn thread_desc() -> String {
    let cur = std::thread::current();
    let main = MAIN_TID.get().is_some_and(|t| *t == cur.id());
    format!("thread={} main={main}", cur.name().unwrap_or("-"))
}

fn diag(app: &AppHandle, ev: &str, msg: &str) {
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.log(ev, msg);
    }
}

/// 比較用: 環境変数 TKRFORM_DIAG_FORCEFG があると、作成直後にも強制的な前面化（ALT 空打ち・AttachThreadInput）を行う（以前の動作）。
fn diag_force_fg() -> bool {
    std::env::var_os("TKRFORM_DIAG_FORCEFG").is_some()
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// ページ側の計測値（ナビゲーションの開始・応答・DOMContentLoaded・load・最初の描画）を取り、ログに残す。
/// 値はすべて「ウィンドウを作り始めた時点」からの ms。最初の描画（fcp）がまだなら、1 秒おきに最大 15 回取り直す。
fn probe_page(w: &tauri::WebviewWindow, label: String, t0_epoch: f64, tries: u32) {
    let app = w.app_handle().clone();
    let w2 = w.clone();
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::ExecuteScriptCompletedHandler;
        let Ok(core_wv) = wv.controller().CoreWebView2() else { return };
        let mut pid = 0u32;
        let _ = core_wv.BrowserProcessId(&mut pid);
        let js = windows::core::HSTRING::from(
            "(() => { const n = performance.getEntriesByType('navigation')[0] || {}; \
             const p = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint'); \
             const r = (v) => (v ? Math.round(v) : -1); \
             return [performance.timeOrigin, r(n.responseEnd), r(n.domInteractive), r(n.domContentLoadedEventEnd), r(n.loadEventEnd), p ? Math.round(p.startTime) : -1, document.visibilityState, document.hasFocus()].join(' '); })()",
        );
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |hr, json| {
            let s = json.trim_matches('"').to_string();
            let f: Vec<&str> = s.split(' ').collect();
            if hr.is_err() || f.len() < 8 {
                diag(&app, "window.timing", &format!("{label} failed"));
                return Ok(());
            }
            let origin = f[0].parse::<f64>().unwrap_or(0.0) - t0_epoch;
            let rel = |v: &str| match v.parse::<i64>() {
                Ok(x) if x >= 0 => format!("{}", (origin + x as f64).round() as i64),
                _ => "none".into(),
            };
            let prev = LAST_BROWSER_PID.swap(pid, std::sync::atomic::Ordering::SeqCst);
            let fcp_none = f[5].parse::<i64>().map(|x| x < 0).unwrap_or(true);
            diag(
                &app,
                "window.timing",
                &format!(
                    "{label} navstart={}ms resp={} interactive={} dcl={} load={} fcp={} now={}ms vis={} focus={} browser_pid={pid}{}",
                    origin.round() as i64,
                    rel(f[1]),
                    rel(f[2]),
                    rel(f[3]),
                    rel(f[4]),
                    rel(f[5]),
                    (epoch_ms() - t0_epoch).round() as i64,
                    f[6],
                    f[7],
                    if prev == pid { "(same)" } else { "(new)" }
                ),
            );
            if fcp_none && tries > 0 {
                let (w3, label) = (w2.clone(), label.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    probe_page(&w3, label, t0_epoch, tries - 1);
                });
            }
            Ok(())
        }));
        let _ = core_wv.ExecuteScript(&js, &handler);
    });
}

/// 読み込み完了まで（最大 20 秒）、UI スレッドが仕事を受け付けるまでの待ち時間を 200ms ごとに測る。
/// UI スレッドが止まっている（メッセージループが回っていない）のか、WebView2 側で止まっているのかを見分けるため。
fn probe_main_thread(app: &AppHandle, label: String, t0: std::time::Instant, loaded: Arc<std::sync::atomic::AtomicBool>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let (mut n, mut slow, mut max) = (0u32, 0u32, 0u128);
        while !loaded.load(std::sync::atomic::Ordering::SeqCst) && t0.elapsed().as_secs() < 20 {
            let (tx, rx) = std::sync::mpsc::channel();
            let s = std::time::Instant::now();
            if app.run_on_main_thread(move || { let _ = tx.send(()); }).is_err() {
                break;
            }
            let _ = rx.recv_timeout(std::time::Duration::from_secs(20));
            let ms = s.elapsed().as_millis();
            n += 1;
            max = max.max(ms);
            if ms >= 300 {
                slow += 1;
                diag(&app, "window.mainlag", &format!("{label} {ms}ms at={}ms", t0.elapsed().as_millis()));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        diag(&app, "window.mainlag.summary", &format!("{label} probes={n} slow={slow} max={max}ms loaded={}", loaded.load(std::sync::atomic::Ordering::SeqCst)));
    });
}

fn show(app: &AppHandle, s: Spec) {
    if let Some(w) = app.get_webview_window(s.label) {
        reveal(&w);
        return;
    }
    diag(app, "window.open", &format!("{} {} {}", s.label, thread_desc(), crate::sys::foreground_desc()));
    let b = WebviewWindowBuilder::new(app, s.label, WebviewUrl::App(s.url.into()))
        .title(s.title)
        .inner_size(s.size.0, s.size.1)
        .resizable(s.resizable)
        .always_on_top(s.on_top && !crate::sys::quiet())
        // Tauri のファイルドロップ用ハンドラを切る。入れたままだと、Windows の WebView2 では HTML5 のドラッグ＆ドロップ
        // （フォルダ・項目の移動）の dragover / drop がページに届かず、常に禁止カーソルになる。
        // ファイルのドロップに頼る機能はない（インポートはファイル選択ダイアログ）。
        .disable_drag_drop_handler()
        // 前面でない（トレイ・ホットキーから開いた）ウィンドウで、WebView2 が描画も読み込み完了もしないまま白くなり、
        // クリックすると表示される問題への対策: ウィンドウの遮蔽判定とバックグラウンドの抑制を切る。
        // （全ウィンドウで同じ引数にすること。既定の無効化の機能（msWebOOUI など）は、置き換えないよう残す）
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
    // 自動テスト中は、画面の外に置き、フォーカスを取らず、タスクバーにも出さない（CDP からは今までどおり操作できる）
    let b = if crate::sys::quiet() { b.position(-32000.0, -32000.0).focused(false).skip_taskbar(true).visible(false) } else { b.center() };
    let b = if s.label == "editor" { b.min_inner_size(900.0, 560.0) } else { b };
    // 画面が白いままの時間を調べられるよう、作成から読み込み完了までの時間をログに残す
    let t0 = std::time::Instant::now();
    let t0_epoch = epoch_ms();
    let label = s.label.to_string();
    let loaded = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let loaded_cb = loaded.clone();
    let b = b.on_page_load(move |w, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Started {
            diag(w.app_handle(), "window.started", &format!("{label} {}ms", t0.elapsed().as_millis()));
        }
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            loaded_cb.store(true, std::sync::atomic::Ordering::SeqCst);
            diag(w.app_handle(), "window.loaded", &format!("{label} {}ms", t0.elapsed().as_millis()));
            probe_page(&w, label.clone(), t0_epoch, 15);
            // 読み込みが終わったら、あらためてフォーカスを渡す。強制的な前面化（ALT 空打ち・AttachThreadInput）は、
            // 前面が他のプロセスのとき（拡張から開いたときなど）だけ行う。トレイ・ホットキーからなら、この時点で前面は自分にある
            if !crate::sys::quiet() {
                let _ = w.set_focus();
                let fg = crate::sys::foreground_desc();
                if (diag_force_fg() || !fg.starts_with("fg_self=true")) && !fg.starts_with("fg=none") {
                    if let Ok(h) = w.hwnd() {
                        let r = crate::sys::force_foreground(windows::Win32::Foundation::HWND(h.0));
                        diag(w.app_handle(), "window.forcefg", &format!("{label} loaded {r}"));
                    }
                }
            }
        }
    });
    probe_main_thread(app, s.label.to_string(), t0, loaded.clone());
    let built = b.build();
    diag(app, "window.built", &format!("{} {}ms ok={} {}", s.label, t0.elapsed().as_millis(), built.is_ok(), crate::sys::foreground_desc()));
    if let Ok(w) = built {
        if crate::sys::quiet() {
            park_and_show(&w);
        } else {
            // 作成直後（WebView2 の起動・読み込みの最中）には、強制的な前面化（ALT の空打ち・AttachThreadInput・SetFocus）をしない。
            // 白い画面のまま止まり、マウスを乗せると進む症状は、この操作を入れてから出始めた（入力キューの共有の疑い）。
            // トレイのメニュー・ホットキーから開いた場合は、自プロセスに前面化の権利があるので、通常の set_focus で前面に出る。
            let _ = w.set_focus();
            if diag_force_fg() {
                let r = front(&w);
                diag(app, "window.forcefg", &format!("{} built {r}", s.label));
            }
        }
    }
}

/// 自動テスト中: 画面の外へ移してから、フォーカスを取らずに表示する（作成時の位置指定が効かない場合も、ここで必ず移す）。
fn park_and_show(w: &tauri::WebviewWindow) {
    let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
    if let Ok(h) = w.hwnd() {
        crate::sys::show_inactive(windows::Win32::Foundation::HWND(h.0));
    }
}

/// 既存のウィンドウを表示して前面に出す（自動テスト中は、すでに見えているなら何もしない）。
fn reveal(w: &tauri::WebviewWindow) {
    if crate::sys::quiet() {
        park_and_show(w);
        return;
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    front(w);
}

/// 別のアプリが前面にあっても（トレイ・ホットキーからの操作）、ウィンドウを確実に前面に出す。
fn front(w: &tauri::WebviewWindow) -> String {
    match w.hwnd() {
        Ok(h) => crate::sys::force_foreground(windows::Win32::Foundation::HWND(h.0)),
        Err(_) => "no-hwnd".into(),
    }
}

pub fn open_setup(app: &AppHandle, core: &Arc<Core>) {
    show(app, Spec { label: "setup", url: "setup.html".into(), title: t(&lang(core), "Setup_Title"), size: (640.0, 640.0), resizable: false, on_top: false });
}

/// ロック解除ダイアログ。`then` は解除後に開く画面（`editor` など）。
pub fn open_login(app: &AppHandle, core: &Arc<Core>, then: Option<&str>) {
    let url = match then {
        Some(t) => format!("login.html?then={t}"),
        None => "login.html".to_string(),
    };
    // 開いたままのログイン画面があれば、作り直さずに、続けて開く画面だけ差し替えて前面に出す
    // （破棄してすぐ同じラベルで作ると、作成に失敗することがある）
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.eval(format!("location.replace({url:?})"));
        reveal(&w);
        return;
    }
    show(app, Spec { label: "login", url, title: t(&lang(core), "Login_Title"), size: (420.0, 330.0), resizable: false, on_top: true });
}

pub fn open_editor(app: &AppHandle, core: &Arc<Core>, id: Option<&str>) {
    if core.is_locked() {
        open_login(app, core, Some("editor"));
        return;
    }
    if let Some(w) = app.get_webview_window("editor") {
        reveal(&w);
        if let Some(id) = id {
            let _ = app.emit("select-item", json!({"id": id}));
        }
        return;
    }
    let url = match id {
        Some(id) => format!("editor.html?id={id}"),
        None => "editor.html".to_string(),
    };
    show(app, Spec { label: "editor", url, title: t(&lang(core), "Editor_Title"), size: (1120.0, 720.0), resizable: true, on_top: false });
}

pub fn open_passgen(app: &AppHandle) {
    let lang = app.try_state::<Arc<Core>>().map(|c| lang(&c)).unwrap_or_else(|| "ja".into());
    show(app, Spec { label: "passgen", url: "passgen.html".into(), title: t(&lang, "PassGen_Title"), size: (520.0, 640.0), resizable: true, on_top: false });
}

pub fn open_search(app: &AppHandle, core: &Arc<Core>) {
    show(app, Spec { label: "search", url: "search.html".into(), title: t(&lang(core), "Search_Title"), size: (520.0, 460.0), resizable: false, on_top: true });
}

pub fn open_settings(app: &AppHandle, core: &Arc<Core>) {
    if core.is_locked() {
        open_login(app, core, Some("settings"));
        return;
    }
    show(app, Spec { label: "settings", url: "settings.html".into(), title: t(&lang(core), "Settings_Title"), size: (760.0, 640.0), resizable: true, on_top: false });
}

pub fn open_ext_help(app: &AppHandle, core: &Arc<Core>) {
    show(app, Spec { label: "exthelp", url: "ext-help.html".into(), title: t(&lang(core), "ExtHelp_Title"), size: (600.0, 520.0), resizable: true, on_top: false });
}

pub fn open_appsave(app: &AppHandle, core: &Arc<Core>) {
    if let Some(w) = app.get_webview_window("appsave") {
        let _ = w.destroy();
    }
    show(app, Spec { label: "appsave", url: "appsave.html".into(), title: t(&lang(core), "AppSave_Title"), size: (640.0, 640.0), resizable: true, on_top: true });
}

pub fn open_security(app: &AppHandle, core: &Arc<Core>) {
    if core.is_locked() {
        open_login(app, core, Some("security"));
        return;
    }
    show(app, Spec { label: "security", url: "security.html".into(), title: t(&lang(core), "Security_Title"), size: (820.0, 680.0), resizable: true, on_top: false });
}

pub fn open_about(app: &AppHandle, core: &Arc<Core>) {
    show(app, Spec { label: "about", url: "about.html".into(), title: t(&lang(core), "About_Title"), size: (420.0, 300.0), resizable: false, on_top: false });
}

pub fn open_by_name(app: &AppHandle, core: &Arc<Core>, name: &str) {
    match name {
        "editor" => open_editor(app, core, None),
        "passgen" => open_passgen(app),
        "search" => {
            if core.is_locked() {
                open_login(app, core, Some("search"));
            } else {
                open_search(app, core);
            }
        }
        "settings" => open_settings(app, core),
        // ログイン後に続ける「アプリログインの取り込み」（Ctrl+Alt+A をロック中に押したとき）
        "appcapture" => {
            if let Err(e) = crate::service::capture_app(core, crate::sys::last_foreground()) {
                crate::winfill::notify(app, &e.message);
            }
        }
        "about" => open_about(app, core),
        "security" => open_security(app, core),
        "exthelp" => open_ext_help(app, core),
        "setup" => open_setup(app, core),
        "login" => open_login(app, core, None),
        _ => {}
    }
}

/// グローバルホットキーを登録し直す（§16）。
pub fn apply_hotkeys(core: &Arc<Core>) {
    let Some(app) = core.app.get() else { return };
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let hk = core.prefs().hotkeys;
    let c1 = core.clone();
    let a1 = app.clone();
    let _ = gs.on_shortcut(hk.search.as_str(), move |_app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            open_by_name(&a1, &c1, "search");
        }
    });
    let c3 = core.clone();
    let _ = gs.on_shortcut(hk.save_app.as_str(), move |_app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            crate::service::capture_app_hotkey(&c3);
        }
    });
    let c2 = core.clone();
    let _ = gs.on_shortcut(hk.lock.as_str(), move |_app, _sc, ev| {
        if ev.state == ShortcutState::Pressed {
            c2.lock();
        }
    });
}
