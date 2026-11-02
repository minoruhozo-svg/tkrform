//! tkrform-ipc: Native Messaging / Named Pipe のメッセージ型と、長さ付きフレーミング（§9）。

pub mod frame;
pub mod proto;

#[cfg(windows)]
pub mod pipe;

pub use proto::{Event, Request, Response};
