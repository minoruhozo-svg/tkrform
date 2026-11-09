//! Microsoft Store（MSIX パッケージ）版のための処理。パッケージで動いているときだけ使い、インストーラ版の動きは変えない。
//!
//! MSIX のアプリのインストール先（`C:\Program Files\WindowsApps\…`）は、ACL で保護されていて、Chrome / Edge が中の実行ファイルを
//! 起動したり、拡張のフォルダを読んだりできない。そこで、Native Messaging ホストと拡張のフォルダを、パッケージの外
//! （`%LOCALAPPDATA%\tkrform\`）へコピーして使う。このフォルダと NM 登録のレジストリは、マニフェストの宣言で、仮想化しない。

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

fn real_packaged() -> bool {
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
