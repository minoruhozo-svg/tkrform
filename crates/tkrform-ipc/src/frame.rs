//! 4 バイトのリトルエンディアン長 + UTF-8 JSON（Chrome Native Messaging と同じ形式）。

use std::io::{self, Read, Write};

/// 1 フレーム読む。EOF（先頭の読み取りで 0 バイト）なら `Ok(None)`。
/// 長さが `max` を超えるフレームは `InvalidData`。
pub fn read_frame<R: Read>(r: &mut R, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut len_buf[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("フレームが大きすぎます: {len} バイト")));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_frame<W: Write>(w: &mut W, payload: &[u8], max: usize) -> io::Result<()> {
    if payload.len() > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "送信メッセージが大きすぎます"));
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    w.write_all(&out)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, "こんにちは".as_bytes(), 1024).unwrap();
        write_frame(&mut buf, b"{}", 1024).unwrap();
        assert_eq!(&buf[..4], &(15u32).to_le_bytes());
        let mut c = Cursor::new(buf);
        assert_eq!(read_frame(&mut c, 1024).unwrap().unwrap(), "こんにちは".as_bytes());
        assert_eq!(read_frame(&mut c, 1024).unwrap().unwrap(), b"{}");
        assert!(read_frame(&mut c, 1024).unwrap().is_none());
    }

    #[test]
    fn rejects_oversize_and_truncated() {
        let mut c = Cursor::new((2000u32).to_le_bytes().to_vec());
        assert_eq!(read_frame(&mut c, 1024).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut c = Cursor::new(vec![5, 0, 0, 0, b'a']);
        assert_eq!(read_frame(&mut c, 1024).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        let mut c = Cursor::new(vec![1, 0]);
        assert_eq!(read_frame(&mut c, 1024).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert!(write_frame(&mut Vec::new(), &[0u8; 10], 5).is_err());
    }

    #[test]
    fn origin_check() {
        use crate::proto::origin_allowed;
        assert!(origin_allowed("chrome-extension://peloncdiaianimbhoficpdcpiooldofd/"));
        assert!(!origin_allowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"));
        assert!(!origin_allowed("https://evil.example/"));
        assert!(!origin_allowed(""));
    }

    #[test]
    fn message_shapes() {
        use crate::proto::*;
        let r: Request = serde_json::from_str(r#"{"id":17,"cmd":"match","args":{"url":"https://x"}}"#).unwrap();
        assert_eq!((r.id, r.cmd.as_str()), (17, "match"));
        let r: Request = serde_json::from_str(r#"{"id":1,"cmd":"lock"}"#).unwrap();
        assert!(r.args.is_null());
        let ok = serde_json::to_string(&Response::ok(1, serde_json::json!({"a":1}))).unwrap();
        assert_eq!(ok, r#"{"id":1,"success":true,"data":{"a":1}}"#);
        let er = serde_json::to_string(&Response::err(2, code::LOCKED, "ロックされています")).unwrap();
        assert!(er.contains(r#""code":"LOCKED""#) && !er.contains("data"));
        let ev = serde_json::to_string(&Event::new("lockState", serde_json::json!({"locked":true}))).unwrap();
        assert_eq!(ev, r#"{"event":"lockState","data":{"locked":true}}"#);
    }
}
