//! The E.V notch: a small black window over the Mac's notch (or a pill at the top of a Mac
//! without one). It grows only when there's something to show — listening, an answer, an
//! approval, the music card, the drop box, the mini chat — and shrinks back. Like the quick
//! panel it's a non-activating NSPanel, so it never takes you out of the app you're in; it
//! takes the keyboard only while you type in it. Everything it shows comes from the main window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "notch";
/// Over the menu bar (NSMainMenuWindowLevel + 3), like other notch apps.
const LEVEL: isize = 27;

static APP: OnceLock<AppHandle> = OnceLock::new();
static ON: AtomicBool = AtomicBool::new(false);
/// The window's rectangle in screen points, top-left origin (CGEvent coordinates), for hover.
static RECT: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 0.0, 0.0));
static RETURN_TO: Mutex<Option<i32>> = Mutex::new(None);

pub(crate) fn active() -> bool {
    ON.load(Ordering::Relaxed)
}

pub(crate) fn app() -> Option<&'static AppHandle> {
    APP.get()
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Point {
    pub x: f64,
    pub y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Size {
    pub w: f64,
    pub h: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Rect {
    pub origin: Point,
    pub size: Size,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
struct Insets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

mod encode {
    use super::*;
    use objc2::encode::{Encode, Encoding};
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]);
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]);
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }
    unsafe impl Encode for Insets {
        const ENCODING: Encoding = Encoding::Struct("NSEdgeInsets", &[Encoding::Double, Encoding::Double, Encoding::Double, Encoding::Double]);
    }
}

/// The screen the notch is on: the one with a camera notch, else the main (menu bar) screen.
/// Returns (screen frame, notch width, notch height, has notch, primary screen height).
fn screen() -> (Rect, f64, f64, bool, f64) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let Some(class) = AnyClass::get(c"NSScreen") else { return (Rect::default(), 200.0, 32.0, false, 0.0) };
        let screens: *mut AnyObject = msg_send![class, screens];
        let count: usize = if screens.is_null() { 0 } else { msg_send![screens, count] };
        if count == 0 {
            return (Rect::default(), 200.0, 32.0, false, 0.0);
        }
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        let primary_frame: Rect = msg_send![primary, frame];
        for i in 0..count {
            let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let insets: Insets = msg_send![s, safeAreaInsets];
            if insets.top > 0.0 {
                let frame: Rect = msg_send![s, frame];
                let left: Rect = msg_send![s, auxiliaryTopLeftArea];
                let right: Rect = msg_send![s, auxiliaryTopRightArea];
                let width = (frame.size.w - left.size.w - right.size.w).clamp(120.0, 320.0);
                return (frame, width, insets.top, true, primary_frame.size.h);
            }
        }
        let visible: Rect = msg_send![primary, visibleFrame];
        let bar = (primary_frame.size.h - (visible.origin.y + visible.size.h) + primary_frame.origin.y).clamp(22.0, 40.0);
        (primary_frame, 190.0, bar, false, primary_frame.size.h)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    has_notch: bool,
    width: f64,
    height: f64,
}

#[tauri::command]
pub fn notch_geometry() -> Geometry {
    let (_, width, height, has_notch, _) = screen();
    Geometry { has_notch, width, height }
}

fn ensure(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let (_, width, height, _, _) = screen();
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("E.V notch")
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            crate::panel::make_panel(ns_window, LEVEL);
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let w = ns_window as *mut AnyObject;
            let _: () = msg_send![w, setHasShadow: false];
            // Stays put when Spaces change or an app goes full screen.
            const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
            const STATIONARY: usize = 1 << 4;
            const IGNORES_CYCLE: usize = 1 << 6;
            const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
            let _: () = msg_send![w, setCollectionBehavior: CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY];
        }
    }
    place(&window, width, height);
    Ok(window)
}

/// Top center of the notch's screen, `width` × `height` points, growing downward.
/// Over the menu bar: set again after anything that may reset it (showing the window).
fn lift(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        unsafe {
            let _: () = msg_send![ns_window as *mut AnyObject, setLevel: LEVEL];
        }
    }
}

