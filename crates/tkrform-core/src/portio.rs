//! インポートとエクスポート（§14）。
//!
//! 対応: 汎用 CSV（列の対応付け）、Chrome/Edge、Firefox、利用者が RoboForm から書き出した CSV（他社製品からの移行用）、Bitwarden JSON（暗号化なし）、
//! tkrform JSON。エクスポートは CSV（UTF-8 BOM 付き）と tkrform JSON。`.tkb` は `vault::write_backup_zip`。

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{now_iso, Field, FieldKind, Item, ItemType, Role};
use crate::urlmatch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CsvFormat {
    Chrome,
    Firefox,
    Roboform,
    /// 1Password の CSV（`Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes` など）
    Onepassword,
    /// LastPass の CSV（`url,username,password,totp,extra,name,grouping,fav`）
    Lastpass,
    /// Dashlane の CSV（`title,username,password,note,url,category,otpSecret` など）
    Dashlane,
    /// Keeper の CSV（ヘッダ行なし: フォルダ, タイトル, ログイン, パスワード, URL, メモ）
    Keeper,
    /// KeePass / KeePassXC の CSV
    Keepass,
    /// Bitwarden の CSV（`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`）
    Bitwardencsv,
    Generic,
}

/// 列番号による対応付け。`None` は「なし」。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CsvMapping {
    pub name: Option<usize>,
    pub url: Option<usize>,
    pub username: Option<usize>,
    pub password: Option<usize>,
    pub note: Option<usize>,
    pub folder: Option<usize>,
    pub totp: Option<usize>,
    /// お気に入り（`1` / `true` など）
    pub favorite: Option<usize>,
    /// 種別（`note` ならメモとして取り込む）
    pub kind: Option<usize>,
}

pub struct CsvTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub fn read_csv(data: &[u8]) -> Result<CsvTable> {
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(data);
    let mut rdr = csv::ReaderBuilder::new().flexible(true).has_headers(true).from_reader(data);
    let headers: Vec<String> = rdr.headers()?.iter().map(|s| s.trim().to_string()).collect();
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let rec = rec?;
        rows.push(rec.iter().map(str::to_string).collect());
    }
    Ok(CsvTable { headers, rows })
}

pub fn detect_format(headers: &[String]) -> CsvFormat {
    let h: Vec<String> = headers.iter().map(|s| s.trim().to_lowercase()).collect();
    let has = |n: &str| h.iter().any(|x| x == n);
    if has("pwd") && has("login") && has("name") {
        CsvFormat::Roboform
    } else if has("login_uri") && has("login_password") {
        CsvFormat::Bitwardencsv
    } else if has("grouping") && has("extra") {
        CsvFormat::Lastpass
    } else if has("otpsecret") || (has("category") && has("username2")) {
        CsvFormat::Dashlane
    } else if (has("group") && has("title") && has("notes") && has("url")) || (has("web site") && has("login name")) {
        CsvFormat::Keepass
    } else if has("title") && (has("otpauth") || has("archived") || has("favorite") || has("type")) && !has("group") {
        CsvFormat::Onepassword
    } else if has("httprealm") || has("formactionorigin") || has("guid") {
        CsvFormat::Firefox
    } else if has("name") && has("url") && has("username") && has("password") {
        CsvFormat::Chrome
    } else {
        CsvFormat::Generic
    }
}

fn find_col(h: &[String], aliases: &[&str]) -> Option<usize> {
    let lower: Vec<String> = h.iter().map(|s| s.to_lowercase()).collect();
    aliases.iter().find_map(|a| lower.iter().position(|x| x == a))
}

