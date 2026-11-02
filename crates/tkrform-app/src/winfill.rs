//! Windows アプリへの記入（§10.4）。UI Automation で前面ウィンドウの Edit コントロールを読み書きする。
//!
//! - 取り込み（Ctrl+Alt+A）: 前面ウィンドウの exe パス・タイトル・各 Edit の AutomationId と値を取り、保存ダイアログへ渡す。
//! - 記入: `ValuePattern.SetValue`。使えないときはフォーカスして `SendInput`。
//! - 照合: exe のファイル名 + ウィンドウタイトルの部分一致。一致しないウィンドウには書かない。

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};
use tkrform_core::model::{Item, ItemType};
use windows::core::{Interface, BSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId, UIA_ValuePatternId, UIA_ButtonControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};

use crate::core::SvcError;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapturedField {
    pub id: String,
    pub name: String,
    pub value: String,
    pub is_password: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub exe_path: String,
    pub exe_name: String,
    pub title: String,
    pub fields: Vec<CapturedField>,
}

/// 自分自身（TKRForm.exe）か。
pub fn is_self(name: &str) -> bool {
    name.eq_ignore_ascii_case("TKRForm.exe")
}

pub fn exe_of(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize * 2];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

pub fn title_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn automation() -> Result<IUIAutomation, SvcError> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| SvcError::internal(format!("UI Automation を初期化できません: {e}")))
    }
}

fn edits(auto: &IUIAutomation, hwnd: HWND) -> Result<Vec<IUIAutomationElement>, SvcError> {
    let ie = |e: windows::core::Error| SvcError::internal(format!("UI Automation: {e}"));
    unsafe {
        let root = auto.ElementFromHandle(hwnd).map_err(ie)?;
        let cond = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0)).map_err(ie)?;
        let arr = root.FindAll(TreeScope_Descendants, &cond).map_err(ie)?;
        let n = arr.Length().map_err(ie)?;
        let mut v = Vec::new();
        for i in 0..n {
            if let Ok(e) = arr.GetElement(i) {
                // 画面に出ていて、操作できるものだけ
                if e.CurrentIsOffscreen().map(|b| !b.as_bool()).unwrap_or(true) && e.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(true) {
                    v.push(e);
                }
            }
        }
        Ok(v)
    }
}

fn bstr(r: windows::core::Result<BSTR>) -> String {
    r.map(|b| b.to_string()).unwrap_or_default()
}

/// 前面ウィンドウを取り込む。パスワード欄の値は UIA から読めない（空）ので、保存ダイアログで入力する。
pub fn capture(hwnd: HWND) -> Result<Captured, SvcError> {
    let exe_path = exe_of(hwnd).ok_or_else(|| SvcError::internal("ウィンドウのアプリを特定できません"))?;
    let auto = automation()?;
    let mut fields = Vec::new();
    for e in edits(&auto, hwnd)? {
        let is_pw = unsafe { e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) };
        let value = if is_pw {
            String::new()
        } else {
            unsafe { e.GetCurrentPattern(UIA_ValuePatternId).ok().and_then(|p| p.cast::<IUIAutomationValuePattern>().ok()).and_then(|vp| vp.CurrentValue().ok()).map(|b| b.to_string()).unwrap_or_default() }
        };
        fields.push(CapturedField { id: unsafe { bstr(e.CurrentAutomationId()) }, name: unsafe { bstr(e.CurrentName()) }, value, is_password: is_pw });
    }
    Ok(Captured { exe_name: file_name(&exe_path), exe_path, title: title_of(hwnd), fields })
}

