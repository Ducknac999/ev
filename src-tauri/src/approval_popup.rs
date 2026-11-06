//! The approval popup: a small window at the top right of the screen, over any app, so a waiting
//! approval can be answered without opening E.V. It shows without making E.V the front app; if a
//! click on it brings E.V forward, the app the user was in is put back afterwards.

use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "approve";
const WIDTH: f64 = 400.0;

/// The app that was in front when the popup appeared (not E.V itself).
static RETURN_TO: Mutex<Option<i32>> = Mutex::new(None);

fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("E.V approval")
        .inner_size(WIDTH, 120.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Top-right corner of the main screen, under the menu bar.
fn place(app: &AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let x = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size().to_logical::<f64>(m.scale_factor());
            let pos = m.position().to_logical::<f64>(m.scale_factor());
            pos.x + size.width - WIDTH - 14.0
        })
        .unwrap_or(900.0);
    let _ = window.set_size(tauri::LogicalSize::new(WIDTH, height));
    let _ = window.set_position(tauri::LogicalPosition::new(x, 40.0));
}

/// Shows the popup at `height` (it grows with the number of waiting approvals), or hides it.
#[tauri::command]
pub fn approval_popup(app: AppHandle, show: bool, height: Option<f64>) -> Result<(), String> {
    if show {
        ensure(&app)?;
        place(&app, height.unwrap_or(120.0).clamp(90.0, 560.0));
        let own = std::process::id() as i32;
        if let Some((_, pid)) = crate::mac_control::front_app().filter(|(_, pid)| *pid != own) {
            *RETURN_TO.lock().unwrap() = Some(pid);
        }
        crate::ptt::order(&app, LABEL, true);
    } else {
        crate::ptt::order(&app, LABEL, false);
    }
    Ok(())
}

/// After an answer clicked in the popup: if that click brought E.V forward, put the user's app back.
#[tauri::command]
pub fn approval_popup_return() {
    let own = std::process::id() as i32;
    let front = crate::mac_control::front_app().map(|(_, pid)| pid);
    if let (Some(pid), Some(front)) = (*RETURN_TO.lock().unwrap(), front) {
        if front == own && pid != own {
            crate::mac_control::activate_pid(pid);
        }
    }
}
