use tkrform_core::update::*;

#[test]
fn manifest_validation() {
    let ok = r#"{"version":"0.2.0","url":"https://example.com/tkrform-setup-0.2.0.exe","sha256":"0000000000000000000000000000000000000000000000000000000000000000","notes":"修正"}"#;
    assert_eq!(parse_manifest(ok).unwrap().version, "0.2.0");
    assert!(parse_manifest(&ok.replace("https://example.com", "http://example.com")).is_err(), "http は不可");
    assert!(parse_manifest(&ok.replace("https://example.com", "http://localhost")).is_ok(), "localhost は可（テスト用）");
    assert!(parse_manifest(&ok.replace("0.2.0\",\"url", "x.y\",\"url")).is_err());
    assert!(parse_manifest(&ok.replace("0000000000000000000000000000000000000000000000000000000000000000", "abc")).is_err());
    assert!(parse_manifest("{}").is_err());
}

#[test]
fn version_compare() {
    assert!(is_newer("0.2.0", "0.1.9"));
    assert!(is_newer("v1.0", "0.9.9.9"));
    assert!(is_newer("0.1.10", "0.1.9"), "数値で比べる");
    assert!(!is_newer("0.1.0", "0.1.0"));
    assert!(!is_newer("0.1", "0.1.0"));
    assert!(!is_newer("0.0.9", "0.1.0"));
    assert!(!is_newer("garbage", "0.1.0"));
    // 0.1.0 → 0.2.0 の更新が見つかり、0.2.0 から古い版への更新は見つからない
    assert!(is_newer("0.2.0", "0.1.0"));
    assert!(is_newer("0.2.1", "0.2.0"));
    assert!(!is_newer("0.1.0", "0.2.0"));
    assert!(!is_newer("0.2.0", "0.2.0"));
}

#[test]
fn sha256_verification() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("setup.exe");
    std::fs::write(&p, b"hello installer").unwrap();
    let h = sha256_file(&p).unwrap();
    assert_eq!(h.len(), 64);
    assert!(verify_file(&p, &h).is_ok());
    assert!(verify_file(&p, &h.to_uppercase()).is_ok());
    std::fs::write(&p, b"tampered installer").unwrap();
    assert!(verify_file(&p, &h).is_err(), "改変されたファイルは不一致");
}

#[test]
fn latest_json_sits_next_to_sync_php() {
    assert_eq!(latest_url_from("https://x.example/tkrform/sync.php").unwrap(), "https://x.example/tkrform/latest.json");
}
