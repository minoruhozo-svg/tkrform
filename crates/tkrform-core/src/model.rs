//! データモデル（§5）。

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ItemType {
    Login = 1,
    Bookmark = 2,
    SearchCard = 3,
    AppLogin = 4,
    Identity = 5,
    Contact = 6,
    Note = 7,
    Folder = 8,
}

impl ItemType {
    pub fn from_u8(n: u8) -> Option<Self> {
        Some(match n {
            1 => Self::Login,
            2 => Self::Bookmark,
            3 => Self::SearchCard,
            4 => Self::AppLogin,
            5 => Self::Identity,
            6 => Self::Contact,
            7 => Self::Note,
            8 => Self::Folder,
            _ => return None,
        })
    }
}

impl Serialize for ItemType {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for ItemType {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let n = u8::deserialize(d)?;
        ItemType::from_u8(n).ok_or_else(|| serde::de::Error::custom(format!("不明なアイテム種別: {n}")))
    }
}

/// フィールドの種類（§5.3）。保存するときは、下の名前（text / password / ...）で書く。
/// ラジオは、見た目が違うだけで記入の扱いは同じなので、radio にまとめた（値で区別する）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum FieldKind {
    #[default]
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "checkbox")]
    Checkbox,
    #[serde(rename = "radio")]
    Radio,
    #[serde(rename = "textarea")]
    Textarea,
    #[serde(rename = "select")]
    Select,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "newPassword")]
    NewPassword,
    #[serde(rename = "otp")]
    Otp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Field {
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub kind: FieldKind,
    #[serde(default)]
    pub role: Option<Role>,
}

/// 照合レベル（§8.2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MatchLevel {
    #[default]
    Domain,
    Host,
    Prefix,
    Exact,
}

/// 多段ログイン（複数のページにまたがるログイン）。このログインの前後に続けて記入する、ほかのログインの id。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Chain {
    /// このログインより先に記入するログイン
    #[serde(default)]
    pub previous: Vec<String>,
    /// このログインに続けて記入するログイン
    #[serde(default)]
    pub next: Vec<String>,
}

