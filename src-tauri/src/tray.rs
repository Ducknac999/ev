//! E.V's menu-bar icon (near Wi-Fi and volume): copy the last dictation, or one of the recent ones,
//! open E.V, quit. The list comes from the main window (services/dictation.ts).

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};

const ID: &str = "ev-tray";
static ITEMS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn short(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 48 {
        format!("{}…", one_line.chars().take(47).collect::<String>())
    } else {
        one_line
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let items = ITEMS.lock().unwrap().clone();
    let copy_last = MenuItem::with_id(app, "copy:0", "Copy last dictation", !items.is_empty(), None::<&str>)?;
    let recent = Submenu::with_id(app, "recent", "Recent dictations", !items.is_empty())?;
    for (i, text) in items.iter().enumerate() {
        recent.append(&MenuItem::with_id(app, format!("copy:{i}"), short(text), true, None::<&str>)?)?;
    }
    let open = MenuItem::with_id(app, "open", "Open E.V", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit E.V completely", true, None::<&str>)?;
    Menu::with_items(app, &[&copy_last, &recent, &PredefinedMenuItem::separator(app)?, &open, &quit])
}

fn copy(text: &str) {
    use std::io::Write;
    if let Ok(mut child) = std::process::Command::new("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(ID).menu(&menu(app)?).show_menu_on_left_click(true).tooltip("E.V");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(index) = id.strip_prefix("copy:").and_then(|i| i.parse::<usize>().ok()) {
                if let Some(text) = ITEMS.lock().unwrap().get(index).cloned() {
                    copy(&text);
                }
            } else if id == "open" {
                crate::app_mode::show_main(app);
            } else if id == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

/// The latest dictations (newest first) for the menu.
#[tauri::command]
pub fn tray_dictations(app: AppHandle, items: Vec<String>) {
    *ITEMS.lock().unwrap() = items.into_iter().take(5).collect();
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(ID), menu(&app)) {
        let _ = tray.set_menu(Some(menu));
    }
}
