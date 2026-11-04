//! コマンドの実体。拡張（Named Pipe 経由）とデスクトップ UI（Tauri invoke）で共有する。
//!
//! 拡張から呼べるのは `PIPE_ALLOWED` のコマンドだけ。エクスポート・バックアップ・MP 変更などは UI 専用。

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tkrform_core::generator::{self, GenOptions};
use tkrform_core::model::{identity_layout, join_folder, now_iso, Item, ItemType};
use tkrform_core::portio;
use tkrform_core::totp;
use tkrform_core::urlmatch;
use tkrform_core::vault::{self, Vault};
use tkrform_ipc::proto::code;

use crate::core::{Core, SvcError};
use crate::{sys, wins};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Pipe,
    Ui,
}

/// 拡張に許可するコマンド（§9 の表 + `checkSave` / `getBasicAuth`）。
const PIPE_ALLOWED: &[&str] = &[
    "hello", "unlock", "helloUnlock", "lock", "match", "getFill", "getIdentityFill", "totp", "search", "getItem", "saveItem", "deleteItem",
    "listFolders", "generate", "getPrefs", "setPrefs", "touch", "openEditor", "openGenerator", "checkSave", "getBasicAuth", "copyItem",
    "copyText", "passkeyAvail", "passkeyList", "passkeyCreate", "passkeyGet",
];

type R = Result<Value, SvcError>;

fn arg_str<'a>(a: &'a Value, k: &str) -> Result<&'a str, SvcError> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| SvcError::internal(format!("引数 {k} がありません")))
}

fn arg_opt<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn arg_ids(a: &Value, k: &str) -> Result<Vec<String>, SvcError> {
    Ok(a.get(k)
        .and_then(Value::as_array)
        .ok_or_else(|| SvcError::internal(format!("引数 {k} がありません")))?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect())
}

pub fn dispatch(core: &Arc<Core>, cmd: &str, args: Value, src: Source) -> R {
    if src == Source::Pipe && !PIPE_ALLOWED.contains(&cmd) {
        return Err(SvcError::new(code::POLICY_DENIED, "この操作は拡張からは行えません"));
    }
    let r = run(core, cmd, &args, src);
    if matches!(cmd, "saveItem" | "deleteItem" | "restoreItem" | "purgeItem" | "moveItems" | "createFolder" | "renameFolder" | "moveFolder" | "deleteFolder" | "duplicateItem" | "importRun" | "restoreBackup" | "touch")
        && r.is_ok()
    {
        core.notify_changed();
    }
    r
}

