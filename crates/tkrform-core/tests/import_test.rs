//! 他製品の CSV（§14.1）の取り込み。

use tkrform_core::model::ItemType;
use tkrform_core::portio::{self, CsvFormat};

fn run(csv: &str) -> (CsvFormat, Vec<tkrform_core::Item>) {
    let t = portio::read_csv(csv.as_bytes()).unwrap();
    (portio::detect_format(&t.headers), portio::import_csv(csv.as_bytes(), None, "R").unwrap())
}

#[test]
fn onepassword() {
    let (f, items) = run("Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nGitHub,https://github.com,octocat,pw1,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,1,0,dev,メモ\n");
    assert_eq!(f, CsvFormat::Onepassword);
    let it = &items[0];
    assert_eq!((it.name.as_str(), it.login_user(), it.login_password(), it.note.as_str()), ("GitHub", "octocat", "pw1", "メモ"));
    assert!(it.totp_key.starts_with("otpauth://"));
    assert!(it.favorite);
}

#[test]
fn lastpass_with_secure_note() {
    let csv = "url,username,password,totp,extra,name,grouping,fav\nhttps://a.example.com,u,p,JBSWY3DPEHPK3PXP,note a,Site A,Work/EC,1\nhttp://sn,,,,秘密の本文,My Note,Personal,0\n";
    let (f, items) = run(csv);
    assert_eq!(f, CsvFormat::Lastpass);
    assert_eq!(items[0].name, "Site A");
    assert_eq!(items[0].folder, "/R/Work/EC");
    assert_eq!(items[0].note, "note a");
    assert!(items[0].favorite);
    assert_eq!(items[0].totp_key, "JBSWY3DPEHPK3PXP");
    assert_eq!(items[1].kind, ItemType::Note);
    assert_eq!(items[1].text, "秘密の本文");
}

#[test]
fn dashlane() {
    let (f, items) = run("username,username2,username3,title,password,note,url,category,otpSecret\nbob,,,Shop,pw,n,https://shop.example.com,Shopping,JBSWY3DPEHPK3PXP\n");
    assert_eq!(f, CsvFormat::Dashlane);
    assert_eq!((items[0].name.as_str(), items[0].login_user(), items[0].folder.as_str()), ("Shop", "bob", "/R/Shopping"));
    assert_eq!(items[0].totp_key, "JBSWY3DPEHPK3PXP");
}

#[test]
fn keeper_headerless() {
    let csv = "Work,GitHub,octocat,pw1,https://github.com,note\n,Plain,u,p,https://plain.example.com,\n";
    let items = portio::import_csv_as(csv.as_bytes(), Some(CsvFormat::Keeper), None, "R").unwrap();
    assert_eq!(items.len(), 2, "先頭の行もデータとして読む");
    assert_eq!((items[0].name.as_str(), items[0].login_user(), items[0].folder.as_str()), ("GitHub", "octocat", "/R/Work"));
    assert_eq!(items[1].folder, "/R");
}

#[test]
fn keepass_and_keepassxc() {
    let (f, items) = run("\"Group\",\"Title\",\"Username\",\"Password\",\"URL\",\"Notes\",\"TOTP\",\"Icon\",\"Last Modified\",\"Created\"\n\"Root/Web\",\"Bank\",\"me\",\"pw\",\"https://bank.example.com\",\"n\",\"\",\"0\",\"\",\"\"\n");
    assert_eq!(f, CsvFormat::Keepass);
    assert_eq!((items[0].name.as_str(), items[0].folder.as_str()), ("Bank", "/R/Root/Web"));
    let (f, items) = run("\"Account\",\"Login Name\",\"Password\",\"Web Site\",\"Comments\"\n\"Old\",\"me\",\"pw\",\"https://old.example.com\",\"c\"\n");
    assert_eq!(f, CsvFormat::Keepass);
    assert_eq!((items[0].name.as_str(), items[0].login_user(), items[0].note.as_str()), ("Old", "me", "c"));
}

#[test]
fn bitwarden_csv() {
    let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,1,login,GH,n,,0,https://github.com,octo,pw,JBSWY3DPEHPK3PXP\n,0,note,Memo,本文,,0,,,,\n";
    let (f, items) = run(csv);
    assert_eq!(f, CsvFormat::Bitwardencsv);
    assert!(items[0].favorite && items[0].login_user() == "octo" && items[0].folder == "/R/Work");
    assert_eq!((items[1].kind, items[1].text.as_str()), (ItemType::Note, "本文"));
}
