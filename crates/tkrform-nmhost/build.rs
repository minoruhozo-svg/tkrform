// Windows の実行ファイルに、バージョン情報（製品名・版・説明・会社・著作権）を埋め込む。版は Cargo.toml（CARGO_PKG_VERSION）から来る。
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    // FILEVERSION / PRODUCTVERSION と、FileVersion / ProductVersion は、CARGO_PKG_VERSION から自動で入る
    res.set("ProductName", "TKRForm");
    res.set("FileDescription", "TKRForm Native Messaging Host");
    res.set("CompanyName", "Takara Syscom");
    res.set("LegalCopyright", "Copyright (c) 2026 Takara Syscom");
    res.set("OriginalFilename", "tkrform-nmhost.exe");
    res.set("InternalName", "tkrform-nmhost");
    res.compile().expect("バージョン情報のリソースを埋め込めませんでした");
}