fn place(window: &tauri::WebviewWindow, width: f64, height: f64) {
    lift(window);
    let (frame, _, _, _, primary_h) = screen();
    let x = frame.origin.x + (frame.size.w - width) / 2.0;
    let y = frame.origin.y + frame.size.h - height;
    *RECT.lock().unwrap() = (x, primary_h - (y + height), width, height);
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let rect = Rect { origin: Point { x, y }, size: Size { w: width, h: height } };
        unsafe {
            let _: () = msg_send![ns_window as *mut AnyObject, setFrame: rect, display: true];
        }
    }
}

fn show(app: &AppHandle, on: bool) -> Result<(), String> {
    ON.store(on, Ordering::Relaxed);
    if on {
        let window = ensure(app)?;
        #[cfg(target_os = "macos")]
        if let Ok(ns_window) = window.ns_window() {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            unsafe {
                let _: () = msg_send![ns_window as *mut AnyObject, orderFrontRegardless];
            }
        }
        let _ = window.show();
        // Showing resets the level, and macOS keeps normal windows below the menu bar: put it back.
        let (_, _, w, h) = *RECT.lock().unwrap();
        let (_, nw, nh, _, _) = screen();
        place(&window, if w > 0.0 { w } else { nw }, if h > 0.0 { h } else { nh });
    } else if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
    Ok(())
}

/// Turns the E.V notch on or off (Settings → Notch).
#[tauri::command]
pub fn notch_enable(app: AppHandle, on: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = show(&handle, on);
    })
    .map_err(|e| e.to_string())
}

/// The notch's content changed size: the window follows, staying centered at the top.
#[tauri::command]
pub fn notch_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(LABEL) {
            place(&window, width.clamp(60.0, 900.0), height.clamp(20.0, 700.0));
        }
    })
    .map_err(|e| e.to_string())
}

/// Typing in the notch: it takes the keyboard (without bringing E.V's windows forward); done,
/// you're back in the app you were using.
#[tauri::command]
pub fn notch_keyboard(app: AppHandle, on: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else { return };
        let own = std::process::id() as i32;
        if on {
            if let Some((_, pid)) = crate::mac_control::front_app().filter(|(_, pid)| *pid != own) {
                *RETURN_TO.lock().unwrap() = Some(pid);
            }
            #[cfg(target_os = "macos")]
            if let Ok(ns_window) = window.ns_window() {
                unsafe { crate::panel::take_keyboard(ns_window) };
            }
        } else {
            #[cfg(target_os = "macos")]
            if let Ok(ns_window) = window.ns_window() {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                unsafe {
                    let _: () = msg_send![ns_window as *mut AnyObject, resignKeyWindow];
                }
            }
            let front = crate::mac_control::front_app().map(|(_, pid)| pid);
            if let Some(pid) = RETURN_TO.lock().unwrap().take() {
                if front == Some(own) && pid != own {
                    crate::mac_control::activate_pid(pid);
                }
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// The quick-panel shortcut with the E.V notch on: opens the notch's mini chat to type in.
pub(crate) fn open_chat(app: &AppHandle) {
    let _ = app.emit_to(LABEL, "notch-open-chat", ());
}

/// Shows the main window (the notch's "Open E.V").
#[tauri::command]
pub fn notch_open_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Chat panels off: E.V's main window hides and E.V lives in the notch.
#[tauri::command]
pub fn notch_main_visible(app: AppHandle, visible: bool) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = if visible { main.show() } else { main.hide() };
    }
}

/// Watches the pointer (10 times a second, only while the notch is on) and tells the notch
/// when it's over it. A non-activating window doesn't get hover events reliably on its own.
pub fn start(app: AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::spawn(move || {
        let mut inside = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(if active() { 100 } else { 600 }));
            if !active() {
                inside = false;
                continue;
            }
            let Some(point) = pointer() else { continue };
            let (x, y, w, h) = *RECT.lock().unwrap();
            // A few points of slack below, so moving down into the card doesn't flicker it.
            let now = point.0 >= x && point.0 <= x + w && point.1 >= y - 2.0 && point.1 <= y + h + 6.0;
            if now != inside {
                inside = now;
                let _ = app.emit_to(LABEL, "notch-hover", inside);
            }
        }
    });
}

fn pointer() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let location = CGEvent::new(source).ok()?.location();
    Some((location.x, location.y))
}

