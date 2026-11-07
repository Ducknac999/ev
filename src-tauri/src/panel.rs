//! The quick panel: a small E.V chat window at the top of the screen, opened from any app with
//! its shortcut (watched by the hold-to-talk key tap in ptt.rs). It shows one E.V chat at a time;
//! the chat itself still runs in the main window, which sends the panel what to show.
//! Hiding it puts the user back in the app they were using.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "panel";
const WIDTH: f64 = 520.0;
const HEIGHT: f64 = 380.0;

/// The app that was in front when the panel opened (not E.V itself).
static RETURN_TO: Mutex<Option<i32>> = Mutex::new(None);

fn ensure(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("E.V")
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(380.0, 220.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .shadow(true)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        unsafe { make_floating_panel(ns_window) };
    }
    // First time: top center of the main screen, just under the menu bar and notch. Later the
    // panel window restores where the user left it.
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let pos = monitor.position().to_logical::<f64>(monitor.scale_factor());
        let _ = window.set_position(tauri::LogicalPosition::new(pos.x + (size.width - WIDTH) / 2.0, pos.y + 44.0));
    }
    Ok(window)
}

pub(crate) fn visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// Shows (and focuses, for typing) or hides the panel. Hiding returns to the app the user was in.
pub(crate) fn show(app: &AppHandle, on: bool) -> Result<(), String> {
    if on {
        let own = std::process::id() as i32;
        if let Some((_, pid)) = crate::mac_control::front_app().filter(|(_, pid)| *pid != own) {
            *RETURN_TO.lock().unwrap() = Some(pid);
        }
        let window = ensure(app)?;
        window.show().map_err(|e| e.to_string())?;
        // Not window.set_focus(): that activates E.V, which macOS refuses from another app and
        // which would drag the main window (or its full-screen Space) forward. The panel takes
        // the keyboard on its own, like Spotlight.
        #[cfg(target_os = "macos")]
        if let Ok(ns_window) = window.ns_window() {
            unsafe { take_keyboard(ns_window) };
        }
    } else if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
        let own = std::process::id() as i32;
        let front = crate::mac_control::front_app().map(|(_, pid)| pid);
        if let Some(pid) = RETURN_TO.lock().unwrap().take() {
            if front == Some(own) && pid != own {
                crate::mac_control::activate_pid(pid);
            }
        }
    }
    let _ = app.emit("panel-visible", on);
    Ok(())
}

/// Turns tao's window into a non-activating NSPanel: it can show over any app, full-screen ones
/// included, and take typing without making E.V the active app. NSPanel adds no instance
/// variables to NSWindow (both 520 bytes on macOS 26), so tao's own window state, stored after
/// them, stays where tao expects it.
#[cfg(target_os = "macos")]
unsafe fn make_floating_panel(ns_window: *mut std::ffi::c_void) {
    make_panel(ns_window, 3);
}

/// `level`: 3 floats over apps (the quick panel); 27 sits over the menu bar (the notch).
#[cfg(target_os = "macos")]
pub(crate) unsafe fn make_panel(ns_window: *mut std::ffi::c_void, level: isize) {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use std::sync::OnceLock;

    static CLASS: OnceLock<usize> = OnceLock::new();
    let class = *CLASS.get_or_init(|| {
        let Some(panel) = AnyClass::get(c"NSPanel") else { return 0 };
        let Some(mut builder) = ClassBuilder::new(c"EVQuickPanel", panel) else {
            return AnyClass::get(c"EVQuickPanel").map_or(0, |c| c as *const AnyClass as usize);
        };
        extern "C-unwind" fn yes(_: &AnyObject, _: Sel) -> Bool {
            Bool::YES
        }
        extern "C-unwind" fn no(_: &AnyObject, _: Sel) -> Bool {
            Bool::NO
        }
        builder.add_method(sel!(canBecomeKeyWindow), yes as extern "C-unwind" fn(_, _) -> _);
        builder.add_method(sel!(canBecomeMainWindow), no as extern "C-unwind" fn(_, _) -> _);
        builder.register() as *const AnyClass as usize
    });
    if class == 0 || ns_window.is_null() {
        return;
    }
    let window = ns_window as *mut AnyObject;
    objc2::ffi::object_setClass(window, class as *const AnyClass);

    const NONACTIVATING_PANEL: usize = 1 << 7;
    let mask: usize = msg_send![window, styleMask];
    let _: () = msg_send![window, setStyleMask: mask | NONACTIVATING_PANEL];

    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const IGNORES_CYCLE: usize = 1 << 6;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    let _: () = msg_send![window, setCollectionBehavior: CAN_JOIN_ALL_SPACES | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY];

    let _: () = msg_send![window, setLevel: level];
    let _: () = msg_send![window, setFloatingPanel: true];
    let _: () = msg_send![window, setHidesOnDeactivate: false];
    let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: false];
}

#[cfg(target_os = "macos")]
pub(crate) unsafe fn take_keyboard(ns_window: *mut std::ffi::c_void) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let window = ns_window as *mut AnyObject;
    let _: () = msg_send![window, orderFrontRegardless];
    let _: () = msg_send![window, makeKeyWindow];
}

/// The panel shortcut was pressed: open it, or close it if it's open.
pub(crate) fn toggle(app: &AppHandle) {
    // With the E.V notch on, the shortcut opens its mini chat instead.
    if crate::notch_window::active() {
        crate::notch_window::open_chat(app);
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let _ = show(&app, !visible(&app));
    });
}

#[tauri::command]
pub fn panel_show(app: AppHandle, show: bool) -> Result<(), String> {
    // Window class and AppKit calls must happen on the main thread.
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = self::show(&handle, show);
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn panel_visible(app: AppHandle) -> bool {
    visible(&app)
}
