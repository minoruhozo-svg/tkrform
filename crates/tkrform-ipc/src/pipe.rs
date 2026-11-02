//! Named Pipe `\\.\pipe\tkrform-<SID>`（§9）。ACL は現在のユーザーだけに許可する。
//!
//! 同期ハンドルは、ある スレッドが `ReadFile` で待っている間、同じハンドルへの `WriteFile` も待たされる。
//! 応答の途中でプッシュ（`lockState` など）を書けるよう、読み取りは `PeekNamedPipe` で
//! データの有無を確かめてから行う（待ち時間は 1ms〜20ms の適応型ポーリング）。

use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE,
    HLOCAL, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::frame;
use crate::proto::{Event, Request, Response, PIPE_MAX_MESSAGE};

/// 現在のユーザーの SID 文字列（`S-1-5-21-...`）。
pub fn current_user_sid() -> io::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(io::Error::other)?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let r = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut c_void), len, &mut len);
        let _ = CloseHandle(token);
        r.map_err(io::Error::other)?;
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = PWSTR::null();
        ConvertSidToStringSidW(tu.User.Sid, &mut s).map_err(io::Error::other)?;
        let out = s.to_string().map_err(io::Error::other);
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut c_void)));
        out
    }
}

/// 自動テスト用: 利用者の tkrform と同時に動かせるよう、環境変数 TKRFORM_PIPE_SUFFIX でパイプ名を変える。
pub fn test_suffix() -> String {
    std::env::var("TKRFORM_PIPE_SUFFIX").ok().filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric())).map(|s| format!("-{s}")).unwrap_or_default()
}

pub fn pipe_name() -> io::Result<String> {
    Ok(format!(r"\\.\pipe\tkrform-{}{}", current_user_sid()?, test_suffix()))
}

/// パイプ 1 本分の接続。読みはポーリング、書きは Mutex で直列化する。
pub struct Conn {
    file: File,
    wlock: Mutex<()>,
}

impl Conn {
    fn new(file: File) -> Conn {
        Conn { file, wlock: Mutex::new(()) }
    }

    /// 読めるバイト数。相手が切断していれば `None`。
    fn available(&self) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        let h = HANDLE(self.file.as_raw_handle());
        let mut avail = 0u32;
        match unsafe { PeekNamedPipe(h, None, 0, None, Some(&mut avail), None) } {
            Ok(()) => Some(avail),
            // ERROR_BROKEN_PIPE などは相手の切断。それ以外のエラーも読めない状態なので切断として扱う
            Err(_) => None,
        }
    }

    fn read_exact_poll(&self, buf: &mut [u8], eof_ok_at_start: bool) -> io::Result<bool> {
        let mut got = 0;
        let mut wait = 1u64;
        while got < buf.len() {
            match self.available() {
                None => {
                    return if got == 0 && eof_ok_at_start { Ok(false) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
                }
                Some(0) => {
                    thread::sleep(Duration::from_millis(wait));
                    wait = (wait * 2).min(20);
                }
                Some(n) => {
                    wait = 1;
                    let take = (n as usize).min(buf.len() - got);
                    let n = (&self.file).read(&mut buf[got..got + take])?;
                    if n == 0 {
                        return if got == 0 && eof_ok_at_start { Ok(false) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
                    }
                    got += n;
                }
            }
        }
        Ok(true)
    }

    /// 1 フレーム読む。切断されたら `Ok(None)`。
    pub fn read_frame(&self, max: usize) -> io::Result<Option<Vec<u8>>> {
        let mut len = [0u8; 4];
        if !self.read_exact_poll(&mut len, true)? {
            return Ok(None);
        }
        let n = u32::from_le_bytes(len) as usize;
        if n > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "フレームが大きすぎます"));
        }
        let mut buf = vec![0u8; n];
        self.read_exact_poll(&mut buf, false)?;
        Ok(Some(buf))
    }

    pub fn write_frame(&self, payload: &[u8]) -> io::Result<()> {
        let _g = self.wlock.lock().unwrap_or_else(|e| e.into_inner());
        let mut f = &self.file;
        frame::write_frame(&mut f, payload, PIPE_MAX_MESSAGE)
    }
}

/// クライアント側の接続（NM ホストが使う）。
pub fn connect() -> io::Result<Conn> {
    let name = pipe_name()?;
    let f = OpenOptions::new().read(true).write(true).open(name)?;
    Ok(Conn::new(f))
}

pub type Handler = dyn Fn(Request) -> Response + Send + Sync;

/// 接続されたときに呼ぶ（現在の状態をプッシュするため）。
pub type OnConnect = dyn Fn(&Conn) + Send + Sync;

pub struct PipeServer {
    clients: Arc<Mutex<Vec<Arc<Conn>>>>,
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
unsafe impl Send for SecurityDescriptor {}

fn create_instance(name: &[u16], sa: &SECURITY_ATTRIBUTES, first: bool) -> io::Result<HANDLE> {
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        // 同名パイプの先取り（なりすまし）を防ぐ
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let h = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            Some(sa as *const SECURITY_ATTRIBUTES),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(h)
    }
}

