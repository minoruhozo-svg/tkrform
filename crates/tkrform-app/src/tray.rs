//! トレイアイコンとメニュー（§10.1）。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};
use tkrform_core::model::ItemType;

use crate::core::Core;
use crate::locale::{t, tf};
use crate::service::{self, Source};
use crate::wins;

const TRAY_ID: &str = "main";
const MAX_ITEMS_PER_CATEGORY: usize = 300;

#[derive(Default)]
struct Node {
    children: BTreeMap<String, Node>,
    items: Vec<(String, String)>,
}

impl Node {
    fn insert(&mut self, folder: &str, id: &str, name: &str) {
        let mut cur = self;
        for part in folder.split('/').filter(|p| !p.is_empty()) {
            cur = cur.children.entry(part.to_string()).or_default();
        }
        cur.items.push((id.to_string(), name.to_string()));
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&&")
}

fn build_node(app: &AppHandle, node: &Node, title: &str, empty_label: &str) -> tauri::Result<Submenu<Wry>> {
    let mut sb = SubmenuBuilder::new(app, esc(title));
    for (name, child) in &node.children {
        sb = sb.item(&build_node(app, child, name, empty_label)?);
    }
    for (id, name) in &node.items {
        sb = sb.text(format!("open:{id}"), esc(name));
    }
    if node.children.is_empty() && node.items.is_empty() {
        sb = sb.item(&MenuItemBuilder::new(empty_label).enabled(false).build(app)?);
    }
    sb.build()
}

fn build_menu(app: &AppHandle, core: &Arc<Core>) -> tauri::Result<Menu<Wry>> {
    let prefs = core.prefs();
    let lang = prefs.general.language.clone();
    let l = |k: &str| t(&lang, k);
    let locked = core.is_locked();
    let mut mb = MenuBuilder::new(app);

    if locked {
        mb = mb.text("m:unlock", l("Tray_Login")).separator();
    } else {
        // 種別ごとの一覧（人気順）。フォルダ階層どおりのカスケードメニューにする
        type Row = (String, String, String);
        let mut cats: [(ItemType, Vec<Row>); 4] =
            [(ItemType::Login, vec![]), (ItemType::Identity, vec![]), (ItemType::Note, vec![]), (ItemType::AppLogin, vec![])];
        let _ = core.with_vault(|v, _| {
            let mut rows: Vec<&tkrform_core::IndexEntry> = v.entries().filter(|e| !e.deleted && !e.corrupt).collect();
            // 点数と小文字の名前は、並べる前に 1 回だけ作る
            let now = chrono::Utc::now();
            let mut keyed: Vec<(bool, f64, String, &tkrform_core::IndexEntry)> = rows.drain(..).map(|e| (e.favorite, e.popularity(now), e.name.to_lowercase(), e)).collect();
            keyed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.total_cmp(&a.1)).then_with(|| a.2.cmp(&b.2)));
            let rows: Vec<&tkrform_core::IndexEntry> = keyed.into_iter().map(|k| k.3).collect();
            for e in rows {
                for (k, list) in cats.iter_mut() {
                    let hit = e.kind == *k || (*k == ItemType::Identity && e.kind == ItemType::Contact);
                    if hit {
                        list.push((e.id.clone(), e.name.clone(), e.folder.clone()));
                    }
                }
            }
            Ok(())
        });
        let titles = [l("Tray_Logins_Menu"), l("Tray_Identities_Menu"), l("Tray_Notes_Menu"), l("Tray_Apps_Menu")];
        for ((_, rows), title) in cats.iter().zip(titles.iter()) {
            let mut root = Node::default();
            for (id, name, folder) in rows.iter().take(MAX_ITEMS_PER_CATEGORY) {
                root.insert(folder, id, name);
            }
            let sub = build_node(app, &root, title, &l("Tray_Empty"))?;
            if rows.len() > MAX_ITEMS_PER_CATEGORY {
                // 上限を超えた分はエディタで見る
                let more = tf(&lang, "Tray_More", &[&(rows.len() - MAX_ITEMS_PER_CATEGORY).to_string()]);
                sub.append(&MenuItemBuilder::new(more).enabled(false).build(app)?)?;
            }
            mb = mb.item(&sub);
        }
        mb = mb.separator();
    }

    mb = mb
        .text("m:search", format!("{}\t{}", l("Tray_Search"), prefs.hotkeys.search))
        .text("m:editor", l("Tray_OpenEditor"))
        .text("m:security", l("Tray_Security"))
        .text("m:passgen", l("Tray_PassGen"))
        .separator()
        .item(&MenuItemBuilder::with_id("m:sync", l("Tray_Sync")).enabled(prefs.sync.enabled && !locked).build(app)?);
    mb = if locked {
        mb.text("m:unlock", l("Tray_Login"))
    } else {
        mb.text("m:lock", format!("{}\t{}", l("Tray_Lock"), prefs.hotkeys.lock))
    };
    let mut help = SubmenuBuilder::new(app, l("Tray_Help")).text("m:ext_help", l("Tray_ExtensionHelp"));
    if !crate::msix::is_packaged() {
        help = help.text("m:update", l("Tray_Update")); // Store 版は、Store が更新する
    }
    let help = help.text("m:about", l("Tray_About")).build()?;
    mb.text("m:settings", l("Tray_Settings")).item(&help).separator().text("m:quit", l("Tray_Quit")).build()
}

