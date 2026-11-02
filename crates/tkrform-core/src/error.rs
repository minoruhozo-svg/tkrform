//! エラー型。

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("マスターパスワードが違います")]
    BadPassword,
    #[error("保管庫ヘッダが壊れています: {0}")]
    CorruptHeader(String),
    #[error("アイテムが破損しています: {0}")]
    CorruptItem(String),
    #[error("アイテムが見つかりません: {0}")]
    NotFound(String),
    #[error("保管庫が既に存在します")]
    AlreadyExists,
    #[error("保管庫が存在しません")]
    NoVault,
    #[error("入力が不正です: {0}")]
    Invalid(String),
    #[error("入出力エラー: {0}")]
    Io(#[from] io::Error),
    #[error("JSON エラー: {0}")]
    Json(#[from] serde_json::Error),
    #[error("CSV エラー: {0}")]
    Csv(#[from] csv::Error),
    #[error("ZIP エラー: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub type Result<T> = std::result::Result<T, Error>;
