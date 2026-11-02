//! tkrform-core: 暗号・保管庫・モデル・照合・生成器・TOTP・インポート/エクスポート（UI 非依存）。

pub mod crypto;
pub mod error;
pub mod fsutil;
pub mod generator;
pub mod model;
pub mod passkey;
pub mod portio;
pub mod sync;
pub mod prefs;
pub mod security;
pub mod throttle;
pub mod totp;
pub mod update;
pub mod urlmatch;
pub mod vault;

pub use error::{Error, Result};
pub use model::{Item, ItemType};
pub use vault::{IndexEntry, Vault};
