//! Windows 固有の処理: DPAPI、自動起動、NM ホストの登録、アイドル時間、URL を開く。

use std::ffi::c_void;
use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETSCREENSAVERRUNNING, SW_SHOWNORMAL, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const ENTROPY: &[u8] = b"tkrform-device-key-v1";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// DPAPI（CurrentUser）で保護する（§6.3）。
pub fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, 0, &mut out).map_err(|e| e.to_string())?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut c_void)));
        Ok(v)
    }
}

pub fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, Some(&entropy), None, None, 0, &mut out).map_err(|e| e.to_string())?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut c_void)));
        Ok(v)
    }
}

/// 最後の入力からの経過秒数。
pub fn idle_seconds() -> u64 {
    unsafe {
        let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut lii).as_bool() {
            let now = GetTickCount();
            (now.wrapping_sub(lii.dwTime) / 1000) as u64
        } else {
            0
        }
    }
}

pub fn screensaver_running() -> bool {
    unsafe {
        let mut running: i32 = 0;
        SystemParametersInfoW(
            SPI_GETSCREENSAVERRUNNING,
            0,
            Some(&mut running as *mut i32 as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
            && running != 0
    }
}

/// 既定のブラウザで URL を開く。http/https 以外は拒否する。
pub fn open_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.chars().any(|c| c.is_control()) {
        return Err("http/https の URL だけ開けます".into());
    }
    let w = wide(url);
    let op = wide("open");
    let r = unsafe { ShellExecuteW(None, PCWSTR(op.as_ptr()), PCWSTR(w.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    if (r.0 as isize) > 32 {
        Ok(())
    } else {
        Err("ブラウザを開けませんでした".into())
    }
}

/// フォルダをエクスプローラで開く。
pub fn open_folder(path: &Path) {
    let w = wide(&path.to_string_lossy());
    let op = wide("open");
    unsafe {
        let _ = ShellExecuteW(None, PCWSTR(op.as_ptr()), PCWSTR(w.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

/// App Paths から Chrome / Edge の実行ファイルを探す。
fn find_browser_exe(browser: &str) -> Option<PathBuf> {
    let exe = if browser == "edge" { "msedge.exe" } else { "chrome.exe" };
    let key = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    for root in [RegKey::predef(HKEY_CURRENT_USER), RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)] {
        if let Ok(k) = root.open_subkey(&key) {
            if let Ok(v) = k.get_value::<String, _>("") {
                let p = PathBuf::from(v.trim_matches('"'));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// 拡張機能ページ（chrome://extensions、edge://extensions）を開く。シェルを経由せず、引数も限定する。
pub fn open_browser_page(browser: &str, page: &str) {
    if page != "chrome://extensions" && page != "edge://extensions" {
        return;
    }
    if let Some(exe) = find_browser_exe(browser) {
        let _ = std::process::Command::new(exe).arg(page).spawn();
    }
}

/// 新しいウィンドウで URL を開く。Chrome が見つからなければ既定のブラウザで開く。
pub fn open_url_new_window(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.chars().any(|c| c.is_control()) {
        return Err("http/https の URL だけ開けます".into());
    }
    for b in ["chrome", "edge"] {
        if let Some(exe) = find_browser_exe(b) {
            if std::process::Command::new(exe).arg("--new-window").arg(url).spawn().is_ok() {
                return Ok(());
            }
        }
    }
    open_url(url)
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// 自動テスト（TKRFORM_TEST）中は、レジストリの Run キーを書き換えない。
pub fn testing() -> bool {
    std::env::var_os("TKRFORM_TEST").is_some()
}

/// 自動テスト中は、利用者の作業を邪魔しないよう、前面化・フォーカスの取得・OS への入力を行わない（ウィンドウは画面の外に置く）。
/// OS への実入力を使うテスト（winapp など）だけが、環境変数 TKRFORM_E2E_INTERACTIVE=1 で解除する。
pub fn quiet() -> bool {
    testing() && std::env::var_os("TKRFORM_E2E_INTERACTIVE").is_none()
}

/// Windows ログオン時の自動起動（HKCU Run。Store 版は windows.startupTask）。いま有効になっているか（なっていなければ false）を返す。
pub fn set_autostart(enable: bool) -> bool {
    if testing() {
        return enable;
    }
    if crate::msix::is_packaged() {
        return crate::msix::set_startup_task(enable);
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enable {
        if let (Ok((key, _)), Ok(exe)) = (hkcu.create_subkey(RUN_KEY), std::env::current_exe()) {
            let _ = key.set_value("tkrform", &format!("\"{}\" --background", exe.display()));
        }
    } else if let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE) {
        let _ = key.delete_value("tkrform");
    }
    enable
}

/// NM ホストのマニフェストを書いて HKCU に登録する（Chrome と Edge）。何度呼んでもよい。
pub fn register_native_host(data_root: &Path) -> Result<PathBuf, String> {
    if testing() && std::env::var_os("TKRFORM_REGISTER_NM").is_none() {
        return Err("テスト中のため登録しません".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut host = exe.with_file_name("tkrform-nmhost.exe");
    let dir = data_root.join("nm");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if crate::msix::is_packaged() {
        // Store 版: インストール先は、Chrome が実行も読み取りもできない。NM ホストと拡張のフォルダを、パッケージの外へコピーして使う
        // （使用中で置き換えられなければ、前のコピーを使い続ける）
        let copy = dir.join("tkrform-nmhost.exe");
        if let Err(e) = crate::msix::copy_if_changed(&host, &copy) {
            if !copy.is_file() {
                return Err(format!("NM ホストをコピーできません: {e}"));
            }
        }
        host = copy;
        // ホストが、アプリを起動するための ID（パッケージのアプリは、実行ファイルのパスでは起動できない）
        // 裏で起動する入口の ID（接続役が起動するときに、画面や Windows Hello を出させないため）
        if let Some(id) = crate::msix::app_user_model_id() {
            let _ = std::fs::write(dir.join("app-id.txt"), crate::msix::background_aumid(&id));
        }
        if let Some(ext) = exe.parent().map(|p| p.join("extension")).filter(|p| p.is_dir()) {
            let _ = crate::msix::copy_dir_if_changed(&ext, &data_root.join("extension"));
        }
    } else {
        let _ = std::fs::remove_file(dir.join("app-id.txt")); // インストーラ版では、使わない（Store 版の残りがあれば消す）
    }
    let manifest_path = dir.join(format!("{}.json", tkrform_ipc::proto::HOST_NAME));
    let origins: Vec<String> =
        tkrform_ipc::proto::ALLOWED_EXTENSION_IDS.iter().map(|id| format!("chrome-extension://{id}/")).collect();
    let manifest = serde_json::json!({
        "name": tkrform_ipc::proto::HOST_NAME,
        "description": "tkrform Native Messaging Host",
        "path": host.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });
    let text = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    // 内容が同じなら書き直さない
    if std::fs::read(&manifest_path).ok().as_deref() != Some(text.as_slice()) {
        tkrform_core::fsutil::write_atomic(&manifest_path, &text).map_err(|e| e.to_string())?;
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for base in [r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Microsoft\Edge\NativeMessagingHosts"] {
        let path = format!(r"{base}\{}", tkrform_ipc::proto::HOST_NAME);
        let (key, _) = hkcu.create_subkey(&path).map_err(|e| e.to_string())?;
        key.set_value("", &manifest_path.to_string_lossy().to_string()).map_err(|e| e.to_string())?;
    }
    Ok(manifest_path)
}

// ---------------------------------------------------------------- 直前にアクティブだった欄へ入力（パスワード生成器の「記入」）

use std::sync::atomic::{AtomicIsize, Ordering};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow};

static LAST_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

/// トレイ・メニュー・タイトルのないウィンドウは「入力先」ではない。
fn is_app_window(h: HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowTextLengthW};
    unsafe {
        if GetWindowTextLengthW(h) == 0 {
            return false;
        }
        let mut buf = [0u16; 128];
        let n = GetClassNameW(h, &mut buf);
        let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        !matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow" | "TopLevelWindowForOverflowXamlIsland" | "#32768" | "XamlExplorerHostIslandWindow" | "Progman" | "WorkerW")
    }
}

/// 直前に前面にあった（自プロセス以外の）ウィンドウ。
pub fn last_foreground() -> Option<HWND> {
    let raw = LAST_FOREGROUND.load(Ordering::Relaxed);
    if raw == 0 {
        return None;
    }
    let h = HWND(raw as *mut c_void);
    unsafe { IsWindow(Some(h)).as_bool().then_some(h) }
}

/// いま前面にあるウィンドウ（自プロセスのものは除く）。
pub fn foreground_now() -> Option<HWND> {
    unsafe {
        let h = GetForegroundWindow();
        if h.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        (pid != GetCurrentProcessId()).then_some(h)
    }
}

/// 自プロセス以外の最前面ウィンドウを記録し続ける。
pub fn start_foreground_tracker() {
    std::thread::Builder::new()
        .name("tkrform-foreground".into())
        .spawn(|| {
            let me = unsafe { GetCurrentProcessId() };
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                unsafe {
                    let h = GetForegroundWindow();
                    if h.0.is_null() {
                        continue;
                    }
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(h, Some(&mut pid));
                    if pid != me && is_app_window(h) {
                        LAST_FOREGROUND.store(h.0 as isize, Ordering::Relaxed);
                    }
                }
            }
        })
        .ok();
}

/// 記録しておいたウィンドウを前面に戻し、`text` を 1 文字ずつ入力する（Unicode キー入力）。
pub fn type_into_last_window(text: &str) -> Result<(), String> {
    if quiet() {
        return Err("自動テスト中は、ほかのウィンドウへ入力しません".into());
    }
    let raw = LAST_FOREGROUND.load(Ordering::Relaxed);
    if raw == 0 {
        return Err("入力先のウィンドウが見つかりません".into());
    }
    let hwnd = HWND(raw as *mut c_void);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("入力先のウィンドウが閉じられています".into());
        }
        let _ = SetForegroundWindow(hwnd);
    }
    std::thread::sleep(std::time::Duration::from_millis(250));
    send_text(text)
}

/// Enter キーを押す。
pub fn send_enter() -> Result<(), String> {
    if quiet() {
        return Err("自動テスト中は、ほかのウィンドウへ入力しません".into());
    }
    let mk = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0x0D), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [mk(false), mk(true)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() { Ok(()) } else { Err("入力に失敗しました".into()) }
}

/// いまフォーカスのある欄へ、Unicode キー入力で文字列を送る。
pub fn send_text(text: &str) -> Result<(), String> {
    if quiet() {
        return Err("自動テスト中は、ほかのウィンドウへ入力しません".into());
    }
    let mut inputs: Vec<INPUT> = Vec::new();
    for unit in text.encode_utf16() {
        for up in [false, true] {
            let mut flags = KEYEVENTF_UNICODE;
            if up {
                flags |= KEYEVENTF_KEYUP;
            }
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            });
        }
    }
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err("入力に失敗しました".into());
    }
    Ok(())
}

/// タイトルに `needle` を含む、表示中のトップレベルウィンドウを探す（自動テスト・対象指定用）。
pub fn find_window_by_title(needle: &str) -> Option<HWND> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, IsWindowVisible};
    struct Ctx {
        needle: String,
        found: Option<HWND>,
    }
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        let ctx = &mut *(l.0 as *mut Ctx);
        if IsWindowVisible(h).as_bool() && crate::winfill::title_of(h).to_lowercase().contains(&ctx.needle) {
            ctx.found = Some(h);
            return false.into();
        }
        true.into()
    }
    let mut ctx = Ctx { needle: needle.to_lowercase(), found: None };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.found
}

/// いま前面にあるウィンドウの概要（調査ログ用。タイトルは記録しない）: 自プロセスか、クラス名、スレッド ID、呼び出し元のスレッド ID。
pub fn foreground_desc() -> String {
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    unsafe {
        let me = GetCurrentThreadId();
        let h = GetForegroundWindow();
        if h.0.is_null() {
            return format!("fg=none me_tid={me}");
        }
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(h, Some(&mut pid));
        let mut buf = [0u16; 128];
        let n = GetClassNameW(h, &mut buf).max(0) as usize;
        format!("fg_self={} fg_class={} fg_tid={tid} me_tid={me}", pid == GetCurrentProcessId(), String::from_utf16_lossy(&buf[..n]))
    }
}

/// ウィンドウを前面に出す。別のアプリ（ブラウザ）が前面にあると SetForegroundWindow は拒否されることがあるため、
/// ALT キーの空打ちで「直前に入力があった」状態にしてから呼ぶ（よく知られた回避策）。
/// 戻り値は調査ログ用の概要（どのスレッドの入力キューにつないだか、など）。
pub fn force_foreground(hwnd: HWND) -> String {
    if quiet() {
        return "quiet".into();
    }
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, BringWindowToTop, SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW};
    use windows::Win32::System::Threading::AttachThreadInput;
    unsafe {
        let mk = |up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0x12), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, time: 0, dwExtraInfo: 0 } },
        };
        let _ = SendInput(&[mk(false), mk(true)], std::mem::size_of::<INPUT>() as i32);
        let _ = AllowSetForegroundWindow(u32::MAX); // ASFW_ANY
        // 今の前面ウィンドウの入力キューにつなぐと、前面化が拒否されにくい（トレイやホットキーからの呼び出し対策）
        let fg = GetForegroundWindow();
        let fg_tid = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let me = GetCurrentThreadId();
        let attached = fg_tid != 0 && fg_tid != me && AttachThreadInput(me, fg_tid, true).as_bool();
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        let _ = BringWindowToTop(hwnd);
        let setfg = SetForegroundWindow(hwnd).as_bool();
        let mut detached = false;
        if attached {
            let _ = SetFocus(Some(hwnd));
            detached = AttachThreadInput(me, fg_tid, false).as_bool();
        }
        let mut fg_pid = 0u32;
        if !fg.0.is_null() {
            GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        }
        format!("me_tid={me} fg_tid={fg_tid} fg_self={} attached={attached} detached={detached} setfg={setfg}", fg_pid == GetCurrentProcessId())
    }
}