/// ヘッダ名から列の対応付けを推定する（列の対応付け画面の初期値）。
pub fn auto_mapping(headers: &[String]) -> CsvMapping {
    CsvMapping {
        name: find_col(headers, &["name", "title", "item name", "label", "account"]),
        url: find_col(headers, &["url", "website", "web site", "login_uri", "uri", "address", "login url"]),
        username: find_col(headers, &["username", "login", "login_username", "login name", "user", "user name", "email"]),
        password: find_col(headers, &["password", "pwd", "login_password", "pass"]),
        note: find_col(headers, &["note", "notes", "extra", "comment", "comments"]),
        folder: find_col(headers, &["folder", "grouping", "group", "category"]),
        totp: find_col(headers, &["totp", "login_totp", "otp", "otpauth", "otpsecret"]),
        favorite: find_col(headers, &["favorite", "fav", "favourite"]),
        kind: find_col(headers, &["type"]),
    }
}

/// 利用者が RoboForm から書き出した CSV に含まれる、「値が未設定」を表す文字列。取り込み時は空として扱う（移行用）。
const ROBOFORM_DEFAULT_VALUE: &str = "$DefaultValue$";

fn cell(row: &[String], idx: Option<usize>) -> String {
    let v = idx.and_then(|i| row.get(i)).map(|s| s.trim()).unwrap_or_default();
    if v == ROBOFORM_DEFAULT_VALUE {
        String::new()
    } else {
        v.to_string()
    }
}

fn host_name(url: &str) -> String {
    urlmatch::parse(url).map(|p| p.host).unwrap_or_else(|| url.to_string())
}

fn normalize_folder(root: &str, folder: &str) -> String {
    let f = folder.trim().replace('\\', "/");
    let f = f.trim_matches('/');
    let root = format!("/{}", root.trim_matches('/'));
    if f.is_empty() {
        root
    } else {
        format!("{root}/{f}")
    }
}

/// CSV を取り込んでログインのリストにする。
/// `mapping` が `None` なら形式を自動判定する。取り込み先は `/<import_root>/<folder>`。
pub fn import_csv(data: &[u8], mapping: Option<&CsvMapping>, import_root: &str) -> Result<Vec<Item>> {
    let table = read_csv(data)?;
    let auto;
    let m = match mapping {
        Some(m) => m,
        None => {
            auto = auto_mapping(&table.headers);
            &auto
        }
    };
    rows_to_items(&table, m, import_root)
}

fn rows_to_items(table: &CsvTable, m: &CsvMapping, import_root: &str) -> Result<Vec<Item>> {
    if m.password.is_none() && m.username.is_none() && m.url.is_none() {
        return Err(Error::Invalid("URL・ユーザー名・パスワードのいずれかの列を指定してください".into()));
    }
    let mut out = Vec::new();
    for row in &table.rows {
        let url = cell(row, m.url);
        let user = cell(row, m.username);
        let pw = cell(row, m.password);
        let mut name = cell(row, m.name);
        if url.is_empty() && user.is_empty() && pw.is_empty() && name.is_empty() {
            continue;
        }
        if name.is_empty() {
            name = if url.is_empty() { user.clone() } else { host_name(&url) };
        }
        if name.is_empty() {
            name = "(名称なし)".into();
        }
        let truthy = |c: String| matches!(c.to_lowercase().as_str(), "1" | "true" | "yes" | "y");
        let kind = cell(row, m.kind).to_lowercase();
        // セキュアノート: Bitwarden/1Password は type 列、LastPass は URL が http://sn
        let is_note = kind == "note" || kind == "securenote" || kind == "secure note" || url == "http://sn";
        if is_note {
            let mut it = Item::new(ItemType::Note, &name);
            it.text = cell(row, m.note);
            it.folder = normalize_folder(import_root, &cell(row, m.folder));
            it.favorite = truthy(cell(row, m.favorite));
            out.push(it);
            continue;
        }
        let mut it = Item::new_login(&name, &url, &user, &pw);
        it.note = cell(row, m.note);
        it.totp_key = cell(row, m.totp);
        it.favorite = truthy(cell(row, m.favorite));
        it.folder = normalize_folder(import_root, &cell(row, m.folder));
        out.push(it);
    }
    Ok(out)
}

