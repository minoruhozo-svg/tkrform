//! tkrform-nmhost: Chrome/Edge の Native Messaging と Named Pipe を中継する（状態を持たない）。
//!
//! 拡張 ←(stdio, 4 バイト長 + JSON)→ このプロセス ←(Named Pipe)→ TKRForm.exe
//! TKRForm.exe が動いていなければ起動して接続を待つ。

use std::io::{self, Write};
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tkrform_ipc::frame;
use tkrform_ipc::pipe::{self, Conn};
use tkrform_ipc::proto::{code, origin_allowed, NM_MAX_MESSAGE, PIPE_MAX_MESSAGE};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

type SharedConn = Arc<Mutex<Option<Arc<Conn>>>>;
type SharedOut = Arc<Mutex<io::Stdout>>;

fn send_to_browser(out: &SharedOut, v: &Value) {
    if let Ok(bytes) = serde_json::to_vec(v) {
        send_raw(out, &bytes);
    }
}

fn send_raw(out: &SharedOut, bytes: &[u8]) {
    let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = frame::write_frame(&mut *o, bytes, NM_MAX_MESSAGE);
    let _ = o.flush();
}

fn launch_app() {
    if let Ok(exe) = std::env::current_exe() {
        let app = exe.with_file_name("TKRForm.exe");
        let _ = std::process::Command::new(app).arg("--background").creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW).spawn();
    }
}

/// 接続を得る。なければアプリを起動して最大 `wait` 待つ。
/// 接続の作成は常にここだけで行う（読み取りスレッドが別に接続すると、応答が届かなくなる）。
fn ensure_conn(shared: &SharedConn, out: &SharedOut, wait: Duration) -> Option<Arc<Conn>> {
    if let Some(c) = shared.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(c);
    }
    let start = Instant::now();
    let mut launched = false;
    loop {
        if let Ok(c) = pipe::connect() {
            let c = Arc::new(c);
            {
                let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(existing) = g.clone() {
                    return Some(existing);
                }
                *g = Some(c.clone());
            }
            send_to_browser(out, &json!({"event": "connected", "data": {}}));
            return Some(c);
        }
        if !launched {
            launch_app();
            launched = true;
        }
        if start.elapsed() > wait {
            return None;
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn main() {
    // Chrome は第 1 引数に呼び出し元の origin を渡す。許可した拡張以外は終了する。
    let origin = std::env::args().nth(1).unwrap_or_default();
    if !origin_allowed(&origin) {
        eprintln!("許可されていない呼び出し元です");
        std::process::exit(1);
    }

    let out: SharedOut = Arc::new(Mutex::new(io::stdout()));
    let shared: SharedConn = Arc::new(Mutex::new(None));

    // パイプ → ブラウザ。切断されたら破棄し、次の要求で再接続（必要ならアプリを再起動）する。
    {
        let out = out.clone();
        let shared = shared.clone();
        thread::spawn(move || loop {
            let conn = shared.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let Some(conn) = conn else {
                thread::sleep(Duration::from_millis(50));
                continue;
            };
            match conn.read_frame(PIPE_MAX_MESSAGE) {
                Ok(Some(bytes)) => {
                    if bytes.len() > NM_MAX_MESSAGE {
                        // 1MB を超える応答はブラウザへ渡せない
                        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                                send_to_browser(&out, &json!({"id": id, "success": false, "code": code::INTERNAL, "message": "応答が大きすぎます"}));
                            }
                        }
                    } else {
                        send_raw(&out, &bytes);
                    }
                }
                _ => {
                    *shared.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    send_to_browser(&out, &json!({"event": "disconnected", "data": {}}));
                }
            }
        });
    }

    // ブラウザ → パイプ
    let mut stdin = io::stdin().lock();
    // ブラウザが閉じる（EOF）かエラーになるまで続ける
    while let Ok(Some(bytes)) = frame::read_frame(&mut stdin, NM_MAX_MESSAGE * 4) {
        let id = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("id").and_then(Value::as_u64));
        let fail = |msg: &str| {
            if let Some(id) = id {
                send_to_browser(&out, &json!({"id": id, "success": false, "code": code::INTERNAL, "message": msg}));
            }
        };
        let Some(conn) = ensure_conn(&shared, &out, Duration::from_secs(10)) else {
            fail("tkrform に接続できません");
            continue;
        };
        if conn.write_frame(&bytes).is_err() {
            *shared.lock().unwrap_or_else(|e| e.into_inner()) = None;
            fail("tkrform との接続が切れました");
        }
    }
}
