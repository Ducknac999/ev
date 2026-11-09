//! Closing and quitting E.V without losing the notch:
//! - ⌘W or the window's close button: the window hides and E.V leaves the Dock and ⌘Tab;
//!   everything keeps running (chats, Talk mode, reminders, the notch).
//! - ⌘Q: the same, and the main window stops answering chats and Talk mode (it says so first);
//!   the notch, clipboard, dictation, music and ☕ stay. Settings → General can make ⌘Q quit.
//! - "Quit E.V completely" (the notch's power button, the menu-bar icon): quits.
//! Only E.V's own ⌘Q is changed: logging out, shutting down and other apps asking E.V to quit
//! still quit it at once.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// ⌘Q keeps the notch running (Settings → General); only while the E.V notch is on.
static KEEP_NOTCH: AtomicBool = AtomicBool::new(true);
const QUIT_ID: &str = "ev-quit";

/// Brings E.V's window back, with its Dock icon and place in ⌘Tab.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Hides E.V's window and takes it out of the Dock and ⌘Tab; E.V keeps running in the notch.
pub(crate) fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Whether hiding keeps something useful running: the E.V notch.
fn notch_stays<R: Runtime>(_app: &AppHandle<R>) -> bool {
    crate::notch_window::active()
}

/// ⌘Q: hide to the notch (and tell the main window to stop chats and Talk mode), or quit.
fn quit_pressed<R: Runtime>(app: &AppHandle<R>) {
    if KEEP_NOTCH.load(Ordering::Relaxed) && notch_stays(app) {
        let _ = app.emit_to("main", "app-quit-to-notch", ());
        hide_main(app);
    } else {
        app.exit(0);
    }
}

/// The standard Mac menu with E.V's own Quit item (⌘Q) in place of the system one.
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Some(first) = menu.items()?.into_iter().next() {
        if let Some(app_menu) = first.as_submenu() {
            replace_quit(app, app_menu)?;
        }
    }
    Ok(menu)
}

fn replace_quit<R: Runtime>(app: &AppHandle<R>, app_menu: &Submenu<R>) -> tauri::Result<()> {
    let items = app_menu.items()?;
    let Some(position) = items.iter().position(|item| item.as_predefined_menuitem().and_then(|p| p.text().ok()).is_some_and(|t| t.starts_with("Quit"))) else {
        return Ok(());
    };
    app_menu.remove(&items[position])?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit E.V", true, Some("CmdOrCtrl+Q"))?;
    app_menu.insert(&quit, position)?;
    Ok(())
}

pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == QUIT_ID {
        quit_pressed(app);
    }
}

/// The main window's close button and ⌘W: hide instead of closing (the notch needs it alive).
pub fn on_close_requested<R: Runtime>(window: &tauri::Window<R>, api: &tauri::CloseRequestApi) {
    if window.label() != "main" {
        return;
    }
    api.prevent_close();
    hide_main(window.app_handle());
}

/// Settings → General: whether ⌘Q keeps the notch running.
#[tauri::command]
pub fn app_quit_mode(keep_notch: bool) {
    KEEP_NOTCH.store(keep_notch, Ordering::Relaxed);
}

/// The notch's power button and the menu-bar icon: quits E.V, notch and all.
#[tauri::command]
pub fn app_quit_all(app: AppHandle) {
    app.exit(0);
}

/// "Open E.V at login" (macOS's Login Items). `enable`: None asks, Some turns it on or off.
/// Returns whether it's on now.
#[tauri::command]
pub fn app_login_item(enable: Option<bool>) -> Result<bool, String> {
    type Fn = unsafe extern "C" fn(i32) -> i32;
    static F: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let f = *F.get_or_init(|| {
        let Some(path) = crate::doc::lib_path() else { return 0 };
        let Ok(c_path) = std::ffi::CString::new(path.display().to_string()) else { return 0 };
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return 0;
        }
        unsafe { libc::dlsym(handle, c"ev_login_item".as_ptr()) as usize }
    });
    if f == 0 {
        return Err("E.V's helper is missing — reinstall E.V".into());
    }
    let arg = match enable {
        None => -1,
        Some(true) => 1,
        Some(false) => 0,
    };
    let result = unsafe { std::mem::transmute::<usize, Fn>(f)(arg) };
    if result < 0 {
        return Err("macOS didn't allow it — check System Settings → General → Login Items".into());
    }
    Ok(result == 1)
}