fn icon(locked: bool) -> Option<Image<'static>> {
    let bytes: &[u8] = if locked { include_bytes!("../icons/tray-locked.png") } else { include_bytes!("../icons/tray-unlocked.png") };
    Image::from_bytes(bytes).ok()
}

pub fn init(app: &AppHandle, core: &Arc<Core>) -> tauri::Result<()> {
    let menu = build_menu(app, core)?;
    let locked = core.is_locked();
    let lang = core.prefs().general.language;
    let core_menu = core.clone();
    let core_click = core.clone();
    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(t(&lang, if locked { "Tray_Tooltip_Locked" } else { "Tray_Tooltip_Unlocked" }))
        .on_menu_event(move |app, ev| handle_menu_event(app, &core_menu, ev.id().as_ref()))
        .on_tray_icon_event(move |tray, ev| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev {
                wins::open_editor(tray.app_handle(), &core_click, None);
            }
        });
    if let Some(i) = icon(locked) {
        b = b.icon(i);
    }
    b.build(app)?;
    Ok(())
}

/// メニューとアイコンを今すぐ作り直す。
pub fn refresh(app: &AppHandle, core: &Arc<Core>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let locked = core.is_locked();
    let lang = core.prefs().general.language;
    if let Ok(menu) = build_menu(app, core) {
        let _ = tray.set_menu(Some(menu));
    }
    if let Some(i) = icon(locked) {
        let _ = tray.set_icon(Some(i));
    }
    let _ = tray.set_tooltip(Some(t(&lang, if locked { "Tray_Tooltip_Locked" } else { "Tray_Tooltip_Unlocked" })));
}

static GEN: AtomicU64 = AtomicU64::new(0);

/// 変更が続くときに作り直しを 1 回にまとめる（debounce）。
pub fn refresh_soon(app: &AppHandle, core: &Arc<Core>) {
    let my = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (app, core) = (app.clone(), core.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if GEN.load(Ordering::SeqCst) == my {
            refresh(&app, &core);
        }
    });
}

fn handle_menu_event(app: &AppHandle, core: &Arc<Core>, id: &str) {
    let (app, core, id) = (app.clone(), core.clone(), id.to_string());
    // メニューのコールバックを塞がないよう別スレッドで処理する
    std::thread::spawn(move || {
        match id.as_str() {
            "m:unlock" => wins::open_login(&app, &core, None),
            "m:lock" => core.lock(),
            "m:search" => wins::open_by_name(&app, &core, "search"),
            "m:editor" => wins::open_editor(&app, &core, None),
            "m:passgen" => wins::open_passgen(&app),
            "m:security" => wins::open_security(&app, &core),
            "m:settings" => wins::open_settings(&app, &core),
            "m:about" => wins::open_about(&app, &core),
            "m:update" => match crate::update::check(&core) {
                Ok(Some(m)) => {
                    if let Err(e) = crate::update::install(&core, &m) {
                        crate::winfill::notify(&app, &e.message);
                    }
                }
                Ok(None) => crate::winfill::notify(&app, "TKRForm は最新の版です。"),
                Err(e) => crate::winfill::notify(&app, &e.message),
            },
            "m:ext_help" => wins::open_ext_help(&app, &core),
            "m:sync" => {
                let _ = crate::sync::run_once(&core);
            }
            "m:quit" => app.exit(0),
            other => {
                if let Some(item_id) = other.strip_prefix("open:") {
                    open_item(&app, &core, item_id);
                }
            }
        }
    });
}

fn open_item(app: &AppHandle, core: &Arc<Core>, id: &str) {
    let kind = core.with_vault(|v, _| Ok(v.entry(id).map(|e| e.kind))).ok().flatten();
    match kind {
        Some(ItemType::Login) | Some(ItemType::Bookmark) => {
            // 既定ブラウザで URL を開き、拡張に記入を指示する
            if let Err(e) = service::dispatch(core, "fillLogin", json!({ "id": id }), Source::Ui) {
                core.log("tray.open.failed", e.code);
            }
        }
        Some(ItemType::AppLogin) => {
            // 前面にあったアプリへ記入する。失敗は通知する
            if let Err(e) = service::dispatch(core, "fillApp", json!({ "id": id }), Source::Ui) {
                crate::winfill::notify(app, &e.message);
            }
        }
        Some(_) => wins::open_editor(app, core, Some(id)),
        None => {}
    }
}

