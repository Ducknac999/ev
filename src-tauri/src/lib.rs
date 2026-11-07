mod onboard;
mod calendar;
mod migrate;
mod agent_tools;
mod approval_popup;
mod attachments;
mod bg;
mod browser_search;
mod claude;
mod control;
mod doc;
mod external;
mod http;
mod live;
mod gideon_browser;
mod mac_control;
mod mcp;
mod passphrase;
mod notch;
mod notch_window;
mod caffeine;
mod files;
mod lyrics;
mod router;
mod panel;
mod playing;
mod pty;
mod ptt;
mod settings;
mod shadow;
mod shell_env;
mod speech;
mod tasks;
mod vault;
mod voice_engine;
mod workspace;

use std::sync::Arc;
use tasks::TaskRegistry;

/// `gideon --check-permissions <file>`: writes what macOS reports for E.V's own privacy
/// permissions (launched via `open -n` so the check runs as E.V, not as a terminal).
pub fn check_permissions_and_exit() {
    let mut args = std::env::args();
    if args.any(|a| a == "--check-permissions") {
        let out = args.next().unwrap_or_else(|| "/tmp/gideon-permissions.txt".into());
        let report = format!(
            "accessibility={}\nscreen={}\nexe={}\n",
            mac_control::accessibility_granted(),
            mac_control::screen_granted(),
            std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
        );
        let _ = std::fs::write(out, report);
        std::process::exit(0);
    }
}

/// `gideon --check-background <app> <file>`: starts E.V normally, then reads an app's window
/// the background way and records what happened (read-only diagnostic), and quits.
fn background_check_request() -> Option<(String, String)> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--check-background")?;
    Some((
        args.get(i + 1).cloned().unwrap_or_else(|| "Discord".into()),
        args.get(i + 2).cloned().unwrap_or_else(|| "/tmp/gideon-background.txt".into()),
    ))
}

pub fn check_background_and_exit() {}

/// `gideon --notch-look <dir>` (diagnostic): what the notch shows when hovered.
pub fn notch_look_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--notch-look") {
        mac_control::notch_look(args.get(i + 1).map(String::as_str).unwrap_or("/tmp"));
        std::process::exit(0);
    }
    if let Some(i) = args.iter().position(|a| a == "--notch-press") {
        let result = mac_control::notch_press(args.get(i + 1).map(String::as_str).unwrap_or(""));
        let _ = std::fs::write("/tmp/notch-press.txt", result);
        std::process::exit(0);
    }
}

/// `gideon --read-document <path> [pages]` and `gideon --make-document <out> <format> <html file>`
/// print the same JSON the agent tools return (the test bench drives the real reader with these).
pub fn documents_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    let print = |value: Result<serde_json::Value, String>| {
        match value {
            Ok(v) => println!("{v}"),
            Err(e) => println!("{}", serde_json::json!({ "error": e })),
        }
        gideon_browser::stop();
        std::process::exit(0);
    };
    if let Some(i) = args.iter().position(|a| a == "--read-document") {
        let path = std::path::PathBuf::from(args.get(i + 1).cloned().unwrap_or_default());
        print(doc::read_document(&path, args.get(i + 2).map(String::as_str).filter(|p| !p.is_empty()), true).map(|d| serde_json::to_value(d).unwrap_or_default()));
    }
    if let Some(i) = args.iter().position(|a| a == "--make-document") {
        let out = std::path::PathBuf::from(args.get(i + 1).cloned().unwrap_or_default());
        let format = args.get(i + 2).cloned().unwrap_or_else(|| "pdf".into());
        let html = std::fs::read_to_string(args.get(i + 3).cloned().unwrap_or_default()).map_err(|e| e.to_string());
        print(html.and_then(|h| doc::make_document(&out, &format, &h, false, "letter")).map(|d| serde_json::to_value(d).unwrap_or_default()));
    }
}

pub fn voice_serve_and_exit() {
    voice_engine::serve_and_exit();
}

/// `gideon --print-memory` (used by Claude Code's SessionStart hook) prints and exits.
pub fn print_memory_and_exit() -> bool {
    if std::env::args().any(|a| a == "--print-memory") {
        std::process::exit(vault::print_memory());
    }
    false
}

