//! パスキー（§8.7）のコマンド。拡張（`inject.js` → `passkey.js` → `bg.js` → パイプ）から呼ばれる。
//!
//! 暗号の部分は `tkrform_core::passkey`。ここでは、オリジンと rpId の再検証、利用者の確認（UV）、
//! ログイン項目への保存・検索・削除を行う。origin は拡張が把握している送信元フレームの URL から決めた値を受け取り、
//! 検証して使う（ページのスクリプトから渡された値は使わない）。

use std::sync::Arc;

use serde_json::{json, Value};
use tkrform_core::model::{Field, FieldKind, Item, ItemType, Passkey, Role};
use tkrform_core::passkey as pk;
use tkrform_core::urlmatch;
use tkrform_ipc::proto::code;

use crate::core::{Core, SvcError};

type R = Result<Value, SvcError>;

const NEEDS_PASSWORD: &str = "NEEDS_PASSWORD";
const UV_FAILED: &str = "UV_FAILED";
const PK_EXCLUDED: &str = "PK_EXCLUDED";
const PK_UNSUPPORTED: &str = "PK_UNSUPPORTED";

fn s<'a>(a: &'a Value, k: &str) -> Result<&'a str, SvcError> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| SvcError::internal(format!("引数 {k} がありません")))
}

fn strs(a: &Value, k: &str) -> Vec<String> {
    a.get(k).and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn bad(e: String) -> SvcError {
    SvcError::new(code::POLICY_DENIED, e)
}

/// 除外サイト（設定）に当たるか。ドメイン名、または URL の一部（/ や : を含むもの）。
fn excluded(list: &[String], origin: &str) -> bool {
    let o = origin.to_lowercase();
    let host = pk::origin_host(origin);
    list.iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).any(|e| {
        // パスや : を含むものは URL の一部、そうでなければドメイン名（サブドメインを含む）として照合する
        if e.contains(['/', ':']) { o.contains(&e) } else { host == e || host.ends_with(&format!(".{e}")) }
    })
}

fn hello_ready(core: &Core) -> bool {
    core.prefs().security.windows_hello && core.dir.join("hello.key").is_file()
}

/// 利用者の確認（UV）。userVerification が discouraged なら確認しない（UV=0）。
/// それ以外は、Windows Hello が使えれば Hello で確認する。使えないとき、required ならマスターパスワードの再入力で確認し、
/// preferred なら確認なし（UV=0）で進める（毎回パスワードを求めないため）。
fn verify_user(core: &Arc<Core>, a: &Value) -> Result<bool, SvcError> {
    let pref = a.get("uv").and_then(Value::as_str).unwrap_or("preferred");
    if pref == "discouraged" {
        return Ok(false);
    }
    if let Some(pw) = a.get("password").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        // パスワードの再入力（Hello が使えない、または Hello に失敗したあとの代わり）
        return if core.with_vault(|v, _| Ok(v.verify_password(pw)))? { Ok(true) } else { Err(SvcError::new(code::BAD_PASSWORD, "マスターパスワードが違います")) };
    }
    if hello_ready(core) {
        // 確認画面は、Hello を呼ぶとすぐ出る（隠れたら、hello::DialogWatch が前面に戻す）
        return match core.hello_verify() {
            Ok(()) => Ok(true),
            // Hello に失敗・キャンセルしたときは、マスターパスワードの入力に切り替えられるようにする
            Err(e) => Err(SvcError::new(UV_FAILED, e.message)),
        };
    }
    if pref == "required" {
        return Err(SvcError::new(NEEDS_PASSWORD, "マスターパスワードを入力してください"));
    }
    Ok(false)
}

fn check_origin(a: &Value) -> Result<(String, String), SvcError> {
    let (origin, rp) = (s(a, "origin")?.to_string(), s(a, "rpId")?.to_string());
    pk::validate_origin_rp(&origin, &rp).map_err(bad)?;
    Ok((origin, rp))
}