fn run(core: &Arc<Core>, cmd: &str, a: &Value, src: Source) -> R {
    match cmd {
        // ---------------------------------------------------------------- 状態
        "hello" => Ok(json!({
            "appVersion": env!("CARGO_PKG_VERSION"),
            "locked": core.is_locked(),
            "exists": core.exists(),
            "accountName": "tkrform",
            "packaged": crate::msix::is_packaged(),
            // 拡張に「Windows Hello で解除できるか」を伝える（有効で、登録済み）
            "helloAvailable": core.prefs().security.windows_hello && core.dir.join("hello.key").is_file(),
        })),
        "status" => Ok(json!({
            "hello": core.prefs().security.windows_hello && core.dir.join("hello.key").is_file(),
            "exists": core.exists(),
            "locked": core.is_locked(),
            "hint": core.hint(),
            "version": env!("CARGO_PKG_VERSION"),
            "packaged": crate::msix::is_packaged(),
            "dataDir": core.dir.to_string_lossy(),
        })),
        "setup" if a.get("sync").map(|x| x.get("mode").and_then(Value::as_str) == Some("join")).unwrap_or(false) => {
            let sy = &a["sync"];
            crate::sync::setup_join(core, arg_str(sy, "url")?, arg_str(sy, "email")?, arg_str(a, "mp")?, a.get("hint").and_then(Value::as_str).unwrap_or(""))?;
            Ok(json!({"ok": true}))
        }
        "setup" => {
            core.create_vault(arg_str(a, "mp")?, a.get("hint").and_then(Value::as_str).unwrap_or(""), a.get("iterations").and_then(Value::as_u64).unwrap_or(600_000) as u32)?;
            if let Some(sy) = a.get("sync").filter(|x| x.get("mode").and_then(Value::as_str) == Some("create")) {
                // 作成後、そのまま同期サーバにアカウントを作る（失敗しても保管庫は作成済みのまま）
                if let Err(e) = crate::sync::connect(core, "register", arg_str(sy, "url")?, arg_str(sy, "email")?, arg_str(a, "mp")?) {
                    return Ok(json!({"ok": true, "syncError": e.message}));
                }
            }
            Ok(json!({"ok": true}))
        }
        "unlock" => {
            core.unlock(arg_str(a, "password")?)?;
            Ok(json!({"ok": true}))
        }
        "lock" => {
            core.lock();
            Ok(json!({}))
        }
        // ---- 同期（UI 専用）
        "syncStatus" => Ok(crate::sync::status(core)),
        "syncConnect" => {
            crate::sync::connect(core, arg_str(a, "mode")?, arg_str(a, "url")?, arg_str(a, "email")?, arg_str(a, "password")?)?;
            Ok(json!({}))
        }
        "syncNow" => {
            let r = crate::sync::run_once(core)?;
            Ok(serde_json::to_value(r).unwrap_or_default())
        }
        "syncDisconnect" => {
            crate::sync::disconnect(core)?;
            Ok(json!({}))
        }
        // ---- パスキー（§8.7）
        "passkeyAvail" | "passkeyList" | "passkeyCreate" | "passkeyGet" | "passkeyDelete" => crate::passkey::run(core, cmd, a),
        // ---- Windows アプリへの記入（§10.4）
        "captureApp" => {
            let hwnd = match arg_opt(a, "windowTitle") {
                Some(t) => crate::sys::find_window_by_title(t),
                None => crate::sys::last_foreground(),
            };
            capture_app(core, hwnd)?;
            Ok(json!({}))
        }
        "appCaptureGet" => {
            let c = core.pending_app.lock().unwrap_or_else(|e| e.into_inner()).clone();
            c.map(|c| crate::winfill::captured_json(&c)).ok_or_else(|| SvcError::new(code::NOT_FOUND, "取り込んだアプリがありません"))
        }
        "fillApp" => {
            let n = fill_app(core, arg_str(a, "id")?, arg_opt(a, "windowTitle"))?;
            Ok(json!({"filled": n}))
        }
        // ---- セキュリティセンター（§13）
        "securityReport" => core.with_vault(|v, _| {
            let (items, bad) = v.load_all(false)?;
            let rep = tkrform_core::security::analyze(&items, chrono::Utc::now());
            let mut out = serde_json::to_value(rep).unwrap_or_default();
            out["corrupt"] = json!(bad.len());
            Ok(out)
        }),
        "breachConsent" => {
            // 同意画面で「同意する」を選んだときだけオンにできる。オフにするのはいつでも可
            let agree = a.get("agree").and_then(Value::as_bool).unwrap_or(false);
            let mut p = core.prefs();
            p.security.breach_check = agree;
            p.security.breach_consent = if agree { now_iso() } else { String::new() };
            core.set_prefs(p)?;
            Ok(json!({"enabled": agree}))
        }
        "breachCheck" => breach_check(core),
        // ---- Windows Hello（§6.3）
        "helloStatus" => Ok(json!({
            "supported": crate::hello::is_supported(),
            "enrolled": core.dir.join("hello.key").is_file(),
            "enabled": core.prefs().security.windows_hello,
            // 登録（hello.key）はあるのに無効になっている。黙って有効に戻さず、設定画面で利用者に確認する
            "registeredButDisabled": !core.prefs().security.windows_hello && core.dir.join("hello.key").is_file(),
        })),
        "helloReenable" => {
            focus_hello_owner(core); // 確認ダイアログが操作中のウィンドウの手前に出るよう、先にそのウィンドウを前面にする
            core.hello_reenable()?;
            Ok(json!({}))
        }
        "helloEnable" => {
            focus_hello_owner(core); // 確認ダイアログが操作中のウィンドウの手前に出るよう、先にそのウィンドウを前面にする
            core.hello_enable()?;
            Ok(json!({}))
        }
        "helloDisable" => {
            core.hello_disable()?;
            Ok(json!({}))
        }
        "helloUnlock" => {
            // 解除済みなら、何もせず成功を返す。確認画面は、Hello を呼ぶとすぐ出る。窓を作って前面化を待つと、Hello が遅れる
            // ので作らない（隠れたら、hello::DialogWatch が前面に戻す）
            core.hello_unlock()?;
            Ok(json!({"ok": true}))
        }
        // ---- 自動更新（§10.5）
        "updateCheck" => {
            let m = crate::update::check(core)?;
            Ok(crate::update::status_json(m.as_ref()))
        }
        "updateInstall" => {
            let m = crate::update::check(core)?.ok_or_else(|| SvcError::internal("新しい版はありません"))?;
            crate::update::install(core, &m)?;
            Ok(json!({}))
        }
        "strength" => {
            let bits = generator::estimate_bits(arg_str(a, "password")?);
            Ok(json!({"bits": bits, "class": generator::strength_class(bits)}))
        }
        "verifyMp" => {
            let ok = core.with_vault(|v, _| Ok(v.verify_password(arg_str(a, "password")?)))?;
            Ok(json!({"ok": ok}))
        }
        "changeMp" => {
            core.change_master_password(arg_str(a, "old")?, arg_str(a, "new")?)?;
            crate::sync::after_mp_change(core, arg_str(a, "new")?);
            Ok(json!({"ok": true}))
        }
        "quit" => {
            if let Some(app) = core.app.get() {
                app.exit(0);
            }
            Ok(json!({}))
        }

        // ---------------------------------------------------------------- 設定
        "getPrefs" => {
            let p = core.prefs();
            if src == Source::Pipe {
                Ok(json!({
                    "autofill": p.autofill, "autosave": p.autosave, "equivDomains": p.equiv_domains,
                    "clipboardClearSecs": p.security.clipboard_clear_secs, "language": p.general.language,
                }))
            } else {
                Ok(serde_json::to_value(p).map_err(|e| SvcError::internal(e.to_string()))?)
            }
        }
        "setPrefs" => {
            let mut p = core.prefs();
            if src == Source::Pipe {
                // 拡張から変えられるのは自動記入・自動保存・同等ドメインだけ
                if let Some(v) = a.get("autofill") {
                    p.autofill = serde_json::from_value(v.clone()).map_err(|e| SvcError::internal(e.to_string()))?;
                }
                if let Some(v) = a.get("autosave") {
                    p.autosave = serde_json::from_value(v.clone()).map_err(|e| SvcError::internal(e.to_string()))?;
                }
                if let Some(v) = a.get("equivDomains") {
                    p.equiv_domains = serde_json::from_value(v.clone()).map_err(|e| SvcError::internal(e.to_string()))?;
                }
            } else {
                p = serde_json::from_value(a.get("prefs").cloned().unwrap_or(Value::Null)).map_err(|e| SvcError::internal(e.to_string()))?;
                p.security.iterations = tkrform_core::crypto::clamp_user_iterations(p.security.iterations);
                // 専用のコマンドや内部の処理でだけ変わる値は、設定画面が持っている古い値で上書きさせない（今の値を保つ）
                let cur = core.prefs();
                p.security.windows_hello = cur.security.windows_hello; // helloEnable / helloDisable / MP 変更
                p.security.breach_check = cur.security.breach_check; // breachConsent（同意画面）
                p.security.breach_consent = cur.security.breach_consent;
                p.sync = cur.sync; // syncConnect / syncDisconnect
                p.backup.dir = cur.backup.dir; // backupSetDir（保存先の確認を経て変える）
                p.backup.prev_dirs = cur.backup.prev_dirs;
            }
            core.set_prefs(p)?;
            wins::apply_hotkeys(core);
            Ok(json!({}))
        }

        // ---------------------------------------------------------------- 照合・記入
        "match" => {
            let url = arg_str(a, "url")?;
            core.with_vault(|v, p| {
                let logins: Vec<Value> = v
                    .match_logins(url, &p.equiv_domains)
                    .iter()
                    .map(|e| json!({"id": e.id, "name": e.name, "user": e.user, "hasTotp": e.has_totp}))
                    .collect();
                let identities: Vec<Value> = v
                    .entries()
                    .filter(|e| !e.deleted && !e.corrupt && (e.kind == ItemType::Identity || (p.autofill.include_contacts && e.kind == ItemType::Contact)))
                    .map(|e| json!({"id": e.id, "name": e.name, "type": e.kind}))
                    .collect();
                Ok(json!({"logins": logins, "identities": identities}))
            })
        }
        "getFill" => {
            let (id, url) = (arg_str(a, "id")?, arg_str(a, "url")?);
            core.with_vault(|v, p| {
                let it = v.get_item(id)?;
                if it.kind != ItemType::Login || it.deleted {
                    return Err(SvcError::new(code::NOT_FOUND, "ログインが見つかりません"));
                }
                if !urlmatch::url_matches(url, it.effective_match_url(), it.match_level, &p.equiv_domains) {
                    return Err(SvcError::new(code::URL_MISMATCH, "このページの URL と一致しません"));
                }
                Ok(json!({
                    "id": it.id, "name": it.name, "fields": it.fields, "submit": !it.no_submit, "chain": it.chain,
                    "hint": it.hint, "hasTotp": !it.totp_key.is_empty(),
                }))
            })
        }
        "getIdentityFill" => {
            let id = arg_str(a, "id")?;
            let instance = arg_opt(a, "instance");
            core.with_vault(|v, _| {
                let it = v.get_item(id)?;
                if !matches!(it.kind, ItemType::Identity | ItemType::Contact) || it.deleted {
                    return Err(SvcError::new(code::NOT_FOUND, "プロフィールが見つかりません"));
                }
                let fields = identity_flat(&it, instance);
                let instances: Vec<Value> = it
                    .groups
                    .iter()
                    .filter(|g| g.instances.len() > 1)
                    .map(|g| json!({"group": g.group, "names": g.instances.iter().map(|i| i.name.clone()).collect::<Vec<_>>()}))
                    .collect();
                Ok(json!({"name": it.name, "fields": fields, "instances": instances, "custom": custom_matches(&it, instance)}))
            })
        }
        "getBasicAuth" => {
            let url = arg_str(a, "url")?;
            core.with_vault(|v, p| {
                if !p.autofill.basic_auth {
                    return Err(SvcError::new(code::POLICY_DENIED, "ベーシック認証への記入はオフです"));
                }
                // 候補は URL に一致するログイン（お気に入り → 使用頻度の順）。拡張が id を指定したとき（ポップアップで選んだ項目）は、
                // その項目が一致する場合だけ使う。指定がなければ「ベーシック認証用」の印があるものを優先し、
                // なければ ID とパスワードの両方があるものの先頭を使う（取り込んだログインには印がないため）。
                let ids: Vec<String> = v.match_logins(url, &p.equiv_domains).iter().map(|e| e.id.clone()).collect();
                let reply = |it: &Item| json!({"id": it.id, "username": it.login_user(), "password": it.login_password()});
                let used = |v: &mut Vault, id: &str| {
                    let _ = v.touch(id); // 使用回数を増やす（「よく使う」の並びに効く）
                };
                if let Some(want) = arg_opt(a, "id") {
                    if !ids.iter().any(|id| id == want) {
                        return Err(SvcError::new(code::URL_MISMATCH, "このサイトのログインではありません"));
                    }
                    let it = v.get_item(want)?;
                    used(v, want);
                    return Ok(reply(&it));
                }
                let mut fallback = None;
                for id in ids {
                    let it = v.get_item(&id)?;
                    if it.basic_auth {
                        used(v, &id);
                        return Ok(reply(&it));
                    }
                    if fallback.is_none() && !it.login_user().is_empty() && !it.login_password().is_empty() {
                        fallback = Some(it);
                    }
                }
                if let Some(it) = &fallback {
                    used(v, &it.id);
                }
                fallback.map(|it| reply(&it)).ok_or_else(|| SvcError::new(code::NOT_FOUND, "該当するログインがありません"))
            })
        }
        "totp" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| {
                let it = v.get_item(id)?;
                let params = totp::parse(&it.totp_key).map_err(|e| SvcError::internal(e.to_string()))?;
                let (c, remain) = totp::now(&params);
                Ok(json!({"code": c, "remainSec": remain, "period": params.period}))
            })
        }
        "checkSave" => {
            let (url, user, pw) = (arg_str(a, "url")?, arg_str(a, "user").unwrap_or(""), arg_str(a, "password")?);
            core.with_vault(|v, p| {
                let ids: Vec<String> = v.match_logins(url, &p.equiv_domains).iter().filter(|e| e.user == user).map(|e| e.id.clone()).collect();
                // 同じユーザー ID のログインが複数あっても、どれかと同じパスワードなら保存は不要
                let mut update: Option<(String, String)> = None;
                for id in ids {
                    let it = v.get_item(&id)?;
                    if it.login_password() == pw {
                        return Ok(json!({"action": "none", "id": it.id, "name": it.name}));
                    }
                    update.get_or_insert((it.id.clone(), it.name.clone()));
                }
                match update {
                    Some((id, name)) => Ok(json!({"action": "update", "id": id, "name": name})),
                    None => Ok(json!({"action": "new"})),
                }
            })
        }
        // 秘密はブラウザを経由せず、アプリが直接クリップボードへ入れる
        "copyItem" => {
            let (id, field) = (arg_str(a, "id")?, arg_str(a, "field")?);
            let (text, secret) = core.with_vault(|v, _| {
                let it = v.get_item(id)?;
                // ID・パスワードのコピーは、そのログインを使ったものとして数える（続けてコピーしても 1 回）
                if matches!(field, "user" | "password") {
                    let _ = v.touch(id);
                }
                match field {
                    "user" => Ok((it.login_user().to_string(), false)),
                    "password" => Ok((it.login_password().to_string(), true)),
                    "url" => Ok((it.url.clone(), false)),
                    "totp" => {
                        let p = totp::parse(&it.totp_key).map_err(|e| SvcError::internal(e.to_string()))?;
                        Ok((totp::now(&p).0, true))
                    }
                    _ => Err(SvcError::internal("不明なフィールドです")),
                }
            })?;
            crate::clip::copy(core, &text, secret).map_err(SvcError::internal)?;
            if matches!(field, "user" | "password") {
                core.notify_changed();
            }
            Ok(json!({}))
        }
        "copyText" => {
            core.with_vault(|_, _| Ok(()))?;
            crate::clip::copy(core, arg_str(a, "text")?, true).map_err(SvcError::internal)?;
            Ok(json!({}))
        }
        "touch" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| {
                v.touch(id)?;
                Ok(json!({}))
            })
        }

        // ---------------------------------------------------------------- 一覧・検索・アイテム
        "search" => {
            let q = a.get("q").and_then(Value::as_str).unwrap_or("");
            let types: Vec<ItemType> = a
                .get("types")
                .and_then(Value::as_array)
                .map(|t| t.iter().filter_map(|x| x.as_u64().and_then(|n| ItemType::from_u8(n as u8))).collect())
                .unwrap_or_default();
            // 1 回の応答は 1000 件まで（NM の 1 メッセージは 1MB まで）。それより多い保管庫は、offset を進めて読み足す
            let limit = a.get("limit").and_then(Value::as_u64).unwrap_or(50).min(1000) as usize;
            let offset = a.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            core.with_vault(|v, _| {
                let list: Vec<Value> = v.search(q, &types, offset.saturating_add(limit)).into_iter().skip(offset).map(|e| serde_json::to_value(e).unwrap_or_default()).collect();
                Ok(json!(list))
            })
        }
        "listEntries" => core.with_vault(|v, _| {
            let list: Vec<&tkrform_core::IndexEntry> = v.entries().collect();
            Ok(serde_json::to_value(list).unwrap_or_default())
        }),
        "listFolders" => core.with_vault(|v, _| Ok(json!(v.folders()))),
        "getItem" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| Ok(serde_json::to_value(v.get_item(id)?).unwrap_or_default()))
        }
        "saveItem" => core.with_vault(|v, _| save_item(v, a)),
        "deleteItem" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| {
                v.delete_item(id)?;
                Ok(json!({}))
            })
        }
        "restoreItem" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| {
                v.restore_item(id)?;
                Ok(json!({}))
            })
        }
        "purgeItem" => {
            // 完全削除。UI 側で確認ダイアログを経てから呼ばれる
            let ids = arg_ids(a, "ids")?;
            core.with_vault(|v, _| {
                for id in &ids {
                    v.purge_item(id)?;
                }
                Ok(json!({"count": ids.len()}))
            })
        }
        "moveItems" => {
            let ids = arg_ids(a, "ids")?;
            let folder = normalize_path(arg_str(a, "folder")?)?;
            core.with_vault(|v, _| {
                v.begin_batch();
                let r = move_items(v, &ids, &folder);
                let f = v.end_batch();
                r?;
                f?;
                Ok(json!({}))
            })
        }
        "duplicateItem" => {
            let id = arg_str(a, "id")?;
            core.with_vault(|v, _| {
                let mut it = v.get_item(id)?;
                if it.kind == ItemType::Folder {
                    return Err(SvcError::internal("フォルダは複製できません"));
                }
                it.id = uuid::Uuid::new_v4().to_string();
                it.name = format!("{} のコピー", it.name);
                it.rev = 0;
                it.use_count = 0;
                it.last_used = None;
                it.use_score = 0.0;
                it.score_at = None;
                it.created = now_iso();
                it.password_history.clear();
                it.passkeys.clear(); // 秘密鍵は複製しない（複製元と同じパスキーが 2 つになるのを避ける）
                v.save_item(&mut it)?;
                Ok(json!({"id": it.id}))
            })
        }
        "createFolder" => {
            let path = normalize_path(arg_str(a, "path")?)?;
            core.with_vault(|v, _| {
                let (parent, name) = split_path(&path);
                let exists = v.entries().any(|e| e.kind == ItemType::Folder && !e.deleted && join_folder(&e.folder, &e.name) == path);
                if !exists {
                    let mut f = Item::new(ItemType::Folder, name);
                    f.folder = parent.to_string();
                    v.save_item(&mut f)?;
                }
                Ok(json!({"path": path}))
            })
        }
        "renameFolder" => {
            let path = normalize_path(arg_str(a, "path")?)?;
            let new_name = arg_str(a, "name")?.trim().to_string();
            if new_name.is_empty() || new_name.contains(['/', '\\']) {
                return Err(SvcError::internal("フォルダ名が不正です"));
            }
            core.with_vault(|v, _| {
                let (parent, _) = split_path(&path);
                let new_path = join_folder(parent, &new_name);
                v.begin_batch();
                let r = rebase_folder(v, &path, &new_path, Some(&new_name));
                let f = v.end_batch();
                r?;
                f?;
                Ok(json!({"path": new_path}))
            })
        }
        // フォルダを別のフォルダの中へ移す（UI 専用）。ルートへは to="/"
        "moveFolder" => {
            let path = normalize_path(arg_str(a, "path")?)?;
            let to = normalize_path(arg_str(a, "to")?)?;
            core.with_vault(|v, _| Ok(json!({"path": v.move_folder(&path, &to)?})))
        }
        "deleteFolder" => {
            // フォルダ内のアイテムをゴミ箱へ移す（完全削除ではない）
            let path = normalize_path(arg_str(a, "path")?)?;
            core.with_vault(|v, _| {
                let ids: Vec<String> = v
                    .entries()
                    .filter(|e| !e.deleted)
                    .filter(|e| {
                        let own = if e.kind == ItemType::Folder { join_folder(&e.folder, &e.name) } else { e.folder.clone() };
                        in_folder(&own, &path) && (e.kind != ItemType::Folder || in_folder(&join_folder(&e.folder, &e.name), &path))
                    })
                    .map(|e| e.id.clone())
                    .collect();
                v.begin_batch();
                let mut r = Ok(());
                for id in &ids {
                    if let Err(e) = v.delete_item(id) {
                        r = Err(e);
                        break;
                    }
                }
                let f = v.end_batch();
                r?;
                f?;
                Ok(json!({"count": ids.len()}))
            })
        }
        "identityLayout" => {
            let country = a.get("country").and_then(Value::as_str).unwrap_or("JP");
            let l: Vec<Value> = identity_layout(country).into_iter().map(|(g, keys)| json!({"group": g, "keys": keys})).collect();
            Ok(json!(l))
        }
        "checkIntegrity" => core.with_vault(|v, _| {
            let bad = v.check_integrity()?;
            Ok(json!({"corrupt": bad}))
        }),

        // ---------------------------------------------------------------- 生成器
        "generate" => {
            let opts: GenOptions = match a.get("options") {
                Some(o) if !o.is_null() => serde_json::from_value(o.clone()).map_err(|e| SvcError::internal(e.to_string()))?,
                _ => GenOptions::default(),
            };
            let g = generator::generate(&opts)?;
            if a.get("record").and_then(Value::as_bool).unwrap_or(false) {
                let _ = core.with_vault(|v, _| {
                    v.push_generated(&g.password)?;
                    Ok(())
                });
            }
            Ok(json!({"password": g.password, "bits": g.bits, "class": generator::strength_class(g.bits)}))
        }
        "genHistory" => core.with_vault(|v, _| {
            Ok(json!(v.generated_history().into_iter().map(|(p, at)| json!({"password": p, "at": at})).collect::<Vec<_>>()))
        }),
        "clearGenHistory" => core.with_vault(|v, _| {
            v.clear_generated_history()?;
            Ok(json!({}))
        }),

        // ---------------------------------------------------------------- ウィンドウ・ブラウザ
        "openEditor" => {
            if let Some(app) = core.app.get() {
                wins::open_editor(app, core, arg_opt(a, "id"));
            }
            Ok(json!({}))
        }
        "openGenerator" => {
            if let Some(app) = core.app.get() {
                wins::open_passgen(app);
            }
            Ok(json!({}))
        }
        "openWindow" => {
            if let Some(app) = core.app.get() {
                wins::open_by_name(app, core, arg_str(a, "name")?);
            }
            Ok(json!({}))
        }
        "openUrl" => {
            sys::open_url(arg_str(a, "url")?).map_err(SvcError::internal)?;
            Ok(json!({}))
        }
        "openBrowserPage" => {
            sys::open_browser_page(arg_str(a, "browser").unwrap_or("chrome"), arg_str(a, "page")?);
            Ok(json!({}))
        }
        "openExtensionFolder" => {
            if let Some(dir) = extension_dir(core) {
                sys::open_folder(&dir);
                Ok(json!({"path": dir.to_string_lossy()}))
            } else {
                Err(SvcError::internal("拡張のフォルダが見つかりません"))
            }
        }
        "extensionInfo" => Ok(json!({
            "path": extension_dir(core).map(|p| p.to_string_lossy().to_string()),
            "id": tkrform_ipc::proto::ALLOWED_EXTENSION_IDS.first(),
        })),
        "fillLogin" => {
            let id = arg_str(a, "id")?;
            let mode = arg_opt(a, "mode").unwrap_or("tab");
            let submit = a.get("submit").and_then(Value::as_bool);
            go_and_fill(core, &[id.to_string()], mode, submit)?;
            Ok(json!({}))
        }
        "batchLogin" => {
            go_and_fill(core, &arg_ids(a, "ids")?, "tab", None)?; // 送信するかは、各項目の「記入後に送信する」に従う
            Ok(json!({}))
        }

        // ---------------------------------------------------------------- バックアップ・インポート・エクスポート
        "backupNow" => {
            let p = core.prefs();
            let r = core.check_backup_target(&p).and_then(|target| {
                core.with_vault(|v, _| {
                    let path = v.backup_now_in(&target)?;
                    vault::prune_backups_in(&target, p.backup.generations.max(1) as usize);
                    Ok(json!({"path": path.to_string_lossy()}))
                })
            });
            match &r {
                Ok(_) => *core.backup_error.lock().unwrap_or_else(|e| e.into_inner()) = None,
                Err(e) if e.code != code::LOCKED => core.backup_failed(&e.message),
                Err(_) => {}
            }
            r
        }
        // バックアップの保存先の状態（UI 専用）: 今の保存先・直近の失敗・以前の保存先に残っているバックアップの数
        "backupStatus" => {
            let p = core.prefs();
            let cur = core.backup_target(&p);
            let def = vault::backups_dir(&core.dir);
            let mut prev: Vec<std::path::PathBuf> = p.backup.prev_dirs.iter().map(std::path::PathBuf::from).collect();
            if cur != def {
                prev.push(def.clone());
            }
            let previous: Vec<Value> = prev
                .into_iter()
                .filter(|d| *d != cur)
                .filter_map(|d| {
                    let n = vault::list_backups_in(&d).len();
                    (n > 0).then(|| json!({"dir": d.to_string_lossy(), "count": n}))
                })
                .collect();
            Ok(json!({
                "dir": cur.to_string_lossy(), "isDefault": cur == def, "defaultDir": def.to_string_lossy(),
                "lastError": core.backup_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                "previous": previous,
            }))
        }
        // 保存先を変える（UI 専用）。空なら既定に戻す。古い保存先のバックアップは、移動も削除もしない
        "backupSetDir" => {
            let new = a.get("dir").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let mut p = core.prefs();
            let cur = core.backup_target(&p);
            let def = vault::backups_dir(&core.dir);
            let target = if new.is_empty() { def.clone() } else { std::path::PathBuf::from(&new) };
            if !new.is_empty() {
                vault::validate_backup_dir(&core.dir, &target)?;
            }
            if target != cur {
                let old = cur.to_string_lossy().to_string();
                let new_s = target.to_string_lossy().to_string();
                p.backup.prev_dirs.retain(|d| *d != old && *d != new_s);
                if !vault::list_backups_in(&cur).is_empty() {
                    p.backup.prev_dirs.push(old);
                }
                let extra = p.backup.prev_dirs.len().saturating_sub(10);
                p.backup.prev_dirs.drain(..extra);
                p.backup.dir = if new.is_empty() { String::new() } else { new_s };
                core.set_prefs(p)?;
                *core.backup_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                core.log("backup.dir.changed", "-");
            }
            Ok(json!({}))
        }
        // 指定したフォルダの中のバックアップ（tkrform が作った名前のものだけ。UI 専用）
        "listBackupsIn" => {
            let d = std::path::PathBuf::from(arg_str(a, "dir")?);
            if !d.is_dir() {
                return Err(SvcError::internal("フォルダが見つかりません"));
            }
            let list: Vec<Value> = vault::list_backups_in(&d)
                .into_iter()
                .map(|p| {
                    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    json!({"path": p.to_string_lossy(), "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "size": size, "dir": d.to_string_lossy(), "location": "picked"})
                })
                .collect();
            Ok(json!(list))
        }
        // 全初期化（UI 専用）: マスターパスワードを再入力させて、合っているときだけ実行する
        "factoryReset" => {
            let ok = core.with_vault(|v, _| Ok(v.verify_password(arg_str(a, "password")?)))?;
            if !ok {
                return Err(SvcError::new(code::BAD_PASSWORD, "マスターパスワードが違います"));
            }
            core.factory_reset()?;
            // 開いている画面をすべて閉じて、最初のセットアップ画面を出す（応答を返したあとに行う）
            if let Some(app) = core.app.get().cloned() {
                let core = core.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    use tauri::Manager;
                    for (_, w) in app.webview_windows() {
                        let _ = w.destroy();
                    }
                    // 閉じ終わる（同じラベルのウィンドウが残っていない）のを待ってから作る。すぐ作ると、作成に失敗することがある
                    for _ in 0..40 {
                        if app.webview_windows().is_empty() {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    wins::open_setup(&app, &core);
                });
            }
            Ok(json!({}))
        }
        "listBackups" => {
            let p = core.prefs();
            let cur = core.backup_target(&p);
            let def = vault::backups_dir(&core.dir);
            let mut dirs: Vec<(std::path::PathBuf, &str)> = vec![(cur.clone(), "current")];
            if def != cur {
                dirs.push((def, "default"));
            }
            for d in &p.backup.prev_dirs {
                let d = std::path::PathBuf::from(d);
                if !dirs.iter().any(|(x, _)| *x == d) {
                    dirs.push((d, "previous"));
                }
            }
            let mut list: Vec<Value> = Vec::new();
            for (d, loc) in dirs {
                for p in vault::list_backups_in(&d) {
                    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    list.push(json!({"path": p.to_string_lossy(), "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "size": size, "dir": d.to_string_lossy(), "location": loc}));
                }
            }
            Ok(json!(list))
        }
        "restoreBackup" => {
            // UI 側で確認ダイアログを経てから呼ばれる。復元後はロック状態に戻す
            let path = std::path::PathBuf::from(arg_str(a, "path")?);
            core.lock();
            vault::restore_backup(&core.dir, &path)?;
            Ok(json!({}))
        }
        "importPreview" => import_preview(arg_str(a, "path")?, arg_opt(a, "format")),
        "importRun" => import_run(core, a),
        "exportData" => export_data(core, a),
        "decodeQr" => decode_qr(arg_str(a, "path")?),
        _ => Err(SvcError::internal(format!("不明なコマンド: {cmd}"))),
    }
}

// -------------------------------------------------------------------- ヘルパ

fn extension_dir(core: &Core) -> Option<std::path::PathBuf> {
    // Store 版: インストール先は Chrome が読めないので、起動時にコピーした、パッケージの外のフォルダを使う
    if crate::msix::is_packaged() {
        let p = core.root.join("extension");
        if p.join("manifest.json").is_file() {
            return p.canonicalize().ok();
        }
    }
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?;
    let candidates = [base.join("extension"), base.join("..").join("..").join("extension"), base.join("..").join("..").join("..").join("extension")];
    candidates.into_iter().find(|p| p.join("manifest.json").is_file()).and_then(|p| p.canonicalize().ok())
}

/// ログインの URL を開き、拡張へ記入を指示する（`fillRequest` イベント）。
///
/// `mode`: `tab`（新しいタブ）/ `window`（新しいウィンドウ）/ `current`（開かず、いま開いているタブに記入）/ `go`（開くだけ）
/// `submit`: 記入後に送信するか。`None` ならログインの設定に従う。
fn go_and_fill(core: &Arc<Core>, ids: &[String], mode: &str, submit: Option<bool>) -> Result<(), SvcError> {
    let mut targets = Vec::new();
    core.with_vault(|v, _| {
        for id in ids {
            let it = v.get_item(id)?;
            if it.kind == ItemType::Login || it.kind == ItemType::Bookmark {
                targets.push((it.id.clone(), it.kind, it.url.clone()));
                if it.kind == ItemType::Login {
                    let _ = v.touch(id);
                }
            }
        }
        Ok(())
    })?;
    for (id, kind, url) in targets {
        if url.is_empty() {
            continue;
        }
        let url = if url.contains("://") { url } else { format!("https://{url}") };
        if kind == ItemType::Login && mode != "go" {
            if let Some(p) = core.pipe.get() {
                p.broadcast(&tkrform_ipc::Event::new("fillRequest", json!({"id": id, "url": url, "submit": submit, "current": mode == "current"})));
            }
        }
        match mode {
            "current" => {}
            "window" => sys::open_url_new_window(&url).map_err(SvcError::internal)?,
            _ => sys::open_url(&url).map_err(SvcError::internal)?,
        }
        if ids.len() > 1 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
    Ok(())
}

pub fn normalize_path(p: &str) -> Result<String, SvcError> {
    let p = p.trim().replace('\\', "/");
    let parts: Vec<&str> = p.split('/').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.iter().any(|s| *s == "." || *s == ".." || s.chars().any(|c| c.is_control())) {
        return Err(SvcError::internal("フォルダのパスが不正です"));
    }
    Ok(format!("/{}", parts.join("/")))
}

fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(0) | None => ("/", path.trim_start_matches('/')),
        Some(i) => (&path[..i], &path[i + 1..]),
    }
}

/// `path` が `base` 自身またはその配下か。
fn in_folder(path: &str, base: &str) -> bool {
    path == base || path.starts_with(&format!("{}/", base.trim_end_matches('/')))
}

fn save_item(v: &mut Vault, a: &Value) -> R {
    let mode = a.get("mode").and_then(Value::as_str).unwrap_or("new");
    let mut raw = a.get("item").cloned().ok_or_else(|| SvcError::internal("item がありません"))?;
    let obj = raw.as_object_mut().ok_or_else(|| SvcError::internal("item の形式が不正です"))?;
    let mut item: Item = if mode == "update" {
        let id = obj.get("id").and_then(Value::as_str).ok_or_else(|| SvcError::internal("id がありません"))?.to_string();
        let existing = serde_json::to_value(v.get_item(&id)?).unwrap_or_default();
        // replace: 送られた item で丸ごと置き換える（エディタ用。空にした項目も反映される）
        // それ以外: 既存のアイテムに、送られたキーだけを重ねる（拡張の部分更新）
        let replace = a.get("replace").and_then(Value::as_bool).unwrap_or(false);
        let mut cur = if replace { Value::Object(obj.clone()) } else { existing.clone() };
        let cur_obj = cur.as_object_mut().ok_or_else(|| SvcError::internal("内部エラー"))?;
        if !replace {
            for (k, val) in obj.iter() {
                if !matches!(k.as_str(), "id" | "type" | "rev" | "created" | "passwordHistory") {
                    cur_obj.insert(k.clone(), val.clone());
                }
            }
        }
        // id・type・created とパスワード履歴は保管庫側の値を正とする
        for k in ["id", "type", "created"] {
            if let Some(x) = existing.get(k) {
                cur_obj.insert(k.into(), x.clone());
            }
        }
        // パスキーも保管庫側の値を正とする（エディタからは専用の削除コマンドでだけ消す。拡張・古い画面の保存で消えないように）
        match existing.get("passkeys") {
            Some(h) => {
                cur_obj.insert("passkeys".into(), h.clone());
            }
            None => {
                cur_obj.remove("passkeys");
            }
        }
        match existing.get("passwordHistory") {
            Some(h) => {
                cur_obj.insert("passwordHistory".into(), h.clone());
            }
            None => {
                cur_obj.remove("passwordHistory");
            }
        }
        serde_json::from_value(cur).map_err(|e| SvcError::internal(e.to_string()))?
    } else {
        let now = now_iso();
        if obj.get("id").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) {
            obj.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
        }
        obj.entry("created").or_insert(json!(now));
        obj.entry("modified").or_insert(json!(now));
        obj.insert("rev".into(), json!(0));
        obj.remove("passkeys"); // パスキーは専用のコマンドでだけ作る
        let it: Item = serde_json::from_value(raw).map_err(|e| SvcError::internal(format!("item の形式が不正です: {e}")))?;
        if v.entry(&it.id).is_some() {
            return Err(SvcError::internal("同じ ID のアイテムが既にあります"));
        }
        it
    };
    item.folder = normalize_path(&item.folder)?;
    if item.kind == ItemType::Folder {
        item.folder = normalize_path(&item.folder)?;
    }
    v.save_item(&mut item)?;
    Ok(json!({"id": item.id, "rev": item.rev}))
}

fn move_items(v: &mut Vault, ids: &[String], folder: &str) -> Result<(), SvcError> {
    for id in ids {
        let it = v.get_item(id)?;
        if it.kind == ItemType::Folder {
            let old = join_folder(&it.folder, &it.name);
            let new = join_folder(folder, &it.name);
            if in_folder(folder, &old) {
                return Err(SvcError::internal("フォルダを自分自身の中へは移動できません"));
            }
            rebase_folder(v, &old, &new, None)?;
        } else {
            let mut it = it;
            it.folder = folder.to_string();
            v.save_item(&mut it)?;
        }
    }
    Ok(())
}

/// フォルダ `old` 配下の全アイテム（と子フォルダ）を `new` の配下へ付け替える。
/// `rename` があれば、`old` 自身のフォルダ項目の名前も変える。
fn rebase_folder(v: &mut Vault, old: &str, new: &str, rename: Option<&str>) -> Result<(), SvcError> {
    let ids: Vec<String> = v.entries().filter(|e| !e.corrupt).map(|e| e.id.clone()).collect();
    for id in ids {
        let mut it = v.get_item(&id)?;
        let mut changed = false;
        if it.kind == ItemType::Folder && join_folder(&it.folder, &it.name) == old {
            let (parent, name) = split_path(new);
            it.folder = parent.to_string();
            it.name = rename.map(str::to_string).unwrap_or_else(|| name.to_string());
            changed = true;
        } else if in_folder(&it.folder, old) {
            it.folder = format!("{new}{}", &it.folder[old.len()..]);
            changed = true;
        }
        if changed {
            v.save_item(&mut it)?;
        }
    }
    Ok(())
}

/// プロフィールをフィールド名 → 値の平らな表にする。複数インスタンスは `instance` 名で選ぶ（なければ最初）。
fn identity_flat(it: &Item, instance: Option<&str>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for g in &it.groups {
        let inst = instance.and_then(|n| g.instances.iter().find(|i| i.name == n)).or_else(|| g.instances.first());
        if let Some(inst) = inst {
            for (k, val) in &inst.fields {
                if !val.is_empty() {
                    map.entry(k.clone()).or_insert_with(|| val.clone());
                }
            }
        }
    }
    if !map.contains_key("FullName") {
        let (f, l) = (map.get("FirstName").cloned().unwrap_or_default(), map.get("LastName").cloned().unwrap_or_default());
        if !f.is_empty() || !l.is_empty() {
            let full = if it.country == "US" { format!("{f} {l}") } else { format!("{l} {f}") };
            map.insert("FullName".into(), full.trim().to_string());
        }
    }
    if !it.country.is_empty() {
        map.entry("CountryCode".into()).or_insert_with(|| it.country.clone());
    }
    map
}

/// カスタム項目: キー → {value, match(正規表現)}。
fn custom_matches(it: &Item, instance: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    for g in it.groups.iter().filter(|g| g.group == "Custom") {
        let inst = instance.and_then(|n| g.instances.iter().find(|i| i.name == n)).or_else(|| g.instances.first());
        if let Some(inst) = inst {
            for (k, val) in &inst.fields {
                if let Some(re) = inst.custom_matches.get(k) {
                    out.push(json!({"key": k, "value": val, "match": re}));
                }
            }
        }
    }
    out
}

// -------------------------------------------------------------------- インポート・エクスポート

const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;

fn read_limited(path: &str) -> Result<Vec<u8>, SvcError> {
    let meta = std::fs::metadata(path).map_err(|e| SvcError::internal(format!("ファイルを読めません: {e}")))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(SvcError::internal("ファイルが大きすぎます（100MB まで）"));
    }
    std::fs::read(path).map_err(|e| SvcError::internal(format!("ファイルを読めません: {e}")))
}

