//! 自動ロックの契機（§7.3）: Windows のロック/ユーザー切替、スタンバイ/休止、スクリーンセーバー、無操作時間、全ブラウザ終了。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, CW_USEDEFAULT, MSG,
    WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
};

use crate::core::Core;
use crate::sys;

static CORE: OnceLock<Arc<Core>> = OnceLock::new();

const WM_POWERBROADCAST: u32 = 0x0218;
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const PBT_APMSUSPEND: usize = 4;
const WTS_CONSOLE_DISCONNECT: usize = 2;
const WTS_REMOTE_DISCONNECT: usize = 4;
const WTS_SESSION_LOCK: usize = 7;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if let Some(core) = CORE.get() {
        let sec = core.prefs().security;
        match msg {
            WM_WTSSESSION_CHANGE if sec.lock_on_session_lock => {
                // 画面ロック・ユーザー切替・切断で即ロックする（拡張へは lockState が 3 秒以内に届く）
                if matches!(wparam.0, WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT) {
                    core.lock();
                }
            }
            WM_POWERBROADCAST if sec.lock_on_suspend && wparam.0 == PBT_APMSUSPEND => core.lock(),
            _ => {}
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn log_err(what: &str) {
    if let Some(core) = CORE.get() {
        core.log(what, &std::io::Error::last_os_error().to_string());
    }
}

fn message_thread() {
    unsafe {
        let Ok(hinst) = GetModuleHandleW(PCWSTR::null()) else { return };
        // テスト中は、利用者の実行中インスタンスと取り違えないようクラス名にパイプ名の接尾辞を付ける
        let class_name: Vec<u16> = format!("TkrformEventSink{}", tkrform_ipc::pipe::test_suffix()).encode_utf16().chain(std::iter::once(0)).collect();
        let class = PCWSTR(class_name.as_ptr());
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst.into(), lpszClassName: class, ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            log_err("events.class.failed");
            return;
        }
        // 非表示の通常ウィンドウ（メッセージ専用ウィンドウは電源通知のブロードキャストを受け取れない）
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("tkrform"),
            WINDOW_STYLE(0),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            0,
            0,
            None,
            None,
            Some(hinst.into()),
            None,
        ) else {
            log_err("events.window.failed");
            return;
        };
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

pub fn start(core: &Arc<Core>) {
    let _ = CORE.set(core.clone());
    std::thread::Builder::new().name("tkrform-events".into()).spawn(message_thread).ok();

    // 無操作・スクリーンセーバー・ブラウザ終了の監視
    let core = core.clone();
    std::thread::Builder::new()
        .name("tkrform-autolock".into())
        .spawn(move || {
            let mut had_clients = false;
            let mut zero_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                if core.is_locked() {
                    had_clients = false;
                    zero_since = None;
                    continue;
                }
                let sec = core.prefs().security;
                if sec.auto_lock_minutes > 0 && sys::idle_seconds() >= u64::from(sec.auto_lock_minutes) * 60 {
                    core.lock();
                    continue;
                }
                if sec.lock_on_screensaver && sys::screensaver_running() {
                    core.lock();
                    continue;
                }
                if sec.lock_on_browsers_closed {
                    // NM ホストはブラウザが閉じると終了する。接続が 0 になって 5 秒続いたらロックする
                    let n = core.pipe.get().map(|p| p.client_count()).unwrap_or(0);
                    if n > 0 {
                        had_clients = true;
                        zero_since = None;
                    } else if had_clients {
                        let t = *zero_since.get_or_insert_with(std::time::Instant::now);
                        if t.elapsed() >= Duration::from_secs(5) {
                            core.lock();
                        }
                    }
                }
            }
        })
        .ok();
}