/// Drags files out of the drop box into Finder or any app (called on mouse-down in the notch).
#[tauri::command]
pub fn notch_drag_out(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = handle
            .get_webview_window(LABEL)
            .ok_or_else(|| "The notch isn't open.".to_string())
            .and_then(|w| w.ns_window().map_err(|e| e.to_string()))
            .and_then(|ns| unsafe { begin_drag(ns, &paths) });
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
unsafe fn begin_drag(ns_window: *mut std::ffi::c_void, paths: &[String]) -> Result<(), String> {
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};

    static SOURCE: OnceLock<usize> = OnceLock::new();
    let source_class = *SOURCE.get_or_init(|| {
        let Some(object) = AnyClass::get(c"NSObject") else { return 0 };
        let Some(mut builder) = ClassBuilder::new(c"EVDragSource", object) else {
            return AnyClass::get(c"EVDragSource").map_or(0, |c| c as *const AnyClass as usize);
        };
        extern "C-unwind" fn mask(_: &AnyObject, _: Sel, _session: *mut AnyObject, _context: isize) -> usize {
            // Copy, Link, Generic, Move: Finder moves on the same disk, apps copy — like any file.
            1 | 2 | 4 | 16
        }
        builder.add_method(sel!(draggingSession:sourceOperationMaskForDraggingContext:), mask as extern "C-unwind" fn(_, _, _, _) -> _);
        builder.register() as *const AnyClass as usize
    });
    if source_class == 0 {
        return Err("Dragging isn't available.".into());
    }
    let class = |name: &std::ffi::CStr| AnyClass::get(name).ok_or_else(|| format!("{name:?} missing"));
    let window = ns_window as *mut AnyObject;
    let view: *mut AnyObject = msg_send![window, contentView];
    let ns_app: *mut AnyObject = msg_send![class(c"NSApplication")?, sharedApplication];
    let event: *mut AnyObject = msg_send![ns_app, currentEvent];
    if view.is_null() || event.is_null() {
        return Err("Start the drag again.".into());
    }
    let in_window: Point = msg_send![event, locationInWindow];
    let null: *mut AnyObject = std::ptr::null_mut();
    let at: Point = msg_send![view, convertPoint: in_window, fromView: null];
    let items: *mut AnyObject = msg_send![class(c"NSMutableArray")?, array];
    let workspace: *mut AnyObject = msg_send![class(c"NSWorkspace")?, sharedWorkspace];
    for (i, path) in paths.iter().enumerate() {
        let Ok(c_path) = std::ffi::CString::new(path.as_str()) else { continue };
        let ns_path: *mut AnyObject = msg_send![class(c"NSString")?, stringWithUTF8String: c_path.as_ptr()];
        let url: *mut AnyObject = msg_send![class(c"NSURL")?, fileURLWithPath: ns_path];
        let item: *mut AnyObject = msg_send![class(c"NSDraggingItem")?, alloc];
        let item: *mut AnyObject = msg_send![item, initWithPasteboardWriter: url];
        let icon: *mut AnyObject = msg_send![workspace, iconForFile: ns_path];
        let offset = (i.min(4) as f64) * 4.0;
        let frame = Rect { origin: Point { x: at.x - 24.0 + offset, y: at.y - 24.0 - offset }, size: Size { w: 48.0, h: 48.0 } };
        let _: () = msg_send![item, setDraggingFrame: frame, contents: icon];
        let _: () = msg_send![items, addObject: item];
        let _: () = msg_send![item, release];
    }
    let count: usize = msg_send![items, count];
    if count == 0 {
        return Err("Nothing to drag.".into());
    }
    let source: *mut AnyObject = msg_send![AnyClass::get(c"EVDragSource").ok_or("no drag source")?, new];
    let _: *mut AnyObject = msg_send![view, beginDraggingSessionWithItems: items, event: event, source: source];
    Ok(())
}

#[cfg(not(target_os = "macos"))]
unsafe fn begin_drag(_: *mut std::ffi::c_void, _: &[String]) -> Result<(), String> {
    Err("Dragging out works on macOS only.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_the_notch() {
        // The real Mac: debug builds check every AppKit call's types, so this catches mistakes.
        let (frame, width, height, has_notch, primary) = super::screen();
        println!("screen {frame:?} notch {width}×{height} has_notch={has_notch} primary_h={primary}");
        assert!(width > 0.0 && height > 0.0);
    }
}