fn sniff_kind(path: &str, data: &[u8]) -> &'static str {
    let text = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if path.to_lowercase().ends_with(".json") || t.starts_with('{') {
        if t.contains("\"tkrform-json\"") {
            "tkrform"
        } else {
            "bitwarden"
        }
    } else {
        "csv"
    }
}

fn import_preview(path: &str, format: Option<&str>) -> R {
    let data = read_limited(path)?;
    let kind = sniff_kind(path, &data);
    if kind != "csv" {
        return Ok(json!({"kind": kind}));
    }
    // Keeper の CSV はヘッダ行がないため、利用者が形式を指定する
    let keeper = format == Some("keeper");
    let table = if keeper { portio::read_csv_headerless(&data)? } else { portio::read_csv(&data)? };
    let format = if keeper { portio::CsvFormat::Keeper } else { portio::detect_format(&table.headers) };
    let mapping = if keeper { portio::keeper_mapping() } else { portio::auto_mapping(&table.headers) };
    let pw_col = mapping.password;
    let sample: Vec<Vec<String>> = table
        .rows
        .iter()
        .take(3)
        .map(|r| r.iter().enumerate().map(|(i, c)| if Some(i) == pw_col { "••••••".to_string() } else { c.clone() }).collect())
        .collect();
    Ok(json!({"kind": "csv", "format": format, "headers": table.headers, "rowCount": table.rows.len(), "mapping": mapping, "sample": sample}))
}