/// Keeper の CSV（ヘッダ行なし）: フォルダ, タイトル, ログイン, パスワード, Web サイトのアドレス, メモ, ...
pub fn keeper_headers() -> Vec<String> {
    ["Folder", "Title", "Login", "Password", "Website Address", "Notes"].iter().map(|s| s.to_string()).collect()
}

pub fn keeper_mapping() -> CsvMapping {
    CsvMapping { folder: Some(0), name: Some(1), username: Some(2), password: Some(3), url: Some(4), note: Some(5), ..Default::default() }
}

/// ヘッダ行のない CSV として読む（先頭の行もデータ）。
pub fn read_csv_headerless(data: &[u8]) -> Result<CsvTable> {
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(data);
    let mut rdr = csv::ReaderBuilder::new().flexible(true).has_headers(false).from_reader(data);
    let mut rows = Vec::new();
    for rec in rdr.records() {
        rows.push(rec?.iter().map(str::to_string).collect());
    }
    Ok(CsvTable { headers: keeper_headers(), rows })
}

/// 形式を指定して取り込む（Keeper はヘッダなしなので指定が必要）。`None` は自動判定。
pub fn import_csv_as(data: &[u8], format: Option<CsvFormat>, mapping: Option<&CsvMapping>, import_root: &str) -> Result<Vec<Item>> {
    if format == Some(CsvFormat::Keeper) {
        let table = read_csv_headerless(data)?;
        let m = mapping.cloned().unwrap_or_else(keeper_mapping);
        return rows_to_items(&table, &m, import_root);
    }
    import_csv(data, mapping, import_root)
}

#[derive(Deserialize)]
struct BwRoot {
    #[serde(default)]
    folders: Vec<BwFolder>,
    #[serde(default)]
    items: Vec<BwItem>,
    #[serde(default)]
    encrypted: bool,
}
#[derive(Deserialize)]
struct BwFolder {
    id: String,
    name: String,
}
#[derive(Deserialize)]
struct BwItem {
    #[serde(rename = "type")]
    kind: u8,
    name: Option<String>,
    notes: Option<String>,
    #[serde(rename = "folderId")]
    folder_id: Option<String>,
    login: Option<BwLogin>,
}
#[derive(Deserialize)]
struct BwLogin {
    username: Option<String>,
    password: Option<String>,
    totp: Option<String>,
    #[serde(default)]
    uris: Vec<BwUri>,
}
#[derive(Deserialize)]
struct BwUri {
    uri: Option<String>,
}

