//! 設定（§16）。`preferences.json` に保存する。秘密は含めない（暗号化しない）。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::crypto::DEFAULT_ITERATIONS;
use crate::error::Result;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct General {
    pub language: String,
    pub start_with_windows: bool,
    /// ログインの並べ方: auto | count | recent
    pub sort_order: String,
    /// 更新の確認（起動時と 24 時間ごと）。既定はオフ（オンにしたときだけ、配布元に問い合わせる）
    pub check_updates: bool,
    /// latest.json の URL（空なら同期サーバと同じ場所）
    pub update_url: String,
}

impl Default for General {
    fn default() -> Self {
        General { language: "ja".into(), start_with_windows: true, sort_order: "auto".into(), check_updates: false, update_url: String::new() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoFill {
    /// off | suggest | auto
    pub mode: String,
    /// both | logins | identities
    pub target: String,
    pub only_on_password_pages: bool,
    pub min_identity_fields: u32,
    pub include_contacts: bool,
    pub basic_auth: bool,
    pub inline_menu: bool,
    /// Web サイトのパスキーを tkrform に保存し、ログインに使う
    pub passkeys: bool,
    /// パスキーを扱わないサイト（ドメイン名、または URL の一部）
    pub passkey_exclude: Vec<String>,
}

impl Default for AutoFill {
    fn default() -> Self {
        AutoFill {
            mode: "suggest".into(),
            target: "both".into(),
            only_on_password_pages: true,
            min_identity_fields: 3,
            include_contacts: false,
            basic_auth: true,
            inline_menu: true,
            passkeys: true,
            passkey_exclude: vec![],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoSave {
    /// off | suggest | auto
    pub mode: String,
    pub force_dialog: bool,
    pub exclude_urls: Vec<String>,
}

impl Default for AutoSave {
    fn default() -> Self {
        AutoSave { mode: "suggest".into(), force_dialog: true, exclude_urls: vec![] }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Apps {
    pub link_apps: bool,
    pub ignored_apps: Vec<String>,
    pub allow_exec: bool,
}

impl Default for Apps {
    fn default() -> Self {
        Apps {
            link_apps: true,
            ignored_apps: ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "WindowsTerminal.exe", "TKRForm.exe"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            allow_exec: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Security {
    /// 無操作 N 分でロック（0 = 無制限）
    pub auto_lock_minutes: u32,
    pub lock_on_session_lock: bool,
    pub lock_on_screensaver: bool,
    pub lock_on_suspend: bool,
    pub lock_on_browsers_closed: bool,
    pub remember_mp: bool,
    pub iterations: u32,
    pub clipboard_clear_secs: u32,
    /// 漏洩チェック（HIBP）。既定オフ。オンにするときは同意画面を経る（§13）
    pub breach_check: bool,
    /// 同意した日時（空なら未同意）
    pub breach_consent: String,
    /// Windows Hello でロック解除する（§6.3）
    pub windows_hello: bool,
}

impl Default for Security {
    fn default() -> Self {
        Security {
            auto_lock_minutes: 60,
            lock_on_session_lock: true,
            lock_on_screensaver: true,
            lock_on_suspend: true,
            lock_on_browsers_closed: false,
            remember_mp: false,
            iterations: DEFAULT_ITERATIONS,
            clipboard_clear_secs: 30,
            breach_check: false,
            breach_consent: String::new(),
            windows_hello: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Sync {
    pub enabled: bool,
    pub server_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub search: String,
    pub save_app: String,
    pub lock: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Hotkeys { search: "Ctrl+Alt+S".into(), save_app: "Ctrl+Alt+A".into(), lock: "Ctrl+Alt+L".into() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Backup {
    pub auto: bool,
    pub generations: u32,
    /// 保存先フォルダ。空なら既定（保管庫のフォルダの backups）。専用のコマンド（backupSetDir）でだけ変える
    pub dir: String,
    /// 以前の保存先（既存のバックアップが残っている場所。自動では移動も削除もしない）
    pub prev_dirs: Vec<String>,
}

impl Default for Backup {
    fn default() -> Self {
        Backup { auto: true, generations: 10, dir: String::new(), prev_dirs: vec![] }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub general: General,
    pub autofill: AutoFill,
    pub autosave: AutoSave,
    pub apps: Apps,
    pub security: Security,
    pub sync: Sync,
    /// 同等ドメインの表（§8.2-4）
    pub equiv_domains: Vec<Vec<String>>,
    pub hotkeys: Hotkeys,
    pub backup: Backup,
}

impl Preferences {
    pub fn load(path: &Path) -> Preferences {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        crate::fsutil::write_atomic(path, &serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }

    /// 将来の `policy.json`（§17）による上書き。トップレベルからの再帰マージで、ポリシーにあるキーが優先する。
    pub fn with_policy(&self, policy: &serde_json::Value) -> Preferences {
        let mut base = serde_json::to_value(self).unwrap_or_default();
        merge(&mut base, policy);
        serde_json::from_value(base).unwrap_or_else(|_| self.clone())
    }
}

fn merge(a: &mut serde_json::Value, b: &serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(ao), serde_json::Value::Object(bo)) => {
            for (k, v) in bo {
                merge(ao.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b.clone(),
    }
}