fn import_run(core: &Arc<Core>, a: &Value) -> R {
    let path = arg_str(a, "path")?;
    let data = read_limited(path)?;
    let kind = a.get("kind").and_then(Value::as_str).unwrap_or_else(|| sniff_kind(path, &data));
    let root = portio::default_import_root();
    let items = match kind {
        "csv" => {
            let mapping: Option<portio::CsvMapping> = a.get("mapping").filter(|m| !m.is_null()).and_then(|m| serde_json::from_value(m.clone()).ok());
            let fmt = if a.get("format").and_then(Value::as_str) == Some("keeper") { Some(portio::CsvFormat::Keeper) } else { None };
            portio::import_csv_as(&data, fmt, mapping.as_ref(), &root)?
        }
        "bitwarden" => portio::import_bitwarden_json(&data, &root)?,
        "tkrform" => {
            let mut items = portio::import_tkrform_json(&data)?;
            for it in &mut items {
                it.folder = format!("/{root}{}", if it.folder == "/" { String::new() } else { it.folder.clone() });
            }
            items
        }
        _ => return Err(SvcError::internal("未対応の形式です")),
    };
    let skip = a.get("skipDuplicates").and_then(Value::as_bool).unwrap_or(true);
    let total = items.len();
    let report = core.with_vault(|v, _| Ok(v.import_items(items, skip)?))?;
    Ok(json!({"total": total, "added": report.added, "duplicates": report.duplicates, "folder": format!("/{root}")}))
}

