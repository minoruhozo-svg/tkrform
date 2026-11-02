//! Windows Hello でのロック解除（§6.3）。
//!
//! `KeyCredentialManager` で資格情報（鍵ペア）を作り、固定の challenge に署名する。署名は同じ challenge なら常に同じ値なので、
//! そこから鍵を導いて KEK を包み、`hello.key` に保存する。解除時は Windows Hello の確認（PIN・生体認証）を通して
//! 署名を取り直し、KEK を取り出す。MP も KEK も、Hello の確認なしには取り出せない。
//!
//! 注意: 確認のダイアログは対話操作が必要なため、自動テストでは検証できない（対応可否の確認までテストする）。

use windows::core::HSTRING;
use windows::Security::Credentials::{KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus};
use windows::Storage::Streams::{DataReader, DataWriter};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::core::SvcError;

const CHALLENGE: &[u8] = b"tkrform-windows-hello-challenge-v1/0123456789abcdef";

fn name(account: &str) -> HSTRING {
    HSTRING::from(format!("tkrform-{account}"))
}

fn init() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

/// 失敗の段階（open: 資格情報を開く / sign: 署名の確認）と HRESULT を、日本語の説明つきで返す。
/// 一時的な失敗（もう一度やれば通る可能性が高いもの）なら、第 1 要素が true。
fn stage_err(stage: &str, e: &windows::core::Error) -> (bool, SvcError) {
    let c = e.code().0 as u32;
    let (transient, why) = match c {
        0x8009_8044 => (true, "生体認証の確認が無効になりました（WINBIO_E_INVALID_TICKET）。確認の画面が前面に出る前に始まったか、画面のロック直後の可能性があります。もう一度試してください"),
        0x8009_8045 => (true, "生体認証の確認の要求が多すぎます（WINBIO_E_TICKET_QUOTA_EXCEEDED）。少し待ってもう一度試してください"),
        0x8009_0030 => (true, "セキュリティデバイスの準備ができていません（NTE_DEVICE_NOT_READY）。少し待ってもう一度試してください"),
        0x8009_000D | 0x8009_0016 => (false, "Windows Hello の資格情報が壊れているか、見つかりません。設定で登録し直してください"),
        0x8007_0005 => (false, "Windows Hello を使う権限がありません（アクセス拒否）"),
        _ => (false, "Windows Hello の確認に失敗しました"),
    };
    (transient, SvcError::internal(format!("Windows Hello（{stage}）: {why} [0x{c:08X}]")))
}

fn stage_label(stage: &str, other: &str) -> SvcError {
    SvcError::internal(format!("Windows Hello（{stage}）: {other}"))
}

/// 自動テスト専用の差し替え（TKRFORM_TEST のときだけ有効。本番では常に None）。
/// 環境変数 TKRFORM_HELLO_STUB_FILE のファイルの中身（ok / fail / cancel）を、呼ぶたびに読む。
fn stub() -> Option<Result<Vec<u8>, SvcError>> {
    if !crate::sys::testing() {
        return None;
    }
    let path = std::env::var("TKRFORM_HELLO_STUB_FILE").ok()?;
    let mode = std::fs::read_to_string(path).unwrap_or_default();
    Some(match mode.trim() {
        "ok" => Ok(b"stub-windows-hello-signature".to_vec()),
        "cancel" => Err(SvcError::internal("Windows Hello の確認がキャンセルされました")),
        _ => Err(SvcError::internal("Windows Hello の署名に失敗しました（テスト用の失敗）")),
    })
}

/// この PC で Windows Hello（PIN・生体認証）が使えるか。
pub fn is_supported() -> bool {
    if stub().is_some() {
        return true;
    }
    init();
    KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
}

/// Hello の確認画面（別プロセスが作るウィンドウ）のクラス名。
const DIALOG_CLASS: &str = "Credential Dialog Xaml Host";

/// 監視の結果（ログ用）。core が `take_notes` で取り出して記録する。
static NOTES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn take_notes() -> Vec<String> {
    std::mem::take(&mut *NOTES.lock().unwrap_or_else(|e| e.into_inner()))
}

fn note(s: String) {
    NOTES.lock().unwrap_or_else(|e| e.into_inner()).push(s);
}

/// Hello の要求中だけ、確認画面を探して最前面に出す見張り。Drop（要求の終了）で必ず止まる。
/// 確認画面は別のプロセスが作り、他のウィンドウの裏に出ることがあるため。
pub struct DialogWatch {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    th: Option<std::thread::JoinHandle<()>>,
}

impl DialogWatch {
    pub fn start() -> Self {
        Self::start_class(DIALOG_CLASS, 10_000)
    }