/// Bitwarden の JSON（暗号化なし）を取り込む。
pub fn import_bitwarden_json(data: &[u8], import_root: &str) -> Result<Vec<Item>> {
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(data);
    let root: BwRoot = serde_json::from_slice(data)?;
    if root.encrypted {
        return Err(Error::Invalid("暗号化された Bitwarden のエクスポートには対応していません".into()));
    }
    let folder_of = |id: &Option<String>| -> String {
        let name = id.as_ref().and_then(|i| root.folders.iter().find(|f| &f.id == i)).map(|f| f.name.as_str()).unwrap_or("");
        normalize_folder(import_root, name)
    };
    let mut out = Vec::new();
    for b in &root.items {
        let name = b.name.clone().unwrap_or_default();
        match (b.kind, &b.login) {
            (1, Some(l)) => {
                let url = l.uris.first().and_then(|u| u.uri.clone()).unwrap_or_default();
                let mut it = Item::new_login(
                    if name.is_empty() { "(名称なし)" } else { &name },
                    &url,
                    l.username.as_deref().unwrap_or(""),
                    l.password.as_deref().unwrap_or(""),
                );
                it.note = b.notes.clone().unwrap_or_default();
                it.totp_key = l.totp.clone().unwrap_or_default();
                it.folder = folder_of(&b.folder_id);
                out.push(it);
            }
            (2, _) => {
                let mut it = Item::new(ItemType::Note, if name.is_empty() { "(名称なし)" } else { &name });
                it.text = b.notes.clone().unwrap_or_default();
                it.folder = folder_of(&b.folder_id);
                out.push(it);
            }
            _ => {}
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------- エクスポート

pub const CSV_HEADER: [&str; 7] = ["name", "url", "username", "password", "note", "folder", "totp"];

/// CSV（UTF-8 BOM 付き、ヘッダ行あり）。ログインだけを出力する。
pub fn export_csv(items: &[Item]) -> Result<Vec<u8>> {
    let mut buf = vec![0xEF, 0xBB, 0xBF];
    {
        let mut w = csv::WriterBuilder::new().terminator(csv::Terminator::CRLF).from_writer(&mut buf);
        w.write_record(CSV_HEADER)?;
        for it in items.iter().filter(|i| i.kind == ItemType::Login && !i.deleted) {
            w.write_record([&it.name, &it.url, it.login_user(), it.login_password(), &it.note, &it.folder, &it.totp_key])?;
        }
        w.flush()?;
    }
    Ok(buf)
}

#[derive(Serialize, Deserialize)]
struct JsonExport {
    format: String,
    version: u32,
    exported: String,
    items: Vec<Item>,
}

pub fn export_json(items: &[Item]) -> Result<Vec<u8>> {
    let doc = JsonExport {
        format: "tkrform-json".into(),
        version: 1,
        exported: now_iso(),
        // パスキーの秘密鍵は、平文のファイルに書き出さない（失効できない認証情報で、他の製品では使えないため）。
        // 暗号化された tkrform のバックアップ（.tkb）には含まれる。
        items: items.iter().filter(|i| !i.deleted).cloned().map(|mut i| { i.passkeys.clear(); i }).collect(),
    };
    Ok(serde_json::to_vec_pretty(&doc)?)
}

/// tkrform JSON を取り込む。ID は付け替え、rev は 0 に戻す。
pub fn import_tkrform_json(data: &[u8]) -> Result<Vec<Item>> {
    let doc: JsonExport = serde_json::from_slice(data)?;
    if doc.format != "tkrform-json" {
        return Err(Error::Invalid("tkrform JSON ではありません".into()));
    }
    Ok(doc
        .items
        .into_iter()
        .map(|mut it| {
            it.id = uuid::Uuid::new_v4().to_string();
            it.rev = 0;
            it.passkeys.clear(); // 取り込みでは秘密鍵を受け付けない
            it
        })
        .collect())
}

/// 取り込み先フォルダ名（§14.1）。
pub fn default_import_root() -> String {
    format!("インポート {}", chrono::Local::now().format("%Y-%m-%d"))
}

/// 手入力用のフィールド行を足したい場合のヘルパ。
pub fn text_field(name: &str, value: &str, role: Option<Role>) -> Field {
    Field { name: name.into(), id: String::new(), value: value.into(), kind: FieldKind::Text, role }
}

#[cfg(test)]
mod passkey_export_tests {
    use super::*;
    use crate::model::{Item, ItemType, Passkey};

    #[test]
    fn json_export_and_import_drop_passkeys() {
        let mut it = Item::new(ItemType::Login, "x");
        it.passkeys.push(Passkey {
            rp_id: "example.com".into(), credential_id: "c".into(), user_handle: "u".into(), user_name: "n".into(), user_display_name: String::new(),
            private_key: "SECRET-KEY".into(), sign_count: 0, created: "2026-01-01T00:00:00Z".into(), last_used: None,
        });
        let out = export_json(&[it]).unwrap();
        assert!(!String::from_utf8_lossy(&out).contains("SECRET-KEY"));
        let back = import_tkrform_json(&out).unwrap();
        assert!(back[0].passkeys.is_empty());
    }
}