fn export_data(core: &Arc<Core>, a: &Value) -> R {
    let format = arg_str(a, "format")?;
    let path = arg_str(a, "path")?;
    let pw = arg_str(a, "password")?;
    core.with_vault(|v, _| {
        // 平文のエクスポートは MP の再入力を必須とする（§14.2）
        if !v.verify_password(pw) {
            return Err(SvcError::new(code::BAD_PASSWORD, "マスターパスワードが違います"));
        }
        match format {
            "tkb" => {
                v.flush_index()?;
                vault::write_backup_zip(&core.dir, std::path::Path::new(path))?;
            }
            "csv" | "json" => {
                let (items, bad) = v.load_all(false)?;
                let bytes = if format == "csv" { portio::export_csv(&items)? } else { portio::export_json(&items)? };
                std::fs::write(path, bytes).map_err(|e| SvcError::internal(format!("書き込めません: {e}")))?;
                if !bad.is_empty() {
                    return Ok(json!({"ok": true, "skippedCorrupt": bad.len()}));
                }
            }
            _ => return Err(SvcError::internal("未対応の形式です")),
        }
        core.log("export", format);
        Ok(json!({"ok": true}))
    })
}

fn decode_qr(path: &str) -> R {
    let img = image::open(path).map_err(|e| SvcError::internal(format!("画像を読めません: {e}")))?.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(img);
    for grid in prepared.detect_grids() {
        if let Ok((_, content)) = grid.decode() {
            return Ok(json!({"text": content}));
        }
    }
    Err(SvcError::internal("QR コードを検出できませんでした"))
}