    pub fn start_class(class: &'static str, max_ms: u64) -> Self {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let st = stop.clone();
        let th = std::thread::spawn(move || {
            let t0 = std::time::Instant::now();
            while !st.load(std::sync::atomic::Ordering::Relaxed) && t0.elapsed().as_millis() < max_ms as u128 {
                if let Some(info) = crate::sys::bring_dialog_to_front(class) {
                    note(format!("hello.dialog.found {info} after={}ms", t0.elapsed().as_millis()));
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if !st.load(std::sync::atomic::Ordering::Relaxed) {
                note(format!("hello.dialog.notfound class={class}"));
            }
        });
        DialogWatch { stop, th: Some(th) }
    }
}

impl Drop for DialogWatch {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.th.take() {
            let _ = t.join();
        }
    }
}

type Staged<T> = Result<T, (bool, SvcError)>;

fn sign_with(cred: &windows::Security::Credentials::KeyCredential) -> Staged<Vec<u8>> {
    let e0 = |e: windows::core::Error| stage_err("sign", &e);
    let w = DataWriter::new().map_err(e0)?;
    w.WriteBytes(CHALLENGE).map_err(e0)?;
    let buf = w.DetachBuffer().map_err(e0)?;
    let res = cred.RequestSignAsync(&buf).map_err(e0)?.join().map_err(e0)?;
    match res.Status().map_err(e0)? {
        KeyCredentialStatus::Success => {
            let sig = res.Result().map_err(e0)?;
            let r = DataReader::FromBuffer(&sig).map_err(e0)?;
            let mut bytes = vec![0u8; r.UnconsumedBufferLength().map_err(e0)? as usize];
            r.ReadBytes(&mut bytes).map_err(e0)?;
            Ok(bytes)
        }
        KeyCredentialStatus::UserCanceled => Err((false, SvcError::internal("Windows Hello の確認がキャンセルされました"))),
        other => Err((false, stage_label("sign", &format!("署名に失敗しました（{other:?}）")))),
    }
}

/// 資格情報を作り（既存は置き換え）、challenge に署名して返す。確認ダイアログが出る。
/// 作成や署名が一時的に失敗したら、少し待って 1 回だけやり直す（署名は、作った資格情報を開き直して行う）。
pub fn enroll(account: &str) -> Result<Vec<u8>, SvcError> {
    if let Some(r) = stub() {
        return r;
    }
    init();
    if !is_supported() {
        return Err(SvcError::internal("この PC では Windows Hello を利用できません（PIN や生体認証を Windows に設定してください）"));
    }
    match enroll_once(account) {
        Err((true, _)) => {
            std::thread::sleep(std::time::Duration::from_millis(800));
            enroll_once(account).map_err(|(_, e)| e)
        }
        r => r.map_err(|(_, e)| e),
    }
}

fn enroll_once(account: &str) -> Staged<Vec<u8>> {
    let _watch = DialogWatch::start();
    let e0 = |e: windows::core::Error| stage_err("create", &e);
    let r = KeyCredentialManager::RequestCreateAsync(&name(account), KeyCredentialCreationOption::ReplaceExisting).map_err(e0)?.join().map_err(e0)?;
    match r.Status().map_err(e0)? {
        KeyCredentialStatus::Success => match sign_with(&r.Credential().map_err(e0)?) {
            // 作った直後の署名が一時的に失敗したら、資格情報を開き直して署名する
            Err((true, _)) => {
                std::thread::sleep(std::time::Duration::from_millis(800));
                sign_once(account)
            }
            r => r,
        },
        KeyCredentialStatus::UserCanceled => Err((false, SvcError::internal("Windows Hello の確認がキャンセルされました"))),
        other => Err((false, stage_label("create", &format!("資格情報を作成できません（{other:?}）")))),
    }
}

/// 既存の資格情報で challenge に署名する（解除時）。確認ダイアログが出る。
/// 一時的な失敗（前面に出ていない・確認の期限切れなど）なら、少し待って 1 回だけやり直す。
pub fn sign(account: &str) -> Result<Vec<u8>, SvcError> {
    if let Some(r) = stub() {
        return r;
    }
    init();
    match sign_once(account) {
        Err((true, _)) => {
            std::thread::sleep(std::time::Duration::from_millis(800));
            sign_once(account).map_err(|(_, e)| e)
        }
        r => r.map_err(|(_, e)| e),
    }
}

fn sign_once(account: &str) -> Staged<Vec<u8>> {
    let _watch = DialogWatch::start();
    let e0 = |e: windows::core::Error| stage_err("open", &e);
    let r = KeyCredentialManager::OpenAsync(&name(account)).map_err(e0)?.join().map_err(e0)?;
    match r.Status().map_err(e0)? {
        KeyCredentialStatus::Success => sign_with(&r.Credential().map_err(e0)?),
        KeyCredentialStatus::NotFound => Err((false, SvcError::internal("Windows Hello の登録が見つかりません。設定で登録し直してください"))),
        KeyCredentialStatus::UserCanceled => Err((false, SvcError::internal("Windows Hello の確認がキャンセルされました"))),
        other => Err((false, stage_label("open", &format!("資格情報を開けません（{other:?}）")))),
    }
}

/// 資格情報を削除する（設定をオフにしたとき）。失敗しても無視する。
pub fn delete(account: &str) {
    if stub().is_some() {
        return;
    }
    init();
    if let Ok(op) = KeyCredentialManager::DeleteAsync(&name(account)) {
        let _ = op.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn proc(h: windows::Win32::Foundation::HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(h, m, w, l) }
    }

    /// ダミーの確認画面（同じクラス名の可視ウィンドウ）を作り、見張りが見つけて記録することを確かめる。
    // NOTES は共有なので、テストを直列にする
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn watch_finds_dialog_window() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_notes();
        let th = std::thread::spawn(|| unsafe {
            let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: HINSTANCE::default(), lpszClassName: w!("TkrformTestDialogClass"), ..Default::default() };
            RegisterClassW(&wc);
            let h = CreateWindowExW(Default::default(), w!("TkrformTestDialogClass"), w!("test"), WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 100, 100, None, None, None, None).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = DestroyWindow(h);
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        {
            let _w = DialogWatch::start_class("TkrformTestDialogClass", 3000);
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
        th.join().unwrap();
        let notes = take_notes();
        assert!(notes.iter().any(|n| n.starts_with("hello.dialog.found") && n.contains("TkrformTestDialogClass")), "{notes:?}");
    }

    #[test]
    fn watch_stops_and_reports_notfound() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_notes();
        let _w = DialogWatch::start_class("TkrformNoSuchClass", 300);
        std::thread::sleep(std::time::Duration::from_millis(700));
        drop(_w);
        assert!(take_notes().iter().any(|n| n.starts_with("hello.dialog.notfound")));
    }
}
