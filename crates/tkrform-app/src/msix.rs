//! Microsoft Store（MSIX パッケージ）版のための処理。パッケージで動いているときだけ使い、インストーラ版の動きは変えない。
//!
//! MSIX のアプリのインストール先（`C:\Program Files\WindowsApps\…`）は、ACL で保護されていて、Chrome / Edge が中の実行ファイルを
//! 起動したり、拡張のフォルダを読んだりできない。そこで、Native Messaging ホストと拡張のフォルダを、パッケージの外
//! （`%LOCALAPPDATA%\tkrform\`）へコピーして使う。
//!
//! パッケージのアプリ自身が書くと、HKCU と、%LOCALAPPDATA% の直下に新しく作るフォルダは仮想化され（パッケージの中にしか
//! 見えず）、Chrome / Edge から見えない。仮想化を止める宣言（制限付きの unvirtualizedResources）は使わず、データのフォルダの作成と
//! HKCU の登録は、パッケージの外で動かした cmd.exe / reg.exe にさせる（`make_dirs_outside` / `register_keys_outside`）。

use std::io;
use std::path::Path;
use std::sync::OnceLock;

use tkrform_core::fsutil;

/// 自動起動のタスク名（AppxManifest.xml の `desktop:StartupTask` の TaskId と同じ）。
pub const STARTUP_TASK_ID: &str = "TKRFormStartup";

/// パッケージ（MSIX）で動いているか。自動テスト中だけ、環境変数 `TKRFORM_FORCE_PACKAGED` で、動いているものとして扱える。
pub fn is_packaged() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| real_packaged() || (crate::sys::testing() && std::env::var_os("TKRFORM_FORCE_PACKAGED").is_some()))
}

/// 本物のパッケージで動いているか（自動テストの「ふり」は含まない）。
pub fn real_packaged() -> bool {
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    const APPMODEL_ERROR_NO_PACKAGE: WIN32_ERROR = WIN32_ERROR(15700);
    let mut len = 0u32;
    // パッケージがなければ APPMODEL_ERROR_NO_PACKAGE。あれば、バッファが足りない（122）が返る
    unsafe { GetCurrentPackageFullName(&mut len, None) != APPMODEL_ERROR_NO_PACKAGE }
}

/// このアプリのアプリケーションユーザーモデル ID（`<パッケージファミリー名>!<アプリ ID>`）。NM ホストが、アプリを起動するのに使う。
pub fn app_user_model_id() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;
    unsafe {
        let mut len = 0u32;
        let _ = GetCurrentApplicationUserModelId(&mut len, None);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if GetCurrentApplicationUserModelId(&mut len, Some(PWSTR(buf.as_mut_ptr()))).0 != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// 置き換えのときに、使用中のファイルを退避した名前に付ける印（`<名前>.old-<pid>-<時刻>`）。
const OLD_MARK: &str = ".old-";

/// `src` の内容を `dst` へコピーする。`dst` がなければ作り、内容が同じなら何もしない。書き込みは、一時ファイルに書いてから置き換える。
/// 使用中（Chrome が NM ホストを動かしているなど）で置き換えられないときは、既存の `dst` を同じフォルダの別名（`.old-…`）に
/// 改名してから書く（Windows では、実行中の exe も、名前は変えられる）。旧版を動かしている接続は、そのまま動き続ける。
/// 退避したファイルは、あとで `remove_old_copies` が消す。改名もできなければ、エラーを返す（呼び出し側は、前のものを使い続ける）。
pub fn copy_if_changed(src: &Path, dst: &Path) -> io::Result<bool> {
    let bytes = std::fs::read(src)?;
    if std::fs::read(dst).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(false);
    }
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p)?;
    }
    if fsutil::write_atomic(dst, &bytes).is_ok() {
        return Ok(true);
    }
    let mut old = dst.as_os_str().to_owned();
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    old.push(format!("{OLD_MARK}{}-{ms}", std::process::id()));
    std::fs::rename(dst, &old)?;
    if let Err(e) = fsutil::write_atomic(dst, &bytes) {
        let _ = std::fs::rename(&old, dst); // 書けなければ、元に戻す
        return Err(e);
    }
    Ok(true)
}

/// `dir`（サブフォルダも）にある、`copy_if_changed` が退避した古いファイル（`*.old-*`）を消す。使用中で消せないものは、そのままにする。
pub fn remove_old_copies(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            remove_old_copies(&path);
        } else if e.file_name().to_string_lossy().contains(OLD_MARK) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// フォルダの中身を、`dst` へ（サブフォルダも）コピーする。内容が同じファイルは書き直さない。コピーまたは更新したファイルの数を返す。