pub fn run(core: &Arc<Core>, cmd: &str, a: &Value) -> R {
    match cmd {
        // パスキーを tkrform で扱ってよいか（設定がオンで、除外サイトでなく、ロック解除済み）。ロック中は LOCKED
        "passkeyAvail" => {
            if core.is_locked() {
                return Err(SvcError::locked());
            }
            let p = core.prefs();
            let origin = s(a, "origin")?;
            let ok = p.autofill.passkeys && !excluded(&p.autofill.passkey_exclude, origin) && pk::validate_origin_rp(origin, &pk::origin_host(origin)).is_ok();
            Ok(json!({"enabled": ok, "hello": hello_ready(core)}))
        }
        // rpId に一致するパスキーの候補（秘密鍵は返さない）
        "passkeyList" => {
            let (_, rp) = check_origin(a)?;
            let allow = strs(a, "allow");
            core.with_vault(|v, _| {
                let ids: Vec<String> = v.entries().filter(|e| e.has_passkey && !e.deleted && !e.corrupt && e.kind == ItemType::Login).map(|e| e.id.clone()).collect();
                let mut out = Vec::new();
                for id in ids {
                    let it = v.get_item(&id)?;
                    for k in it.passkeys.iter().filter(|k| k.rp_id == rp && (allow.is_empty() || allow.contains(&k.credential_id))) {
                        out.push(json!({
                            "itemId": it.id, "itemName": it.name, "credentialId": k.credential_id, "userName": k.user_name,
                            "userDisplayName": k.user_display_name, "userHandle": k.user_handle, "lastUsed": k.last_used, "created": k.created,
                        }));
                    }
                }
                out.sort_by(|x, y| y["lastUsed"].as_str().unwrap_or("").cmp(x["lastUsed"].as_str().unwrap_or("")));
                Ok(json!({"passkeys": out}))
            })
        }
        "passkeyCreate" => create(core, a),
        "passkeyGet" => get(core, a),
        // 削除（UI 専用。確認ダイアログは画面側）
        "passkeyDelete" => {
            let (item_id, cred) = (s(a, "itemId")?, s(a, "credentialId")?);
            core.with_vault(|v, _| {
                let mut it = v.get_item(item_id)?;
                let before = it.passkeys.len();
                it.passkeys.retain(|k| k.credential_id != cred);
                if it.passkeys.len() == before {
                    return Err(SvcError::new(code::NOT_FOUND, "パスキーが見つかりません"));
                }
                v.save_item(&mut it)?;
                Ok(json!({}))
            })?;
            core.log("passkey.deleted", item_id);
            core.notify_changed();
            Ok(json!({}))
        }
        _ => Err(SvcError::internal("不明なコマンド")),
    }
}

fn create(core: &Arc<Core>, a: &Value) -> R {
    let (origin, rp) = check_origin(a)?;
    if !core.prefs().autofill.passkeys || excluded(&core.prefs().autofill.passkey_exclude, &origin) {
        return Err(SvcError::new(code::POLICY_DENIED, "このサイトでは TKRForm にパスキーを保存しません"));
    }
    // ES256 (-7) に対応していること（候補が空のときは、仕様の既定に ES256 が含まれる）
    let algs: Vec<i64> = a.get("algs").and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    if !algs.is_empty() && !algs.contains(&pk::ALG_ES256) {
        return Err(SvcError::new(PK_UNSUPPORTED, "TKRForm は ES256 のパスキーだけに対応しています"));
    }
    let (user_id, user_name) = (pk::b64u_decode(s(a, "userId")?).map_err(bad)?, s(a, "userName")?.to_string());
    if user_id.is_empty() || user_id.len() > 64 {
        return Err(bad("ユーザー ID の長さが正しくありません".into()));
    }
    let display = a.get("userDisplayName").and_then(Value::as_str).unwrap_or("").to_string();
    let challenge = s(a, "challenge")?;
    pk::b64u_decode(challenge).map_err(bad)?;
    let exclude = strs(a, "exclude");

    // 既に登録済みのものがあれば InvalidStateError（excludeCredentials）
    let dup = core.with_vault(|v, _| {
        let ids: Vec<String> = v.entries().filter(|e| e.has_passkey && !e.deleted && !e.corrupt).map(|e| e.id.clone()).collect();
        for id in ids {
            if v.get_item(&id)?.passkeys.iter().any(|k| k.rp_id == rp && exclude.contains(&k.credential_id)) {
                return Ok(true);
            }
        }
        Ok(false)
    })?;
    if dup {
        return Err(SvcError::new(PK_EXCLUDED, "このパスキーは既に登録されています"));
    }

    let uv = verify_user(core, a)?;
    let made = pk::create(&rp, &user_id, &user_name, &display, uv).map_err(SvcError::internal)?;
    let cdj = pk::client_data_json("webauthn.create", challenge, &origin, a.get("crossOrigin").and_then(Value::as_bool).unwrap_or(false));

    let item_id = core.with_vault(|v, p| {
        // 同じサイトで同じユーザー名のログインがあれば、そこに付ける
        let hit = v
            .entries()
            .find(|e| e.kind == ItemType::Login && !e.deleted && !e.corrupt && e.user.eq_ignore_ascii_case(&user_name) && !e.url.is_empty() && urlmatch::url_matches(&origin, &e.url, e.match_level, &p.equiv_domains))
            .map(|e| e.id.clone());
        let mut it = match hit {
            Some(id) => v.get_item(&id)?,
            None => {
                let mut n = Item::new(ItemType::Login, &rp);
                n.url = origin.clone();
                n.fields = vec![Field { name: "username".into(), id: String::new(), value: user_name.clone(), kind: FieldKind::Text, role: Some(Role::User) }];
                n
            }
        };
        it.passkeys.push(made.passkey.clone());
        v.save_item(&mut it)?;
        Ok(it.id)
    })?;
    core.log("passkey.created", &item_id);
    core.notify_changed();

    Ok(json!({
        "itemId": item_id,
        "credentialId": pk::b64u(&made.credential_id),
        "authData": pk::b64u(&made.auth_data),
        "attestationObject": pk::b64u(&made.attestation_object),
        "clientDataJSON": pk::b64u(cdj.as_bytes()),
        "publicKey": pk::b64u(&made.public_key_spki),
        "publicKeyAlgorithm": pk::ALG_ES256,
        "uv": uv,
    }))
}