pub fn run() {
    shell_env::hydrate_path();
    migrate::run_if_requested();
    let ptys = Arc::new(pty::PtyRegistry::default());
    let ptys_on_exit = ptys.clone();

    tauri::Builder::default()
        .manage(TaskRegistry::default())
        .manage(ptys)
        .manage(control::ControlState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CommandOrControl+Shift+Escape")
                .expect("emergency stop shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        use tauri::Emitter;
                        let _ = app.emit("emergency-stop", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            if let Some((target, out)) = background_check_request() {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = std::fs::write(out, mac_control::background_report(&target));
                    std::process::exit(0);
                });
                return Ok(());
            }
            gideon_browser::set_app(app.handle().clone());
            control::start(app.handle().clone());
            notch_window::start(app.handle().clone());
            caffeine::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_tools::tool_read_file,
            agent_tools::tool_write_file,
            agent_tools::tool_edit_file,
            agent_tools::tool_list_directory,
            agent_tools::tool_find_files,
            agent_tools::tool_search_files,
            agent_tools::tool_run_command,
            agent_tools::tool_web_fetch,
            agent_tools::tool_web_search,
            agent_tools::live_fetch_json,
            agent_tools::tool_cancel,
            bg::tool_bg_start,
            bg::tool_bg_read,
            bg::tool_bg_stop,
            bg::tool_bg_list,
            doc::tool_read_document,
            doc::tool_make_document,
            doc::tool_discard_preview,
            attachments::attachment_save,
            attachments::attachment_read,
            attachments::attachment_open,
            attachments::attachment_delete,
            attachments::attachment_root,
            attachments::read_dropped_file,
            claude::claude_status,
            claude::claude_usage,
            control::control_meta,
            control::control_created,
            http::provider_stream,
            live::live_prepare,
            live::live_turn,
            live::live_cancel,
            http::provider_cancel,
            http::deepseek_balance,
            onboard::onboard_tools,
            onboard::onboard_install,
            onboard::provider_models,
            onboard::onboard_permissions,
            onboard::onboard_request_microphone,
            onboard::onboard_request_automation,
            onboard::update_releases,
            calendar::calendar_sync,
            migrate::move_from_personal_available,
            migrate::move_from_personal,
            external::open_external,
            mcp::connections_catalog,
            mcp::connection_start,
            mcp::connection_stop,
            mcp::connection_call,
            mcp::connection_set_secret,
            mcp::connection_forget_secrets,
            gideon_browser::gb_status,
            gideon_browser::gb_open,
            gideon_browser::gb_look,
            gideon_browser::gb_do,
            gideon_browser::gb_show,
            gideon_browser::gb_close_tab,
            gideon_browser::gb_desmos,
            gideon_browser::gb_signin,
            gideon_browser::gb_quit,
            gideon_browser::gb_tabs,
            gideon_browser::gb_new_tab,
            gideon_browser::gb_view,
            gideon_browser::gb_view_stop,
            gideon_browser::gb_mouse,
            gideon_browser::gb_key,
            gideon_browser::gb_insert_text,
            gideon_browser::gb_navigate,
            gideon_browser::gb_selection,
            gideon_browser::gb_share,
            mac_control::mac_front,
            mac_control::mac_permissions,
            mac_control::mac_request_permission,
            mac_control::mac_look,
            mac_control::mac_click,
            mac_control::mac_drag,
            mac_control::mac_menu,
            mac_control::mac_tabs,
            mac_control::mac_default_browser,
            ptt::ptt_configure,
            ptt::approval_keys_configure,
            ptt::approval_keys_active,
            notch::notch_request,
            notch::notch_withdraw,
            notch::notch_message,
            notch::notch_answer,
            notch_window::notch_geometry,
            notch_window::notch_enable,
            notch_window::notch_resize,
            notch_window::notch_keyboard,
            notch_window::notch_open_main,
            notch_window::notch_main_visible,
            notch_window::notch_drag_out,
            caffeine::caffeine_set,
            caffeine::caffeine_status,
            caffeine::caffeine_remove_permission,
            files::find_my_files,
            files::file_open,
            files::files_exist,
            lyrics::lyrics,
            lyrics::lyrics_clear,
            router::route_request,
            router::route_prewarm,
            playing::now_playing_info,
            playing::audio_playing,
            playing::media_now,
            playing::media_pause,
            playing::media_resume,
            approval_popup::approval_popup,
            approval_popup::approval_popup_return,
            panel::panel_show,
            panel::panel_visible,
            ptt::panel_configure,
            mac_control::mac_type,
            mac_control::mac_key,
            mac_control::mac_scroll,
            mac_control::mac_media,
            mac_control::mac_screen,
            mac_control::mac_user_idle,
            mac_control::mac_open,
            mac_control::mac_applescript,
            mac_control::mac_shortcut,
            mac_control::mac_quit,
            mac_control::mac_clipboard,
            mac_control::mac_system,
            passphrase::passphrase_status,
            passphrase::passphrase_set,
            passphrase::passphrase_clear,
            passphrase::passphrase_check,
            passphrase::passphrase_matches,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_signal,
            pty::pty_kill,
            pty::pty_alive,
            pty::pty_log,
            pty::pty_stats,
            shadow::workspace_clone,
            shadow::workspace_changes,
            shadow::workspace_apply,
            shadow::workspace_discard,
            settings::load_settings,
            settings::save_settings,
            speech::tts_synthesize,
            speech::tts_voices,
            speech::stt_transcribe,
            speech::stt_status,
            voice_engine::voice_frame_cmd,
            voice_engine::vad_reset,
            voice_engine::voice_engine_status,
            voice_engine::voice_engine_warm,
            voice_engine::voice_models_download,
            vault::vault_load,
            vault::vault_save,
            vault::show_notification,
            workspace::pick_folder,
            workspace::pick_save_path,
            workspace::save_text_file,
            workspace::claude_sessions,
            workspace::claude_latest_session,
            workspace::agent_context,
            workspace::load_skill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building E.V")
        .run(move |app, event| {
            // The Dock icon brings E.V's window back (also when chat panels are off).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            if let tauri::RunEvent::Exit = event {
                ptys_on_exit.kill_all();
                mcp::stop_all();
                bg::stop_all();
                gideon_browser::stop();
                control::release_socket();
                caffeine::stop(app);
            }
        });
}