/// 指定クラス名の可視トップレベルウィンドウを探し、最前面に出す。見つけたら "class=... title=..." を返す。
/// （Windows Hello の確認画面が他のウィンドウの裏に出るのを防ぐ。）
/// 指定のクラス名の、可視のトップレベルウィンドウを探す。同じクラスの不可視のウィンドウ（古いホストなど）が先に見つかっても、
/// 可視のものを返す（FindWindow は最初の 1 つしか返さないため、使わない）。
pub fn find_visible_by_class(class: &str) -> Option<HWND> {
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, IsWindowVisible};
    struct Ctx {
        class: Vec<u16>,
        found: Option<HWND>,
    }
    unsafe extern "system" fn cb(h: HWND, l: windows::Win32::Foundation::LPARAM) -> BOOL {
        unsafe {
            let ctx = &mut *(l.0 as *mut Ctx);
            if !IsWindowVisible(h).as_bool() {
                return true.into();
            }
            let mut cn = [0u16; 128];
            let n = GetClassNameW(h, &mut cn).max(0) as usize;
            if cn[..n] == ctx.class[..] {
                ctx.found = Some(h);
                return false.into();
            }
            true.into()
        }
    }
    let mut ctx = Ctx { class: class.encode_utf16().collect(), found: None };
    unsafe {
        let _ = EnumWindows(Some(cb), windows::Win32::Foundation::LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.found
}

/// そのウィンドウが、いま前面か。
pub fn is_foreground(h: HWND) -> bool {
    unsafe { GetForegroundWindow() == h }
}

pub fn bring_dialog_to_front(class: &str) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowTextW, IsIconic, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };
    unsafe {
        let h = find_visible_by_class(class)?;
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        force_foreground(h);
        // 最前面のまま残す（手前固定の自分のウィンドウより上に出し続ける）。確認画面は、操作が終わると閉じられる
        let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        let mut cn = [0u16; 128];
        let mut ti = [0u16; 128];
        let cl = GetClassNameW(h, &mut cn).max(0) as usize;
        let tl = GetWindowTextW(h, &mut ti).max(0) as usize;
        Some(format!("class={} title={}", String::from_utf16_lossy(&cn[..cl]), String::from_utf16_lossy(&ti[..tl])))
    }
}

/// フォーカスを取らずにウィンドウを表示する（自動テスト用。位置や大きさは変えない）。
pub fn show_inactive(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW};
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

/// 試験用: 対話的なデスクトップ（ログイン中のユーザーの画面）が要る試験を、飛ばすか。
/// GitHub Actions などの CI（環境変数 `CI` が空でない）には、ウィンドウを見られるデスクトップがないので、理由を出して飛ばす。
/// 手元の PC（`CI` なし）では、飛ばさずに実行する。
#[cfg(test)]
pub fn skip_without_desktop(test: &str) -> bool {
    let ci = std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false);
    if ci {
        eprintln!("skip {test}: CI には対話的なデスクトップがないため（ウィンドウの作成・列挙に依存する試験）");
    }
    ci
}
