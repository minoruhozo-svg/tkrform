//! メッセージ型（§9）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Native Messaging ホスト名。
pub const HOST_NAME: &str = "jp.tkrs.tkrform";

/// 拡張 ID（`extension/manifest.json` の `key` から決まる固定値。`tools/ext-id.txt`）。
/// NM ホストはこの拡張からの接続だけを受け付ける（`allowed_origins` と二重に確認する）。
pub const ALLOWED_EXTENSION_IDS: &[&str] = &["peloncdiaianimbhoficpdcpiooldofd"];

/// Chrome の NM は 1 メッセージ最大 1MB（ホスト → ブラウザ）。
pub const NM_MAX_MESSAGE: usize = 1024 * 1024;
/// パイプ側の上限。
pub const PIPE_MAX_MESSAGE: usize = 8 * 1024 * 1024;

pub mod code {
    pub const LOCKED: &str = "LOCKED";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const URL_MISMATCH: &str = "URL_MISMATCH";
    pub const BAD_PASSWORD: &str = "BAD_PASSWORD";
    pub const RATE_LIMITED: &str = "RATE_LIMITED";
    pub const POLICY_DENIED: &str = "POLICY_DENIED";
    pub const INTERNAL: &str = "INTERNAL";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub id: u64,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Response {
    pub fn ok(id: u64, data: Value) -> Response {
        Response { id, success: true, data: Some(data), code: None, message: None }
    }

    pub fn err(id: u64, code: &str, message: &str) -> Response {
        Response { id, success: false, data: None, code: Some(code.to_string()), message: Some(message.to_string()) }
    }
}

/// プッシュ（id なし）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub event: String,
    #[serde(default)]
    pub data: Value,
}

impl Event {
    pub fn new(event: &str, data: Value) -> Event {
        Event { event: event.to_string(), data }
    }
}

/// `chrome-extension://<id>/` 形式の origin が許可された拡張か。
pub fn origin_allowed(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .map(|r| r.trim_end_matches('/'))
        .map(|id| ALLOWED_EXTENSION_IDS.contains(&id))
        .unwrap_or(false)
}