/// 保存されたアプリログインを `hwnd` のウィンドウへ記入する。戻り値は記入した欄の数。
pub fn fill(item: &Item, hwnd: HWND, ignored: &[String]) -> Result<usize, SvcError> {
    if item.kind != ItemType::AppLogin {
        return Err(SvcError::internal("アプリログインではありません"));
    }
    let exe = exe_of(hwnd).ok_or_else(|| SvcError::internal("入力先のウィンドウが見つかりません"))?;
    let name = file_name(&exe);
    if ignored.iter().any(|i| i.eq_ignore_ascii_case(&name)) || is_self(&name) {
        return Err(SvcError::new("POLICY_DENIED", format!("{name} は連結しないアプリに設定されています")));
    }
    // 照合: exe のファイル名 + タイトルの部分一致。一致しなければ書かない
    if !file_name(&item.exe_path).eq_ignore_ascii_case(&name) {
        return Err(SvcError::new("URL_MISMATCH", format!("前面のアプリ（{name}）は、このログインのアプリではありません")));
    }
    let title = title_of(hwnd);
    if !item.window_title.is_empty() && !title.to_lowercase().contains(&item.window_title.to_lowercase()) {
        return Err(SvcError::new("URL_MISMATCH", "ウィンドウのタイトルが一致しません"));
    }
    let auto = automation()?;
    let els = edits(&auto, hwnd)?;
    let mut used = vec![false; els.len()];
    let mut n = 0;
    for f in &item.fields {
        if f.value.is_empty() {
            continue;
        }
        let pos = els.iter().enumerate().position(|(i, e)| {
            !used[i] && unsafe {
                (!f.id.is_empty() && bstr(e.CurrentAutomationId()) == f.id) || (f.id.is_empty() && !f.name.is_empty() && bstr(e.CurrentName()) == f.name)
            }
        });
        let Some(i) = pos else { continue };
        used[i] = true;
        let e = &els[i];
        let ok = unsafe {
            e.GetCurrentPattern(UIA_ValuePatternId)
                .ok()
                .and_then(|p| p.cast::<IUIAutomationValuePattern>().ok())
                .map(|vp| vp.SetValue(&BSTR::from(f.value.as_str())).is_ok())
                .unwrap_or(false)
        };
        if !ok {
            // ValuePattern が使えない: フォーカスして Unicode キー入力
            unsafe {
                if e.SetFocus().is_ok() {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    crate::sys::send_text(&f.value).map_err(SvcError::internal)?;
                }
            }
        }
        n += 1;
    }
    if n > 0 && item.submit {
        press_default_button(&auto, hwnd);
    }
    Ok(n)
}

/// 「最後に Enter」ではなく、ボタンを InvokePattern で押す（既定名のものだけ）。見つからなければ Enter。
fn press_default_button(auto: &IUIAutomation, hwnd: HWND) {
    unsafe {
        let Ok(root) = auto.ElementFromHandle(hwnd) else { return };
        let Ok(cond) = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_ButtonControlTypeId.0)) else { return };
        let Ok(arr) = root.FindAll(TreeScope_Descendants, &cond) else { return };
        let names = ["ok", "login", "log in", "sign in", "signin", "ログイン", "サインイン", "ログオン", "次へ", "ｏｋ"];
        for i in 0..arr.Length().unwrap_or(0) {
            if let Ok(b) = arr.GetElement(i) {
                let nm = bstr(b.CurrentName()).to_lowercase();
                if names.iter().any(|x| nm.trim() == *x) {
                    if let Ok(p) = b.GetCurrentPattern(UIA_InvokePatternId).and_then(|p| p.cast::<IUIAutomationInvokePattern>()) {
                        if p.Invoke().is_ok() {
                            return;
                        }
                    }
                }
            }
        }
    }
    let _ = crate::sys::send_enter();
}

pub fn captured_json(c: &Captured) -> Value {
    json!(c)
}

/// ホットキーなど UI のない場面での通知（ダイアログ）。
pub fn notify(app: &tauri::AppHandle, text: &str) {
    use tauri_plugin_dialog::DialogExt;
    if crate::sys::quiet() {
        return; // 自動テスト中は、メッセージボックスを出さない（画面に出て、操作を待ってしまう）
    }
    app.dialog().message(text).title("TKRForm").blocking_show();
}

/// アプリログインからの実行ファイル起動の確認（セキュリティ警告つき）。
pub fn confirm_launch(app: &tauri::AppHandle, exe: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    if crate::sys::quiet() {
        return false; // 自動テスト中は、確認の画面を出さず、許可しない
    }
    app.dialog()
        .message(format!("次のプログラムを起動して、保存したログイン情報を入力します。\n\n{exe}\n\n信頼できるプログラムだけを許可してください。起動しますか？"))
        .title("TKRForm")
        .kind(MessageDialogKind::Warning)
        .blocking_show()
}