fn get(core: &Arc<Core>, a: &Value) -> R {
    let (origin, rp) = check_origin(a)?;
    if !core.prefs().autofill.passkeys || excluded(&core.prefs().autofill.passkey_exclude, &origin) {
        return Err(SvcError::new(code::POLICY_DENIED, "このサイトでは TKRForm のパスキーを使いません"));
    }
    let (item_id, cred) = (s(a, "itemId")?, s(a, "credentialId")?);
    let challenge = s(a, "challenge")?;
    pk::b64u_decode(challenge).map_err(bad)?;
    let found: Passkey = core.with_vault(|v, _| {
        let it = v.get_item(item_id)?;
        if it.deleted || it.kind != ItemType::Login {
            return Err(SvcError::new(code::NOT_FOUND, "パスキーが見つかりません"));
        }
        it.passkeys.iter().find(|k| k.credential_id == cred && k.rp_id == rp).cloned().ok_or_else(|| SvcError::new(code::NOT_FOUND, "パスキーが見つかりません"))
    })?;

    let uv = verify_user(core, a)?;
    let cdj = pk::client_data_json("webauthn.get", challenge, &origin, a.get("crossOrigin").and_then(Value::as_bool).unwrap_or(false));
    let (auth_data, sig) = pk::assert(&found, &cdj, uv).map_err(SvcError::internal)?;

    core.with_vault(|v, _| {
        let mut it = v.get_item(item_id)?;
        for k in it.passkeys.iter_mut().filter(|k| k.credential_id == cred) {
            k.last_used = Some(tkrform_core::model::now_iso());
        }
        v.save_item(&mut it)?;
        Ok(())
    })?;
    core.log("passkey.used", item_id);
    core.notify_changed();

    Ok(json!({
        "itemId": item_id,
        "credentialId": found.credential_id,
        "authData": pk::b64u(&auth_data),
        "signature": pk::b64u(&sig),
        "userHandle": found.user_handle,
        "clientDataJSON": pk::b64u(cdj.as_bytes()),
        "uv": uv,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_list_matches_domain_and_url_part() {
        let l = vec!["example.com".to_string(), " Bank.Example.NET ".to_string(), "".to_string()];
        assert!(excluded(&l, "https://example.com"));
        assert!(excluded(&l, "https://login.example.com"));
        assert!(excluded(&l, "https://www.bank.example.net/x"));
        assert!(!excluded(&l, "https://notexample.com"));
        assert!(!excluded(&l, "https://example.org"));
        assert!(!excluded(&[], "https://example.com"));
        assert!(excluded(&["example.com/login".to_string()], "https://example.com/login/x"));
        assert!(!excluded(&["example.com/login".to_string()], "https://example.com/other"));
    }
}