impl Chain {
    pub fn is_empty(&self) -> bool {
        self.previous.is_empty() && self.next.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PwHistory {
    pub value: String,
    pub changed: String,
}

pub const PASSWORD_HISTORY_MAX: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct IdentityInstance {
    pub name: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// カスタム項目のキーごとのマッチ用正規表現（§5.4）。
    #[serde(default, rename = "customMatches", skip_serializing_if = "BTreeMap::is_empty")]
    pub custom_matches: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct IdentityGroup {
    pub group: String,
    #[serde(default)]
    pub instances: Vec<IdentityInstance>,
}

/// アイテム。種別ごとのフィールドを 1 つの構造体にまとめ、使わないものは省略して保存する。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemType,
    pub name: String,
    #[serde(default = "root_folder")]
    pub folder: String,
    pub created: String,
    pub modified: String,
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub pinned: u32,
    #[serde(default)]
    pub use_count: u32,
    #[serde(default)]
    pub last_used: Option<String>,
    /// 使用の点数（最近の使用ほど重い）。`score_at` の時点の値で、並べるときは今の時点まで減衰させる。古い項目にはない
    #[serde(default)]
    pub use_score: f64,
    /// `use_score` を最後に更新した日時
    #[serde(default)]
    pub score_at: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    /// ゴミ箱に移した日時（30 日保持のため）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,

    // --- ログイン / ブックマーク / アプリログイン ---
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub match_url: String,
    #[serde(default, skip_serializing_if = "is_default")]
    pub match_level: MatchLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    /// （アプリログイン用。ブラウザのログインは no_submit を使う）
    #[serde(default, skip_serializing_if = "is_default")]
    pub submit: bool,
    /// 記入後に送信しない。既定（false）では、記入したあと送信（ログイン）する
    #[serde(default, skip_serializing_if = "is_default")]
    pub no_submit: bool,
    #[serde(default, skip_serializing_if = "is_default")]
    pub basic_auth: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub totp_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// ログイン時に表示するヒント
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hint: String,
    /// 多段ログイン
    #[serde(default, skip_serializing_if = "Chain::is_empty")]
    pub chain: Chain,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<Passkey>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub password_history: Vec<PwHistory>,

    // --- アプリログイン ---
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub exe_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub window_title: String,

    // --- プロフィール / 連絡先 ---
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub country: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<IdentityGroup>,

    // --- メモ ---
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// ログイン項目に付くパスキー（§8.7）。秘密鍵は PKCS8 (DER) の base64。ID 類は base64url。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    pub rp_id: String,
    pub credential_id: String,
    pub user_handle: String,
    pub user_name: String,
    #[serde(default)]
    pub user_display_name: String,
    pub private_key: String,
    /// 同期されるパスキーなので、常に 0（回数は数えない）。
    #[serde(default)]
    pub sign_count: u32,
    pub created: String,
    #[serde(default)]
    pub last_used: Option<String>,
}

fn root_folder() -> String {
    "/".to_string()
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

pub const NOTE_MAX_BYTES: usize = 1024 * 1024;

/// 「よく使う」の点数の半減期（日）。点数は、この日数ごとに半分になる。
pub const POPULARITY_HALF_LIFE_DAYS: f64 = 14.0;
/// 同じ項目への使用の記録が、この秒数より近いときは、1 回と数える（アプリからのログイン + 拡張の記入、ID とパスワードの続けてのコピーなど）。
pub const TOUCH_DEDUP_SECS: i64 = 60;

fn decay(score: f64, at: &str, now: chrono::DateTime<chrono::Utc>) -> f64 {
    match chrono::DateTime::parse_from_rfc3339(at) {
        Ok(t) => {
            let days = (now - t.with_timezone(&chrono::Utc)).num_seconds().max(0) as f64 / 86400.0;
            score * 0.5f64.powf(days / POPULARITY_HALF_LIFE_DAYS)
        }
        Err(_) => score,
    }
}

/// 今の時点の使用の点数。点数のない項目（取り込んだ項目など）は、使用回数を最後の使用日時の時点の点数とみなす。
pub fn popularity_score(use_score: f64, score_at: Option<&str>, use_count: u32, last_used: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> f64 {
    match (score_at, last_used) {
        (Some(at), _) => decay(use_score, at, now),
        (None, _) if use_count == 0 => 0.0,
        (None, Some(l)) => decay(f64::from(use_count), l, now),
        (None, None) => f64::from(use_count),
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl Item {
    pub fn new(kind: ItemType, name: &str) -> Item {
        let now = now_iso();
        Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            name: name.to_string(),
            folder: root_folder(),
            created: now.clone(),
            modified: now,
            rev: 0,
            favorite: false,
            pinned: 0,
            use_count: 0,
            last_used: None,
            use_score: 0.0,
            score_at: None,
            color: None,
            deleted: false,
            deleted_at: None,
            url: String::new(),
            match_url: String::new(),
            match_level: MatchLevel::Domain,
            fields: Vec::new(),
            submit: false,
            no_submit: false,
            basic_auth: false,
            totp_key: String::new(),
            note: String::new(),
            hint: String::new(),
            chain: Chain::default(),
            passkeys: Vec::new(),
            password_history: Vec::new(),
            exe_path: String::new(),
            window_title: String::new(),
            country: String::new(),
            groups: Vec::new(),
            text: String::new(),
        }
    }

    /// 標準的なログイン（ID とパスワードの 2 フィールド）を作る。
    pub fn new_login(name: &str, url: &str, user: &str, password: &str) -> Item {
        let mut it = Item::new(ItemType::Login, name);
        it.url = url.to_string();
        it.fields = vec![
            Field { name: "username".into(), id: String::new(), value: user.into(), kind: FieldKind::Text, role: Some(Role::User) },
            Field { name: "password".into(), id: String::new(), value: password.into(), kind: FieldKind::Password, role: Some(Role::Password) },
        ];
        it
    }

    pub fn login_user(&self) -> &str {
        self.fields.iter().find(|f| f.role == Some(Role::User)).map(|f| f.value.as_str()).unwrap_or("")
    }

    pub fn login_password(&self) -> &str {
        self.fields.iter().find(|f| f.role == Some(Role::Password)).map(|f| f.value.as_str()).unwrap_or("")
    }

    /// 照合に使う URL（`matchUrl` が空なら `url`）。
    pub fn effective_match_url(&self) -> &str {
        if self.match_url.is_empty() {
            &self.url
        } else {
            &self.match_url
        }
    }

    /// 保存前の検証。
    pub fn validate(&self) -> crate::Result<()> {
        use crate::Error;
        if self.name.trim().is_empty() {
            return Err(Error::Invalid("名前が空です".into()));
        }
        if self.id.is_empty() || !self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(Error::Invalid("ID が不正です".into()));
        }
        if !self.folder.starts_with('/') {
            return Err(Error::Invalid("フォルダは / で始めてください".into()));
        }
        if self.kind == ItemType::Note && self.text.len() > NOTE_MAX_BYTES {
            return Err(Error::Invalid("メモは 1MB までです".into()));
        }
        Ok(())
    }

    /// フォルダ項目としてのフルパス。
    pub fn folder_path(&self) -> String {
        join_folder(&self.folder, &self.name)
    }
}

pub fn join_folder(parent: &str, name: &str) -> String {
    if parent == "/" || parent.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

/// 国別の表示グループ（§5.4。MVP は JP と US）。
pub fn identity_layout(country: &str) -> Vec<(&'static str, Vec<&'static str>)> {
    let person_jp = vec![
        "LastName", "FirstName", "LastNameKana", "FirstNameKana", "FullName", "Sex", "BirthYear", "BirthMonth",
        "BirthDay", "Email", "HomePhone", "CellPhone", "WorkPhone", "Fax",
    ];
    let person_us = vec![
        "Title", "FirstName", "MiddleName", "LastName", "FullName", "Sex", "BirthMonth", "BirthDay", "BirthYear",
        "Email", "HomePhone", "CellPhone", "WorkPhone", "Fax",
    ];
    let business = vec!["Company", "CompanyKana", "Department", "Position", "CompanyPhone", "CompanyFax", "CompanyWebsite"];
    let addr_jp = vec!["ZipOrPostCode", "StateOrProvince", "City", "AddressLine1", "AddressLine2", "AddressLine3", "Country"];
    let addr_us = vec!["AddressLine1", "AddressLine2", "City", "StateOrProvince", "ZipOrPostCode", "Country"];
    let card = vec![
        "CardType", "CardNumber", "CardHolderName", "CardExpiresMonth", "CardExpiresYear", "CardValidationCode", "CardPIN",
        "CardIssuingBank", "CardCustomerServicePhone",
    ];
    let bank = vec!["BankName", "AccountNumber", "AccountType", "RoutingNumber", "SwiftCode", "IBAN", "AccountOwner", "BankPIN"];
    let (person, addr) = if country == "US" { (person_us, addr_us) } else { (person_jp, addr_jp) };
    vec![
        ("Person", person),
        ("Business", business),
        ("Address", addr),
        ("CreditCard", card),
        ("BankAccount", bank),
        ("Passport", vec!["PassportNumber", "IssueDate", "ExpirationDate", "IssuePlace"]),
        ("Car", vec!["CarMake", "CarModel", "CarYear", "CarPlateNumber", "CarPlateState", "VIN"]),
        ("Custom", vec![]),
    ]
}
