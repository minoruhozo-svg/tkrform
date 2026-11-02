fn main() {
    // 版は Cargo.toml の 1 か所から来る。tauri.conf.json の version（実行ファイルの製品バージョンになる）が食い違ったら、ビルドを止める
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json")).expect("tauri.conf.json の形式");
    let conf_version = conf["version"].as_str().unwrap_or("");
    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    assert_eq!(conf_version, pkg_version, "tauri.conf.json の version（{conf_version}）を、Cargo.toml の版（{pkg_version}）に合わせてください");
    tauri_build::build()
}
