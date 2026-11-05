//! tkrform-app: 常駐アプリ（トレイ・エディタ・パスワード生成器・Named Pipe サーバ）。保管庫の唯一の所有者。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clip;
mod commands;
mod hello;
mod msix;
mod passkey;
mod core;
mod locale;
mod service;
mod sync;
mod sys;
mod tray;
mod update;
mod wins;
mod winevents;
mod winfill;

use std::sync::Arc;

use serde_json::json;
use tauri::{Manager, RunEvent};
use tkrform_ipc::pipe::{Conn, Handler, OnConnect, PipeServer};
use tkrform_ipc::proto::{Request, Response};

use crate::core::Core;
use crate::service::Source;

fn start_pipe(core: &Arc<Core>) {
    let c = core.clone();
    let handler: Arc<Handler> = Arc::new(move |req: Request| match service::dispatch(&c, &req.cmd, req.args, Source::Pipe) {
        Ok(data) => Response::ok(req.id, data),
        Err(e) => Response::err(req.id, e.code, &e.message),
    });
    let c2 = core.clone();
    // 接続直後に現在のロック状態を伝える
    let on_connect: Arc<OnConnect> = Arc::new(move |conn: &Conn| {
        let ev = tkrform_ipc::Event::new("lockState", json!({"locked": c2.is_locked()}));
        if let Ok(b) = serde_json::to_vec(&ev) {
            let _ = conn.write_frame(&b);
        }
    });
    match PipeServer::start(handler, Some(on_connect)) {
        Ok(p) => {
            let _ = core.pipe.set(p);
        }
        Err(e) => core.log("pipe.failed", &e.kind().to_string()),
    }
}

fn main() {
    wins::mark_main_thread();
    // --background、または Store 版の自動起動（windows.startupTask）による起動なら、画面を出さずに常駐だけする
    // Store 版は、裏で起動する専用の入口（アプリ ID TKRFormBackground）からも起動される。引数が届かなくても、これで確実に分かる
    let background = std::env::args().any(|a| a == "--background") || msix::started_as_background_app() || msix::started_by_startup_task();
    // 裏で起動されたのに、すでに動いているなら、何もせず終わる（2 つ目の起動を既存の画面に伝えない。伝わると、ログイン画面やエディタが開く）
    if background && !sys::testing() && tkrform_ipc::pipe::connect().is_ok() {
        return;
    }
    let ext_help = std::env::args().any(|a| a == "--ext-help");
    let core = Core::new();

    let core_for_single = core.clone();
    let builder = tauri::Builder::default();
    // テスト中は、利用者の実行中インスタンスと共存できるよう単一インスタンス制御を外す
    let builder = if sys::testing() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(move |app, args, _cwd| {
            // 2 つ目の起動: 既存プロセスで画面を出す（--background なら何もしない）
            if args.iter().any(|a| a == "--background") {
                return;
            }
            if args.iter().any(|a| a == "--ext-help") {
                wins::open_ext_help(app, &core_for_single);
                return;
            }
            if core_for_single.exists() {
                wins::open_editor(app, &core_for_single, None);
            } else {
                wins::open_setup(app, &core_for_single);
            }
        }))
    };
    let result = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(core.clone())
        .invoke_handler(tauri::generate_handler![commands::rpc, commands::get_locale, commands::copy_secret, commands::pick_open, commands::pick_folder, commands::pick_save, commands::close_self, commands::set_on_top, commands::type_to_last])
        .setup({
            let core = core.clone();
            move |app| {
                let handle = app.handle().clone();
                let _ = core.app.set(handle.clone());
                // NM ホストの登録と自動起動の反映（毎回。何度呼んでもよい）
                if let Err(e) = sys::register_native_host(&core.root) {
                    core.log("nm.register.failed", &e);
                }
                let want_autostart = core.prefs().general.start_with_windows;
                if sys::set_autostart(want_autostart) != want_autostart && want_autostart {
                    // Store 版: 利用者が、タスクマネージャーなどで、自動起動を無効にしている。設定の表示を、実際に合わせる
                    let mut p = core.prefs();
                    p.general.start_with_windows = false;
                    let _ = core.set_prefs(p);
                }
                tray::init(&handle, &core)?;
                start_pipe(&core);
                winevents::start(&core);
                sync::start_thread(&core);
                update::start_thread(&core);
                sys::start_foreground_tracker();
                wins::apply_hotkeys(&core);

                if ext_help {
                    // インストーラの「ブラウザ拡張の導入案内を開く」から（初回はセットアップのウィザードにも同じ案内がある）
                    wins::open_ext_help(&handle, &core);
                }
                if !core.exists() {
                    wins::open_setup(&handle, &core);
                } else if !ext_help {
                    // 起動時にマスターパスワードは求めない。ロックしたまま常駐し、保管庫が必要な操作をしたときに求める
                    let unlocked = core.try_device_unlock();
                    // 通知もウィンドウも出さず、ロックしたままトレイに常駐する（自動解除できたときだけエディタを開く）
                    if !background && unlocked {
                        wins::open_editor(&handle, &core, None);
                    }
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            app.run(|app, event| {
                if let RunEvent::ExitRequested { api, code, .. } = event {
                    // 画面をすべて閉じても常駐する。終了はトレイの「終了」から（code が Some）
                    if code.is_none() {
                        api.prevent_exit();
                    } else if let Some(core) = app.try_state::<Arc<Core>>() {
                        core.lock();
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("TKRForm を起動できませんでした: {e}");
            std::process::exit(1);
        }
    }
}