pub fn copy_dir_if_changed(src: &Path, dst: &Path) -> io::Result<usize> {
    let mut n = 0;
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            n += copy_dir_if_changed(&e.path(), &to)?;
        } else if copy_if_changed(&e.path(), &to)? {
            n += 1;
        }
    }
    Ok(n)
}

/// 自動起動（`windows.startupTask`）を、設定に合わせる。オンにできたか（利用者が、タスクマネージャーなどで無効にしていたら、できない）を返す。
pub fn set_startup_task(enable: bool) -> bool {
    use windows::core::HSTRING;
    use windows::ApplicationModel::{StartupTask, StartupTaskState};
    let Some(task) = StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID)).ok().and_then(|o| o.join().ok()) else {
        return false;
    };
    if enable {
        task.RequestEnableAsync().and_then(|o| o.join()).map(|s| s == StartupTaskState::Enabled || s == StartupTaskState::EnabledByPolicy).unwrap_or(false)
    } else {
        let _ = task.Disable();
        false
    }
}

/// 起動が、自動起動（`windows.startupTask`）によるものか。そうなら、画面を出さずに常駐だけする（`--background` と同じ）。
pub fn started_by_startup_task() -> bool {
    use windows::ApplicationModel::Activation::ActivationKind;
    use windows::ApplicationModel::AppInstance;
    is_packaged() && AppInstance::GetActivatedEventArgs().ok().and_then(|a| a.Kind().ok()).map(|k| k == ActivationKind::StartupTask).unwrap_or(false)
}

// ---------------------------------------------------------------- パッケージの外での NM 登録
//
// Store 版のアプリ自身が HKCU に書くと、仮想化されて（パッケージの中にしか見えず）、Chrome / Edge から見えない。
// そこで、パッケージの外で動かした cmd.exe / reg.exe（System32）に、フォルダの作成と HKCU の登録をさせる。
//
// 外で動かす方法: CreateProcess に PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY で
// PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE を付ける。文書では「起動した子の、さらに子を外で動かす」指定だが、
// Windows 11（Build 26300）の実機では、起動した子そのもの（cmd.exe）が外で動いた（書き込みが仮想化されない）。
// パッケージの中の exe（TKRForm.exe 自身）を同じ指定で起動しても、パッケージの中で動いた（使えない）。
// 外で動いたかは、このプロセスが HKCU に書いた目印（仮想化され、パッケージの中にしか見えない）が、子から見えないことで確かめる。

/// パッケージの中か外かを見分ける目印を書く、HKCU のキーと値の名前。
const MARKER_KEY: &str = r"Software\TKRForm\RegisterNm";
const MARKER_VALUE: &str = "Marker";

/// Chrome / Edge が NM ホストを探す、HKCU のキー（この下に、ホスト名のキーを作る）。
pub const NM_KEYS: [&str; 2] = [r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Microsoft\Edge\NativeMessagingHosts"];

/// コマンド（cmd.exe の書き方）を、パッケージの外で動く cmd.exe で実行し、出力（標準出力とエラー出力）を返す。
/// 外で動かせなかった（目印が見えた）ときは、エラーを返す。
fn run_outside(script: &str) -> Result<String, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let marker = format!("tkrform-{}-{ms}", std::process::id());
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(MARKER_KEY)
        .and_then(|(k, _)| k.set_value(MARKER_VALUE, &marker))
        .map_err(|e| format!("目印を書けません: {e}"))?;
    let sysroot = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let cmd_exe = sysroot.join("System32").join("cmd.exe");
    let full = format!("{script} & reg query \"HKCU\\{MARKER_KEY}\" /v {MARKER_VALUE}");
    let cmdline = format!("\"{}\" /d /s /c \"{full}\"", cmd_exe.display());
    let (_code, out) = spawn_breakaway(&cmd_exe, &cmdline).map_err(|e| format!("パッケージの外で cmd.exe を起動できません: {e}"))?;
    let out = oem_to_string(&out);
    if out.contains(&marker) {
        return Err("パッケージの外で動かせませんでした（書き込みが仮想化されます）".into());
    }
    Ok(out)
}

/// フォルダを、パッケージの外で（本物の場所に）作る。
///
/// アプリが %LOCALAPPDATA% の直下に新しく作るフォルダは、パッケージの中（LocalCache）へ回される。本物のフォルダが先にあれば、
/// その中にアプリが作るファイル・フォルダは、仮想化されない（Windows 11 Build 26300 の実機で確認。
/// installer\msix\verify-virtualization.ps1 が確かめる）。このため、アプリが書く前に、ここで本物のフォルダを作っておく。
pub fn make_dirs_outside(dirs: &[&Path]) -> Result<(), String> {
    let script = dirs.iter().map(|d| format!("(if not exist \"{0}\" mkdir \"{0}\")", d.display())).collect::<Vec<_>>().join(" & ");
    let check = dirs.iter().enumerate().map(|(i, d)| format!("(if exist \"{}\" echo TKRFORM-DIR-OK-{i})", d.display())).collect::<Vec<_>>().join(" & ");
    let out = run_outside(&format!("{script} & {check}"))?;
    for (i, d) in dirs.iter().enumerate() {
        if !out.contains(&format!("TKRFORM-DIR-OK-{i}")) {
            return Err(format!("フォルダを、パッケージの外で作れません: {}（{}）", d.display(), out.trim()));
        }
    }
    Ok(())
}