// -------------------------------------------------------------------- Windows アプリ

/// 前面（または指定）のウィンドウを取り込み、保存ダイアログを開く。
pub fn capture_app(core: &Arc<Core>, hwnd: Option<windows::Win32::Foundation::HWND>) -> Result<(), SvcError> {
    if core.is_locked() {
        return Err(SvcError::locked());
    }
    let prefs = core.prefs();
    if !prefs.apps.link_apps {
        return Err(SvcError::new(code::POLICY_DENIED, "Windows アプリとの連結がオフです"));
    }
    let hwnd = hwnd.ok_or_else(|| SvcError::internal("取り込むウィンドウが見つかりません"))?;
    let cap = crate::winfill::capture(hwnd)?;
    if prefs.apps.ignored_apps.iter().any(|i| i.eq_ignore_ascii_case(&cap.exe_name)) || crate::winfill::is_self(&cap.exe_name) {
        return Err(SvcError::new(code::POLICY_DENIED, format!("{} は連結しないアプリに設定されています", cap.exe_name)));
    }
    *core.pending_app.lock().unwrap_or_else(|e| e.into_inner()) = Some(cap);
    if let Some(app) = core.app.get() {
        wins::open_appsave(app, core);
    }
    Ok(())
}

/// ホットキー（Ctrl+Alt+A）: 前面のウィンドウを取り込む。ロック中ならログインを促す。
pub fn capture_app_hotkey(core: &Arc<Core>) {
    // HWND はスレッド間で渡せないので、数値にして持ち込む
    let raw = crate::sys::foreground_now().map(|h| h.0 as isize);
    let core = core.clone();
    std::thread::spawn(move || {
        let hwnd = raw.map(|r| windows::Win32::Foundation::HWND(r as *mut std::ffi::c_void));
        if core.is_locked() {
            if let Some(app) = core.app.get() {
                wins::open_login(app, &core, Some("appcapture"));
            }
            return;
        }
        if let Err(e) = capture_app(&core, hwnd) {
            core.log("app.capture.failed", e.code);
            if let Some(app) = core.app.get() {
                crate::winfill::notify(app, &e.message);
            }
        }
    });
}