impl PipeServer {
    /// パイプを作って待ち受けを始める。既に別プロセスが同名パイプを持っていればエラー。
    pub fn start(handler: Arc<Handler>, on_connect: Option<Arc<OnConnect>>) -> io::Result<PipeServer> {
        let sid = current_user_sid()?;
        let name: Vec<u16> = format!(r"\\.\pipe\tkrform-{sid}{}", test_suffix()).encode_utf16().chain(std::iter::once(0)).collect();
        // 現在のユーザーだけに全アクセスを許可（保護された DACL）
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})").encode_utf16().chain(std::iter::once(0)).collect();
        let mut psd = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut psd, None)
                .map_err(io::Error::other)?;
        }
        let sd = SecurityDescriptor(psd);
        let first = create_instance(&name, &make_sa(&sd), true)?;
        let clients: Arc<Mutex<Vec<Arc<Conn>>>> = Arc::new(Mutex::new(Vec::new()));
        let server = PipeServer { clients: clients.clone() };
        let first_raw = first.0 as usize;
        thread::Builder::new().name("tkrform-pipe-accept".into()).spawn(move || {
            let sd = sd;
            let sa = make_sa(&sd);
            let mut next = Some(HANDLE(first_raw as *mut c_void));
            loop {
                let h = match next.take() {
                    Some(h) => h,
                    None => match create_instance(&name, &sa, false) {
                        Ok(h) => h,
                        Err(_) => {
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    },
                };
                let connected = unsafe { ConnectNamedPipe(h, None) };
                let ok = connected.is_ok() || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if !ok {
                    unsafe {
                        let _ = CloseHandle(h);
                    }
                    continue;
                }
                let file = unsafe { File::from_raw_handle(h.0 as RawHandle) };
                let conn = Arc::new(Conn::new(file));
                if let Some(oc) = &on_connect {
                    oc(&conn);
                }
                clients.lock().unwrap_or_else(|e| e.into_inner()).push(conn.clone());
                let handler = handler.clone();
                let clients2 = clients.clone();
                let _ = thread::Builder::new().name("tkrform-pipe-conn".into()).spawn(move || {
                    serve_conn(&conn, &handler);
                    clients2.lock().unwrap_or_else(|e| e.into_inner()).retain(|c| !Arc::ptr_eq(c, &conn));
                });
            }
        })?;
        Ok(server)
    }

    /// 接続中の全クライアントへプッシュする。
    pub fn broadcast(&self, ev: &Event) {
        let Ok(bytes) = serde_json::to_vec(ev) else { return };
        let list: Vec<Arc<Conn>> = self.clients.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for c in list {
            let _ = c.write_frame(&bytes);
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

fn make_sa(sd: &SecurityDescriptor) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0 .0, bInheritHandle: false.into() }
}

fn serve_conn(conn: &Conn, handler: &Arc<Handler>) {
    loop {
        let bytes = match conn.read_frame(PIPE_MAX_MESSAGE) {
            Ok(Some(b)) => b,
            _ => return,
        };
        let resp = match serde_json::from_slice::<Request>(&bytes) {
            Ok(req) => {
                let id = req.id;
                let h = handler.clone();
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || h(req)))
                    .unwrap_or_else(|_| Response::err(id, crate::proto::code::INTERNAL, "内部エラー"))
            }
            Err(_) => Response::err(0, crate::proto::code::INTERNAL, "要求の形式が不正です"),
        };
        let Ok(out) = serde_json::to_vec(&resp) else { return };
        if conn.write_frame(&out).is_err() {
            return;
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::Response;

    #[test]
    fn server_client_round_trip_and_push() {
        let handler: Arc<Handler> = Arc::new(|r: Request| {
            if r.cmd == "echo" {
                Response::ok(r.id, r.args)
            } else {
                Response::err(r.id, "NOT_FOUND", "no")
            }
        });
        let on_connect: Arc<OnConnect> = Arc::new(|c: &Conn| {
            let _ = c.write_frame(br#"{"event":"hello","data":{}}"#);
        });
        let server = match PipeServer::start(handler, Some(on_connect)) {
            Ok(s) => s,
            Err(_) => return, // 実行中の tkrform が同名パイプを持っている場合はスキップ
        };
        let c = connect().unwrap();
        // 接続直後のプッシュ
        let first = c.read_frame(1 << 20).unwrap().unwrap();
        assert!(String::from_utf8(first).unwrap().contains("hello"));
        let req = serde_json::to_vec(&Request { id: 7, cmd: "echo".into(), args: serde_json::json!({"x": "日本語"}) }).unwrap();
        c.write_frame(&req).unwrap();
        let r: Response = serde_json::from_slice(&c.read_frame(1 << 20).unwrap().unwrap()).unwrap();
        assert!(r.success && r.id == 7);
        assert_eq!(r.data.unwrap()["x"], "日本語");
        // サーバからのプッシュ（クライアントが待機中でも書ける）
        while server.client_count() == 0 {
            thread::sleep(Duration::from_millis(5));
        }
        server.broadcast(&Event::new("lockState", serde_json::json!({"locked": true})));
        let ev: Event = serde_json::from_slice(&c.read_frame(1 << 20).unwrap().unwrap()).unwrap();
        assert_eq!(ev.event, "lockState");
        // 切断
        drop(c);
        let t = std::time::Instant::now();
        while server.client_count() != 0 && t.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(server.client_count(), 0);
    }
}