/// NM ホストのマニフェスト（`manifest`）を、パッケージの外の reg.exe で HKCU に登録する。外から、レジストリを読み直し、
/// マニフェストと NM ホスト（`host`）のファイルがあることを確かめる。
pub fn register_keys_outside(host_name: &str, manifest: &Path, host: &Path) -> Result<(), String> {
    let m = manifest.display().to_string();
    let mut script = Vec::new();
    for base in NM_KEYS {
        let k = format!(r"HKCU\{base}\{host_name}");
        script.push(format!("reg add \"{k}\" /ve /t REG_SZ /d \"{m}\" /f >nul"));
        script.push(format!("reg query \"{k}\" /ve"));
    }
    script.push(format!("(if exist \"{m}\" echo TKRFORM-MANIFEST-OK)"));
    script.push(format!("(if exist \"{}\" echo TKRFORM-HOST-OK)", host.display()));
    let out = run_outside(&script.join(" & "))?;
    // reg query の出力は、キー名の行と「    (既定)    REG_SZ    <値>」の行。出力は OEM のコード ページなので、
    // その文字で表せないパスなら、ファイル名の部分だけで比べる
    let name = manifest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let matches = |l: &str| {
        let l = l.trim_end();
        l.contains("REG_SZ") && (l.ends_with(&m) || (!m.is_ascii() && l.ends_with(&name)))
    };
    if out.lines().filter(|l| matches(l)).count() != NM_KEYS.len() {
        return Err(format!("レジストリが、書いたとおりになっていません: {}", out.trim()));
    }
    if !out.contains("TKRFORM-MANIFEST-OK") {
        return Err(format!("{m} が、パッケージの外から見えません"));
    }
    if !out.contains("TKRFORM-HOST-OK") {
        return Err(format!("{} が、パッケージの外から見えません", host.display()));
    }
    Ok(())
}

/// コンソールのプログラム（cmd.exe / reg.exe）の出力（OEM のコード ページ）を、文字列にする。
fn oem_to_string(b: &[u8]) -> String {
    use windows::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
    if b.is_empty() {
        return String::new();
    }
    unsafe {
        let n = MultiByteToWideChar(CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), b, None);
        if n <= 0 {
            return String::from_utf8_lossy(b).into_owned();
        }
        let mut w = vec![0u16; n as usize];
        let n = MultiByteToWideChar(CP_OEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), b, Some(&mut w));
        String::from_utf16_lossy(&w[..n.max(0) as usize])
    }
}