/// アプリログインを、前面にあったウィンドウ（または指定のウィンドウ）へ記入する。
pub fn fill_app(core: &Arc<Core>, id: &str, window_title: Option<&str>) -> Result<usize, SvcError> {
    let prefs = core.prefs();
    if !prefs.apps.link_apps {
        return Err(SvcError::new(code::POLICY_DENIED, "Windows アプリとの連結がオフです"));
    }
    let item = core.with_vault(|v, _| Ok(v.get_item(id)?))?;
    if item.kind != ItemType::AppLogin || item.deleted {
        return Err(SvcError::new(code::NOT_FOUND, "アプリログインが見つかりません"));
    }
    let exe_name = |p: &str| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let want = exe_name(&item.exe_path);
    let mut hwnd = match window_title {
        Some(t) => crate::sys::find_window_by_title(t),
        None => crate::sys::last_foreground(),
    };
    let matches = |h: windows::Win32::Foundation::HWND| crate::winfill::exe_of(h).map(|p| exe_name(&p) == want).unwrap_or(false);
    if !hwnd.map(matches).unwrap_or(false) {
        // 対象のアプリが前面にない。許可されていれば、確認のうえ起動する（既定オフ）
        if prefs.apps.allow_exec && std::path::Path::new(&item.exe_path).is_file() {
            let app = core.app.get().ok_or_else(|| SvcError::internal("アプリが初期化されていません"))?;
            if !crate::winfill::confirm_launch(app, &item.exe_path) {
                return Err(SvcError::internal("起動をキャンセルしました"));
            }
            std::process::Command::new(&item.exe_path).spawn().map_err(|e| SvcError::internal(format!("起動できません: {e}")))?;
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Some(h) = crate::sys::foreground_now().filter(|h| matches(*h)) {
                    hwnd = Some(h);
                    break;
                }
            }
        }
    }
    let hwnd = hwnd.ok_or_else(|| SvcError::internal("入力先のウィンドウが見つかりません。対象のアプリを前面にしてからやり直してください"))?;
    let n = crate::winfill::fill(&item, hwnd, &prefs.apps.ignored_apps)?;
    if n > 0 {
        let _ = core.with_vault(|v, _| Ok(v.touch(id)?));
    }
    Ok(n)
}

