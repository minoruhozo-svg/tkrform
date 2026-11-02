//! 原子的なファイル書き込み（§6.2）。
//!
//! 一時ファイルに書いて `sync_all` し、同じフォルダ内で `rename` する。
//! Rust の標準ライブラリは Windows で `MoveFileEx` 系（置換あり）を使うため、
//! 既存ファイルは途中状態を見せずに置き換わる。

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn tmp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rnd: [u8; 4] = crate::crypto::random_bytes();
    let suffix: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    path.with_file_name(format!(".{name}.{suffix}.tmp"))
}

/// `before_rename` はテスト用フック。`Err` を返すと「rename 前にクラッシュした」状態を再現するため、
/// 一時ファイルを残したまま `Err` を返す。
pub fn write_atomic_hooked(
    path: &Path,
    bytes: &[u8],
    before_rename: &mut dyn FnMut() -> io::Result<()>,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = tmp_path(path);
    let write = || -> io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    before_rename()?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic_hooked(path, bytes, &mut || Ok(()))
}

/// 前回のクラッシュで残った一時ファイル（`.<name>.<hex>.tmp`）を片付ける。
/// 起動時の検証（§19）で呼ぶ。片付けた数を返す。
pub fn cleanup_stale_tmp(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(".tmp") && fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}
