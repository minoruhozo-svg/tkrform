//! クリップボード。秘密は履歴・クラウド同期に残さず、設定した秒数後に「まだ同じ値なら」消す（§8.5）。

use crate::core::Core;

pub fn copy(core: &Core, text: &str, secret: bool) -> Result<(), String> {
    use arboard::{Clipboard, SetExtWindows};
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    if secret {
        cb.set().exclude_from_history().exclude_from_cloud().text(text.to_string()).map_err(|e| e.to_string())?;
    } else {
        cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    }
    let secs = core.prefs().security.clipboard_clear_secs;
    if secret && secs > 0 {
        let text = text.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(u64::from(secs)));
            if let Ok(mut cb) = Clipboard::new() {
                if cb.get_text().map(|t| t == text).unwrap_or(false) {
                    let _ = cb.clear();
                }
            }
        });
    }
    Ok(())
}