/// 漏洩チェック（既定オフ・同意制）。パスワードそのものは送らず、SHA-1 の先頭 5 文字だけを送る。
fn breach_check(core: &Arc<Core>) -> R {
    let p = core.prefs();
    if !p.security.breach_check || p.security.breach_consent.is_empty() {
        return Err(SvcError::new(code::POLICY_DENIED, "漏洩チェックがオフです。同意画面で有効にしてください"));
    }
    // 1) 保管庫から (id, 名前, SHA-1) だけを取り出す（ロックは短く）
    let rows: Vec<(String, String, String)> = core.with_vault(|v, _| {
        let (items, _) = v.load_all(false)?;
        Ok(items
            .iter()
            .filter(|i| i.kind == ItemType::Login && !i.login_password().is_empty())
            .map(|i| (i.id.clone(), i.name.clone(), tkrform_core::security::sha1_hex_upper(i.login_password())))
            .collect())
    })?;
    // 2) ネットワーク（ロックなし）
    let base = if sys::testing() { std::env::var("TKRFORM_HIBP_URL").ok() } else { None }.unwrap_or_else(|| "https://api.pwnedpasswords.com/range/".to_string());
    let hashes: Vec<(String, String)> = rows.iter().map(|(id, _, h)| (id.clone(), h.clone())).collect();
    let hits = tkrform_core::security::check_breaches(&hashes, |prefix| tkrform_core::security::fetch_range_http(&base, prefix))?;
    let list: Vec<Value> = hits
        .iter()
        .map(|(id, n)| json!({"id": id, "name": rows.iter().find(|r| &r.0 == id).map(|r| r.1.clone()).unwrap_or_default(), "count": n}))
        .collect();
    Ok(json!({"checked": rows.len(), "breached": list}))
}

/// 今フォーカスのあるアプリのウィンドウ（設定など）を前面にして、Windows Hello の確認の持ち主にする。
fn focus_hello_owner(core: &Arc<Core>) {
    if let Some(app) = core.app.get() {
        use tauri::Manager;
        if let Some(w) = app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)) {
            if let Ok(h) = w.hwnd() {
                crate::sys::force_foreground(windows::Win32::Foundation::HWND(h.0));
            }
        }
    }
}