/// `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`（ProcThreadAttributeValue(18, FALSE, TRUE, FALSE)）。
const PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY: usize = 0x0002_0012;
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`（ProcThreadAttributeValue(2, FALSE, TRUE, FALSE)）。
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
/// `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE`
const DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE: u32 = 0x01;

/// `exe` を、パッケージの外へ出る指定（`DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE`）を付けて起動し、終わるまで（最大 60 秒）待つ。
/// 終了コードと、標準出力（バイト列）を返す。
fn spawn_breakaway(exe: &Path, cmdline: &str) -> Result<(u32, Vec<u8>), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0};
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::Storage::FileSystem::ReadFile;
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() };
        let (mut rd, mut wr) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut rd, &mut wr, Some(&sa), 0).map_err(|e| e.to_string())?;
        let close_both = |rd: HANDLE, wr: HANDLE| {
            let _ = CloseHandle(rd);
            let _ = CloseHandle(wr);
        };
        if let Err(e) = SetHandleInformation(rd, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) {
            close_both(rd, wr);
            return Err(e.to_string());
        }
        let mut size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
        let mut buf = vec![0u8; size.max(64)];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr() as *mut _);
        if let Err(e) = InitializeProcThreadAttributeList(Some(list), 2, None, &mut size) {
            close_both(rd, wr);
            return Err(e.to_string());
        }
        let policy: u32 = DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE;
        let handles = [wr];
        let r = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, Some(&policy as *const u32 as *const _), std::mem::size_of::<u32>(), None, None)
            .and_then(|_| UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, Some(handles.as_ptr() as *const _), std::mem::size_of_val(&handles), None, None));
        if let Err(e) = r {
            DeleteProcThreadAttributeList(list);
            close_both(rd, wr);
            return Err(e.to_string());
        }
        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdOutput = wr;
        si.StartupInfo.hStdError = wr;
        si.lpAttributeList = list;
        let exe_w: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut cmd_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
        let mut pi = PROCESS_INFORMATION::default();
        let created = CreateProcessW(
            PCWSTR(exe_w.as_ptr()),
            Some(PWSTR(cmd_w.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            None,
            PCWSTR::null(),
            &si.StartupInfo,
            &mut pi,
        );
        DeleteProcThreadAttributeList(list);
        let _ = CloseHandle(wr); // 子だけが書き込み口を持つ（子が終われば、読み終わる）
        if let Err(e) = created {
            let _ = CloseHandle(rd);
            return Err(e.to_string());
        }
        let _ = CloseHandle(pi.hThread);
        let waited = WaitForSingleObject(pi.hProcess, 60_000);
        if waited != WAIT_OBJECT_0 {
            let _ = TerminateProcess(pi.hProcess, 1);
        }
        let mut out = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let mut n = 0u32;
            if ReadFile(rd, Some(&mut chunk), Some(&mut n), None).is_err() || n == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..n as usize]);
        }
        let _ = CloseHandle(rd);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(pi.hProcess, &mut code);
        let _ = CloseHandle(pi.hProcess);
        if waited != WAIT_OBJECT_0 {
            return Err("時間内に終わりませんでした".into());
        }
        Ok((code, out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_if_changed_copies_updates_and_skips_same() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("a.exe");
        let dst = tmp.path().join("nm").join("a.exe");
        std::fs::write(&src, b"v1").unwrap();
        assert!(copy_if_changed(&src, &dst).unwrap(), "なければ作る");
        assert_eq!(std::fs::read(&dst).unwrap(), b"v1");
        assert!(!copy_if_changed(&src, &dst).unwrap(), "同じなら何もしない");
        std::fs::write(&src, b"v2-new").unwrap();
        assert!(copy_if_changed(&src, &dst).unwrap(), "版が変わったら上書きする");
        assert_eq!(std::fs::read(&dst).unwrap(), b"v2-new");
    }

    /// 実行中の exe（ping.exe のコピー）でも、置き換えられる。旧版は動き続け、退避した古いファイルは、終わったあとで消せる。
    #[test]
    fn copy_if_changed_replaces_running_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let ping = std::path::Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| "C:/Windows".into())).join("System32").join("PING.EXE");
        let dst = tmp.path().join("nm").join("tkrform-nmhost.exe");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::copy(&ping, &dst).unwrap();
        let mut child = std::process::Command::new(&dst).args(["-n", "8", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let src = tmp.path().join("new.exe");
        std::fs::write(&src, b"new host").unwrap();
        assert!(copy_if_changed(&src, &dst).unwrap(), "使用中でも、置き換えられる");
        assert_eq!(std::fs::read(&dst).unwrap(), b"new host");
        let olds = |d: &Path| std::fs::read_dir(d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(OLD_MARK)).count();
        assert_eq!(olds(dst.parent().unwrap()), 1, "旧版は、別名で残る");
        remove_old_copies(tmp.path());
        assert_eq!(olds(dst.parent().unwrap()), 1, "使用中のものは、消せないのでそのまま");
        let _ = child.kill();
        let _ = child.wait();
        remove_old_copies(tmp.path());
        assert_eq!(olds(dst.parent().unwrap()), 0, "使い終わったら、消える");
    }

    #[test]
    fn copy_dir_if_changed_copies_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("extension");
        std::fs::create_dir_all(src.join("_locales").join("ja")).unwrap();
        std::fs::write(src.join("manifest.json"), b"{}").unwrap();
        std::fs::write(src.join("_locales").join("ja").join("messages.json"), b"{\"a\":1}").unwrap();
        let dst = tmp.path().join("copy");
        assert_eq!(copy_dir_if_changed(&src, &dst).unwrap(), 2);
        assert_eq!(std::fs::read(dst.join("_locales").join("ja").join("messages.json")).unwrap(), b"{\"a\":1}");
        assert_eq!(copy_dir_if_changed(&src, &dst).unwrap(), 0, "2 回目は何も書かない");
        std::fs::write(src.join("manifest.json"), b"{\"v\":2}").unwrap();
        assert_eq!(copy_dir_if_changed(&src, &dst).unwrap(), 1, "変わったファイルだけ書く");
    }

    #[test]
    fn not_packaged_in_unit_tests() {
        assert!(!is_packaged(), "単体テストはパッケージの外で動く");
    }
}
