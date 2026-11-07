//! Controls the Mac the way a person would: opens apps, reads a window's controls through the
//! Accessibility API, looks at it (screenshot), clicks, types, presses keys and scrolls.
//!
//! Safety is enforced here, not left to the AI: every click and key press first inspects the
//! control it would hit. Final actions (Send, Submit, Delete, Enter in a message box…) are refused
//! unless the frontend passes an approval, and money or password controls are always refused.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGSize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::Duration;

mod hands;

type AXUIElementRef = CFTypeRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementCopyElementAtPosition(app: AXUIElementRef, x: f32, y: f32, element: *mut AXUIElementRef) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> i32;
    fn _AXUIElementGetWindow(element: AXUIElementRef, window: *mut u32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventPost(tap: u32, event: *mut c_void);
    fn CGEventCreateScrollWheelEvent(source: *const c_void, units: u32, count: u32, wheel1: i32, ...) -> *mut c_void;
    fn CFRelease(cf: *const c_void);
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGWarpMouseCursorPosition(point: CGPoint) -> i32;
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, text: *const u16);
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPostToPid(pid: i32, event: *mut c_void);
}

const AX_VALUE_POINT: u32 = 1;
const AX_VALUE_SIZE: u32 = 2;

// ── Accessibility helpers ─────────────────────────────────────────────────────

#[derive(Clone)]
struct Element(CFType);

// AX elements are plain CF objects; retaining, releasing and messaging them from any thread is safe.
unsafe impl Send for Element {}

impl Element {
    fn wrap(raw: CFTypeRef) -> Option<Element> {
        (!raw.is_null()).then(|| Element(unsafe { CFType::wrap_under_create_rule(raw) }))
    }

    fn app(pid: i32) -> Option<Element> {
        let el = Element::wrap(unsafe { AXUIElementCreateApplication(pid) })?;
        unsafe { AXUIElementSetMessagingTimeout(el.raw(), 2.0) };
        Some(el)
    }

    fn raw(&self) -> CFTypeRef {
        self.0.as_CFTypeRef()
    }

    fn attr(&self, name: &str) -> Option<CFType> {
        let key = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.raw(), key.as_concrete_TypeRef(), &mut value) };
        (err == 0 && !value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }

    fn string(&self, name: &str) -> String {
        self.attr(name).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default()
    }

    /// A link's web address (AXURL), so it can be opened in a new tab instead of clicked.
    fn url(&self) -> String {
        self.attr("AXURL").and_then(|v| v.downcast::<core_foundation::url::CFURL>()).map(|u| u.get_string().to_string()).unwrap_or_default()
    }

    fn bool(&self, name: &str) -> Option<bool> {
        self.attr(name).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from)
    }

    fn element(&self, name: &str) -> Option<Element> {
        self.attr(name).map(Element)
    }

    fn children(&self) -> Vec<Element> {
        self.attr("AXChildren")
            .and_then(|v| v.downcast::<CFArray>())
            .map(|arr| arr.iter().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) })).collect())
            .unwrap_or_default()
    }

    /// Performs an accessibility action (e.g. "AXPress") without touching the mouse.
    fn perform(&self, action: &str) -> bool {
        let key = CFString::new(action);
        unsafe { AXUIElementPerformAction(self.raw(), key.as_concrete_TypeRef()) == 0 }
    }

    fn set_string(&self, name: &str, value: &str) -> bool {
        let key = CFString::new(name);
        let v = CFString::new(value);
        unsafe { AXUIElementSetAttributeValue(self.raw(), key.as_concrete_TypeRef(), v.as_CFTypeRef()) == 0 }
    }

    fn window_id(&self) -> Option<u32> {
        let mut id = 0u32;
        (unsafe { _AXUIElementGetWindow(self.raw(), &mut id) } == 0 && id != 0).then_some(id)
    }

    fn set_bool(&self, name: &str, value: bool) {
        let key = CFString::new(name);
        let v = if value { CFBoolean::true_value() } else { CFBoolean::false_value() };
        unsafe { AXUIElementSetAttributeValue(self.raw(), key.as_concrete_TypeRef(), v.as_CFTypeRef()) };
    }

    fn frame(&self) -> Option<(f64, f64, f64, f64)> {
        let mut point = CGPoint::new(0.0, 0.0);
        let mut size = CGSize::new(0.0, 0.0);
        let pos = self.attr("AXPosition")?;
        let sz = self.attr("AXSize")?;
        let ok = unsafe {
            AXValueGetValue(pos.as_CFTypeRef(), AX_VALUE_POINT, &mut point as *mut CGPoint as *mut c_void)
                && AXValueGetValue(sz.as_CFTypeRef(), AX_VALUE_SIZE, &mut size as *mut CGSize as *mut c_void)
        };
        ok.then_some((point.x, point.y, size.width, size.height))
    }

    /// The words a person would read on this control.
    fn label(&self) -> String {
        let mut parts = Vec::new();
        for key in ["AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXHelp"] {
            let text = self.string(key);
            let text = text.trim();
            if !text.is_empty() && !parts.iter().any(|p: &String| p == text) {
                parts.push(text.chars().take(120).collect());
            }
        }
        if parts.is_empty() {
            if let Some(title) = self.element("AXTitleUIElement") {
                parts.push(title.string("AXValue"));
            }
        }
        parts.join(" · ")
    }
}

pub fn accessibility_granted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

pub fn screen_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

// ── Apps ──────────────────────────────────────────────────────────────────────

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(program).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub(crate) fn front_app() -> Option<(String, i32)> {
    let asn = run("/usr/bin/lsappinfo", &["front"]).ok()?;
    let info = run("/usr/bin/lsappinfo", &["info", "-only", "name,pid", &asn]).ok()?;
    let name = info.lines().find_map(|l| l.split_once("\"LSDisplayName\"=").map(|(_, v)| v.trim_matches('"').to_string()))?;
    let pid = info.lines().find_map(|l| l.split_once("\"pid\"=").and_then(|(_, v)| v.trim().parse().ok()))?;
    Some((name, pid))
}

fn activate(app: &str) -> Result<(), String> {
    run("/usr/bin/open", &["-a", app]).map(|_| ()).map_err(|e| format!("couldn't open {app}: {e}"))
}

/// Electron and Chromium apps only build their accessibility tree when asked.
fn wake_accessibility(app: &Element) {
    app.set_bool("AXManualAccessibility", true);
    app.set_bool("AXEnhancedUserInterface", true);
}

// ── Looking at a window ───────────────────────────────────────────────────────

#[cfg(test)]
mod browser_guard_tests {
    use super::*;

    #[test]
    fn developer_tools_are_never_opened_in_browsers() {
        let m = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(opens_devtools("Vivaldi", "j", &m(&["command", "option"])));
        assert!(opens_devtools("Google Chrome", "i", &m(&["cmd", "alt"])));
        assert!(opens_devtools("Safari", "F12", &[]));
        assert!(!opens_devtools("Vivaldi", "t", &m(&["command"])));
        assert!(!opens_devtools("Discord", "i", &m(&["command", "option"])));
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: usize,
    pub role: String,
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub focused: bool,
    /// Links: where they go (http/https only).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// Off-screen controls: which way they are ("below", "above", "left", "right"); empty when visible.
    /// Clicking one scrolls it into view first.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub place: String,
}

/// Off-screen controls a look lists at most (on top of everything visible), so long pages stay readable.
const MAX_OFFSCREEN: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub app: String,
    pub window: String,
    pub frame: (f64, f64, f64, f64),
    /// JPEG of the window, base64 (empty when Screen Recording isn't allowed).
    pub image: String,
    pub controls: Vec<Control>,
    pub note: String,
}

const ACTIONABLE: &[&str] = &[
    "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXLink", "AXMenuItem", "AXMenuButton", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXTab", "AXRow", "AXCell", "AXDisclosureTriangle", "AXSlider",
    "AXIncrementor", "AXStaticText", "AXImage", "AXHeading",
];

/// What the last look at an app found, so the AI can click "#12" — kept as live accessibility
/// elements, so clicks and typing can happen in the background.
struct Seen {
    pid: i32,
    controls: Vec<(Control, Element)>,
}

static LAST_SEEN: Mutex<Option<HashMap<String, Seen>>> = Mutex::new(None);

fn remember(app: &str, pid: i32, found: Vec<(Control, Element)>) {
    LAST_SEEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(app.to_lowercase(), Seen { pid, controls: found });
}

fn seen_control(app: &str, id: usize) -> Option<(i32, Control, Element)> {
    let cache = LAST_SEEN.lock().unwrap();
    let seen = cache.as_ref()?.get(&app.to_lowercase())?;
    let (control, element) = seen.controls.iter().find(|(c, _)| c.id == id)?;
    Some((seen.pid, control.clone(), element.clone()))
}

fn collect(el: &Element, out: &mut Vec<(Control, Element)>, depth: usize, bounds: (f64, f64, f64, f64)) {
    if depth > 40 || out.len() >= 400 + MAX_OFFSCREEN {
        return;
    }
    let role = el.string("AXRole");
    if ACTIONABLE.contains(&role.as_str()) {
        if let Some((x, y, w, h)) = el.frame() {
            let visible = w > 1.0 && h > 1.0 && x + w > bounds.0 && y + h > bounds.1 && x < bounds.0 + bounds.2 && y < bounds.1 + bounds.3;
            let label = el.label();
            // Plain text only matters when it says something; images only when labelled.
            let worth = !matches!(role.as_str(), "AXStaticText" | "AXImage" | "AXHeading" | "AXCell" | "AXRow") || !label.is_empty();
            // Off-screen controls count too (a page's lower rows, a long list): "see everything",
            // so the AI never decides something isn't there because it was below the fold.
            let place = if visible {
                ""
            } else if y >= bounds.1 + bounds.3 {
                "below"
            } else if y + h <= bounds.1 {
                "above"
            } else if x >= bounds.0 + bounds.2 {
                "right"
            } else {
                "left"
            };
            let room = if visible { out.iter().filter(|(c, _)| c.place.is_empty()).count() < 400 } else { out.iter().filter(|(c, _)| !c.place.is_empty()).count() < MAX_OFFSCREEN };
            if w > 1.0 && h > 1.0 && worth && room {
                let control = Control {
                    id: out.len() + 1,
                    role: role.trim_start_matches("AX").to_string(),
                    label,
                    x: x.round(),
                    y: y.round(),
                    w: w.round(),
                    h: h.round(),
                    focused: el.bool("AXFocused").unwrap_or(false),
                    url: if role == "AXLink" { Some(el.url()).filter(|u| u.starts_with("http")).unwrap_or_default() } else { String::new() },
                    place: place.to_string(),
                };
                out.push((control, el.clone()));
            }
        }
    }
    for child in el.children() {
        collect(&child, out, depth + 1, bounds);
    }
}

fn resource(name: &str) -> Option<std::path::PathBuf> {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("../Resources").join(name))).filter(|p| p.exists())
}

type CaptureFn = unsafe extern "C" fn(u32, *const std::ffi::c_char, f64) -> *mut std::ffi::c_char;
type FreeFn = unsafe extern "C" fn(*mut std::ffi::c_char);

/// ScreenCaptureKit loaded into E.V's own process, so it runs under E.V's Screen Recording
/// permission (a separate helper program may not be covered by it).
fn capture_lib() -> Option<(CaptureFn, FreeFn)> {
    static LIB: std::sync::OnceLock<Option<(usize, usize)>> = std::sync::OnceLock::new();
    let (capture, free) = (*LIB.get_or_init(|| {
        let path = resource("libgideoncapture.dylib")?;
        let c_path = std::ffi::CString::new(path.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return None;
        }
        let capture = unsafe { libc::dlsym(handle, c"gideon_capture_window".as_ptr()) };
        let free = unsafe { libc::dlsym(handle, c"gideon_free_string".as_ptr()) };
        (!capture.is_null() && !free.is_null()).then_some((capture as usize, free as usize))
    }))?;
    Some(unsafe { (std::mem::transmute::<usize, CaptureFn>(capture), std::mem::transmute::<usize, FreeFn>(free)) })
}

fn inprocess_capture(window: u32, out: &str) -> Result<String, String> {
    let (capture, free) = capture_lib().ok_or("capture library missing")?;
    let c_out = std::ffi::CString::new(out).map_err(|e| e.to_string())?;
    let error = unsafe { capture(window, c_out.as_ptr(), 1400.0) };
    if error.is_null() {
        return Ok(String::new());
    }
    let message = unsafe { std::ffi::CStr::from_ptr(error) }.to_string_lossy().into_owned();
    unsafe { free(error) };
    Err(message)
}

/// Picture of one window — by its id, so it works while the window sits behind others.
fn capture(window: Option<u32>, frame: (f64, f64, f64, f64), in_front: bool) -> String {
    if !screen_granted() {
        return String::new();
    }
    let path = std::env::temp_dir().join(format!("gideon-look-{}.jpg", std::process::id()));
    let p = path.to_str().unwrap_or_default();
    let window_shot = window.map(|id| {
        inprocess_capture(id, p).or_else(|_| run("/usr/sbin/screencapture", &["-x", "-o", "-t", "jpg", "-l", &id.to_string(), p]))
    });
    let shot = match window_shot {
        Some(Ok(done)) => Ok(done),
        // A picture of a screen area shows whatever is on top there — only the right app when it's in front.
        _ if in_front => {
            let region = format!("{},{},{},{}", frame.0 as i64, frame.1 as i64, frame.2 as i64, frame.3 as i64);
            run("/usr/sbin/screencapture", &["-x", "-o", "-t", "jpg", "-R", &region, p])
        }
        _ => Err("no background picture".into()),
    };
    let ok = shot.is_ok() && run("/usr/bin/sips", &["-Z", "1400", "-s", "formatOptions", "70", p]).is_ok();
    let data = if ok { std::fs::read(&path).ok() } else { None };
    // The picture is only ever kept in memory for this one request.
    let _ = std::fs::remove_file(&path);
    data.map(|d| base64_encode(&d)).unwrap_or_default()
}

pub(crate) fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The copy of each app E.V is working in (by name, lowercased). Two copies of one app can run
/// at once (a second install, a build folder); a job keeps to the one it started with.
static WORKING_IN: Mutex<Option<HashMap<String, i32>>> = Mutex::new(None);

fn app_key(app: &str) -> String {
    app.trim().trim_end_matches(".app").to_lowercase()
}

pub(crate) fn note_pid(app: &str, pid: i32) {
    WORKING_IN.lock().unwrap().get_or_insert_with(HashMap::new).insert(app_key(app), pid);
}

/// Still running as an app (a pid can be reused by something else once the app quits).
fn alive(pid: i32) -> bool {
    pid > 0 && running_apps().iter().any(|(_, p)| *p == pid)
}

pub(crate) fn pid_of(app: &str) -> Option<i32> {
    if is_vivaldi(app) {
        crate::gideon_browser::step_aside();
    }
    let kept = WORKING_IN.lock().unwrap().as_ref().and_then(|m| m.get(&app_key(app)).copied());
    if let Some(pid) = kept.filter(|&p| alive(p)) {
        return Some(pid);
    }
    let pid = find_pid(app)?;
    note_pid(app, pid);
    Some(pid)
}

fn find_pid(app: &str) -> Option<i32> {
    let out = run("/usr/bin/lsappinfo", &["info", "-only", "pid", app]).unwrap_or_default();
    if let Some(pid) = out.split('=').nth(1).and_then(|p| p.trim().parse().ok()).filter(|p: &i32| *p > 0) {
        return Some(pid);
    }
    // Two apps with the same name (e.g. the E.V Browser beside the user's Vivaldi): lsappinfo
    // won't choose, so pick the user's one ourselves.
    running_apps().into_iter().find(|(name, pid)| name.eq_ignore_ascii_case(app.trim_end_matches(".app")) && Some(*pid) != crate::gideon_browser::own_pid()).map(|(_, pid)| pid)
}

fn is_vivaldi(app: &str) -> bool {
    app.to_lowercase().contains("vivaldi")
}

/// Every running app with a name, as macOS lists them.
fn running_apps() -> Vec<(String, i32)> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let mut out = Vec::new();
    let Some(class) = AnyClass::get(c"NSWorkspace") else { return out };
    unsafe {
        let ws: *mut AnyObject = msg_send![class, sharedWorkspace];
        let apps: *mut AnyObject = msg_send![ws, runningApplications];
        if apps.is_null() {
            return out;
        }
        let count: usize = msg_send![apps, count];
        for i in 0..count {
            let app: *mut AnyObject = msg_send![apps, objectAtIndex: i];
            let name: *mut AnyObject = msg_send![app, localizedName];
            let pid: i32 = msg_send![app, processIdentifier];
            if name.is_null() {
                continue;
            }
            let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
            if !utf8.is_null() {
                out.push((std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned(), pid));
            }
        }
    }
    out
}

/// Where a running app was started from (its .app bundle).
fn bundle_path_of(pid: i32) -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let class = AnyClass::get(c"NSRunningApplication")?;
        let app: *mut AnyObject = msg_send![class, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return None;
        }
        let url: *mut AnyObject = msg_send![app, bundleURL];
        if url.is_null() {
            return None;
        }
        let path: *mut AnyObject = msg_send![url, path];
        if path.is_null() {
            return None;
        }
        let utf8: *const std::ffi::c_char = msg_send![path, UTF8String];
        (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}

/// Which copy of an app to start when it isn't running: the one in Applications, else the one
/// used most recently. Err when several copies exist and nothing says which one the user means.
fn copy_to_launch(app: &str) -> Result<Option<String>, String> {
    if app.contains('/') {
        return Ok(None);
    }
    let squash = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = squash(app.trim_end_matches(".app"));
    let found = run("/usr/bin/mdfind", &["kMDItemContentType == 'com.apple.application-bundle'"]).unwrap_or_default();
    let copies: Vec<String> = found
        .lines()
        .map(str::trim)
        .filter(|p| p.ends_with(".app") && !p.trim_end_matches(".app").contains(".app/") && !p.contains("/.Trash/"))
        .filter(|p| p.rsplit('/').next().map(|name| squash(name.trim_end_matches(".app")) == want).unwrap_or(false))
        .map(String::from)
        .collect();
    if copies.len() <= 1 {
        return Ok(copies.into_iter().next());
    }
    if let Some(installed) = copies.iter().find(|p| p.starts_with("/Applications/") || p.starts_with("/System/Applications/")) {
        return Ok(Some(installed.clone()));
    }
    let used = |p: &str| run("/usr/bin/mdls", &["-raw", "-name", "kMDItemLastUsedDate", p]).ok().filter(|d| !d.trim().is_empty() && d.trim() != "(null)");
    let mut dated: Vec<(String, String)> = copies.iter().filter_map(|p| used(p).map(|d| (d.trim().to_string(), p.clone()))).collect();
    dated.sort();
    if let Some((_, latest)) = dated.pop() {
        return Ok(Some(latest));
    }
    Err(format!("there are {} copies of {app} on this Mac and none is in Applications: {} — ask the user which one to open", copies.len(), copies.join(" · ")))
}

/// Starts an app (the right copy of it) and returns its pid once it's up.
fn launch(app: &str, background: bool, target: Option<&str>) -> Result<Option<i32>, String> {
    let path = copy_to_launch(app)?;
    let mut args: Vec<String> = Vec::new();
    if background {
        args.push("-g".into());
    }
    args.extend(["-a".to_string(), path.clone().unwrap_or_else(|| app.to_string())]);
    if let Some(t) = target {
        args.push(t.to_string());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_timed("/usr/bin/open", &refs, 20)?;
    for _ in 0..40 {
        let started = match &path {
            Some(p) => running_apps().into_iter().map(|(_, pid)| pid).find(|&pid| bundle_path_of(pid).as_deref() == Some(p.as_str())),
            None => find_pid(app),
        };
        if let Some(pid) = started {
            note_pid(app, pid);
            return Ok(Some(pid));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(None)
}

/// Brings one specific app (by process) forward.
pub(crate) fn activate_pid(pid: i32) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(class) = AnyClass::get(c"NSRunningApplication") else { return };
    let app: *mut AnyObject = unsafe { msg_send![class, runningApplicationWithProcessIdentifier: pid] };
    if !app.is_null() {
        let _: bool = unsafe { msg_send![app, activateWithOptions: 1usize] };
    }
}

const BROWSERS: &[&str] = &["vivaldi", "chrome", "safari", "arc", "brave", "edge", "firefox", "opera", "chromium"];

fn is_browser(app: &str) -> bool {
    let a = app.to_lowercase();
    BROWSERS.iter().any(|b| a.contains(b))
}

const DEVTOOLS_REFUSAL: &str = "NEVER:devtools — E.V never opens developer tools or runs code inside your browser. Read the page with mac_look instead.";

/// ⌥⌘I / ⌥⌘J / ⌥⌘C / ⌥⌘U / F12 in a browser: developer tools, the console or page source.
fn opens_devtools(app: &str, key: &str, modifiers: &[String]) -> bool {
    let has = |m: &str| modifiers.iter().any(|x| x.eq_ignore_ascii_case(m) || (m == "command" && x.eq_ignore_ascii_case("cmd")) || (m == "option" && x.eq_ignore_ascii_case("alt")));
    let k = key.to_lowercase();
    is_browser(app) && (k == "f12" || (has("command") && has("option") && ["i", "j", "c", "u"].contains(&k.as_str())))
}

/// The app's pid, starting it hidden (in the background) if it isn't running.
fn background_pid(app: &str) -> Result<i32, String> {
    if let Some(pid) = pid_of(app) {
        return Ok(pid);
    }
    if let Some(pid) = launch(app, true, None).map_err(|e| format!("couldn't open {app}: {e}"))? {
        return Ok(pid);
    }
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(pid) = pid_of(app) {
            return Ok(pid);
        }
    }
    Err(format!("{app} didn't start"))
}

fn main_window(app_el: &Element) -> Option<Element> {
    app_el
        .element("AXFocusedWindow")
        .or_else(|| app_el.element("AXMainWindow"))
        .or_else(|| app_el.attr("AXWindows").and_then(|v| v.downcast::<CFArray>()).and_then(|a| a.iter().next().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) }))))
}

/// Reads an app's window without bringing it to the front: its controls, plus a picture when
/// asked for (or when there are no readable controls to go on).
pub fn look(app: Option<&str>, picture: bool) -> Result<Look, String> {
    if !accessibility_granted() {
        return Err("PERMISSION:accessibility".into());
    }
    let (name, pid) = match app.map(str::trim).filter(|a| !a.is_empty()) {
        Some(name) => (name.to_string(), background_pid(name)?),
        None => front_app().ok_or("couldn't tell which app is in front")?,
    };
    let app_el = Element::app(pid).ok_or("couldn't reach that app")?;
    wake_accessibility(&app_el);
    let mut window = main_window(&app_el);
    for _ in 0..12 {
        if window.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
        window = main_window(&app_el);
    }
    let window = window.ok_or_else(|| format!("{name} has no open window"))?;
    let frame = window.frame().ok_or("couldn't read the window's position")?;
    let mut found = Vec::new();
    collect(&window, &mut found, 0, frame);
    if found.len() < 3 {
        // Electron apps fill their tree a moment after being asked.
        std::thread::sleep(Duration::from_millis(600));
        found.clear();
        collect(&window, &mut found, 0, frame);
    }
    let controls: Vec<Control> = found.iter().map(|(c, _)| c.clone()).collect();
    remember(&name, pid, found);
    let offscreen = controls.iter().filter(|c| !c.place.is_empty()).count();
    let want_picture = picture || controls.len() < 3;
    let in_front = front_app().is_some_and(|(_, front)| front == pid);
    let image = if want_picture { capture(window.window_id(), frame, in_front) } else { String::new() };
    // No note when there's no picture: mac_look's description already says pictures are on request.
    let note = if !want_picture {
        String::new()
    } else if !image.is_empty() {
        String::new()
    } else if screen_granted() {
        "No picture in the background (the window is probably on another desktop or behind a full-screen app). The controls above are complete; if you really need to see it, call mac_look again with use_screen=true.".into()
    } else {
        "No picture: Screen Recording permission isn't granted, so only the control list is available.".into()
    };
    // A page longer than the list: say so, so "it isn't there" is never decided from part of it.
    let note = if offscreen >= MAX_OFFSCREEN {
        [note, "PARTIAL: the page goes on past this list. Scroll (mac_scroll) and look again, or look with find, before deciding something isn't there.".to_string()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")
    } else {
        note
    };
    Ok(Look { app: name, window: window.string("AXTitle"), frame, image, controls, note })
}

// ── Borrowing the screen (only when the background can't do it) ─────────────

/// Seconds since the user last touched the keyboard, mouse or trackpad.
pub fn user_idle_seconds() -> f64 {
    // HID system state, any input event type.
    unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) }
}

/// Brings `app` forward for one step, then puts the user's app and mouse back where they were.
fn borrow<T>(app: &str, step: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let before = front_app();
    let mouse = source().ok().and_then(|s| CGEvent::new(s).ok()).map(|e| e.location());
    activate(app)?;
    std::thread::sleep(Duration::from_millis(350));
    let result = step();
    std::thread::sleep(Duration::from_millis(150));
    if let Some((name, _)) = before.filter(|(name, _)| !name.eq_ignore_ascii_case(app)) {
        let _ = activate(&name);
    }
    if let Some(point) = mouse {
        unsafe { CGWarpMouseCursorPosition(point) };
    }
    result
}

/// One key event delivered straight to an app, without bringing it forward.
fn post_key_to(pid: i32, code: u16, down: bool, flags: u64, text: Option<&str>) -> Result<(), String> {
    let ev = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
    if ev.is_null() {
        return Err("key event failed".into());
    }
    unsafe {
        if let Some(text) = text {
            let units: Vec<u16> = text.encode_utf16().collect();
            CGEventKeyboardSetUnicodeString(ev, units.len(), units.as_ptr());
        }
        CGEventSetFlags(ev, flags);
        CGEventPostToPid(pid, ev);
        CFRelease(ev);
    }
    std::thread::sleep(Duration::from_millis(8));
    Ok(())
}

/// Sends a key straight to one app (background), without bringing it forward.
fn press_to(pid: i32, key: &str, modifiers: &[String]) -> Result<(), String> {
    let code = key_code(key).ok_or_else(|| format!("unknown key \"{key}\""))?;
    let flags = modifier_flags(modifiers)?.bits();
    post_key_to(pid, code, true, flags, None)?;
    post_key_to(pid, code, false, flags, None)
}

fn type_to(pid: i32, text: &str) -> Result<(), String> {
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            press_to(pid, "return", &["shift".into()])?;
        }
        let chars: Vec<char> = line.chars().collect();
        for chunk in chars.chunks(16) {
            let s: String = chunk.iter().collect();
            post_key_to(pid, 0, true, 0, Some(&s))?;
            post_key_to(pid, 0, false, 0, Some(&s))?;
        }
    }
    Ok(())
}

// ── Safety checks ─────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Safe to do while preparing.
    Ok,
    /// Can't be taken back: needs the user's approval with a preview.
    Final,
    /// Money or passwords: never.
    Never,
}

pub(crate) fn words(text: &str) -> String {
    format!(" {} ", text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>())
}

pub(crate) fn has_any(text: &str, list: &[&str]) -> bool {
    let w = words(text);
    list.iter().any(|k| w.contains(&format!(" {k} ")))
}

pub(crate) const MONEY_WORDS: &[&str] = &[
    "pay", "pay now", "buy", "buy now", "purchase", "place order", "place your order", "checkout", "check out", "proceed to checkout",
    "add to cart", "add to bag", "subscribe", "upgrade", "donate", "transfer", "send money", "withdraw", "deposit", "card number",
    "cvv", "cvc", "security code", "expiration", "expiry", "iban", "routing number", "account number", "apple pay", "google pay", "paypal",
];
const FINAL_WORDS: &[&str] = &[
    "send", "send now", "post", "publish", "submit", "tweet", "delete", "remove", "trash", "move to trash", "erase",
    "uninstall", "install", "confirm", "ok", "yes", "accept", "agree", "sign", "apply", "save", "replace", "overwrite", "discard",
    "leave", "block", "report", "unfriend", "unfollow", "archive", "empty trash", "restart", "shut down", "log out", "sign out",
];

// What a click can't take back is judged by its consequence, not by one word on the button:
// it reaches other people, destroys something, or changes the whole Mac. Plain confirmations
// ("OK", "Save", "Apply") only count inside a dialog or sheet, where they answer a question that
// may overwrite, send or delete.
const REACHES_PEOPLE: &[&str] = &["send", "send now", "post", "publish", "submit", "tweet", "leave", "block", "report", "unfriend", "unfollow"];
const DESTROYS: &[&str] = &["delete", "remove", "trash", "move to trash", "erase", "discard", "empty trash", "overwrite", "replace", "archive"];
const WHOLE_MAC: &[&str] = &["install", "uninstall", "restart", "shut down", "log out", "sign out"];
const CONFIRMS: &[&str] = &["confirm", "ok", "yes", "accept", "agree", "sign", "apply", "save", "continue", "don t save"];
/// The user's own lists: adding to or taking out of them is undone with one more click.
const OWN_COLLECTIONS: &[&str] = &[
    "playlist", "playlists", "library", "queue", "up next", "liked", "liked songs", "likes", "favorites", "favourites", "favorite", "favourite",
    "bookmarks", "bookmark", "watch later", "reading list", "collection", "saved", "wishlist", "watchlist", "starred", "pins", "pinned",
];
const WIPES: &[&str] = &["delete", "erase", "trash", "permanently"];

/// What clicking a control with this role and label would do.
pub fn click_verdict(role: &str, label: &str) -> Verdict {
    click_verdict_in(role, label, false)
}

/// The same, knowing whether the control sits in a dialog or sheet.
pub fn click_verdict_in(role: &str, label: &str, in_dialog: bool) -> Verdict {
    if has_any(label, MONEY_WORDS) {
        return Verdict::Never;
    }
    let pressable = matches!(role, "AXButton" | "Button" | "AXMenuItem" | "MenuItem" | "AXLink" | "Link" | "AXImage" | "Image" | "");
    if !pressable {
        return Verdict::Ok;
    }
    let w = words(label);
    let own_list = has_any(label, OWN_COLLECTIONS) && (w.contains(" to ") || w.contains(" from ") || w.starts_with(" add ") || w.starts_with(" save "));
    if own_list && !has_any(label, WIPES) {
        return Verdict::Ok;
    }
    if has_any(label, REACHES_PEOPLE) || has_any(label, DESTROYS) || has_any(label, WHOLE_MAC) {
        return Verdict::Final;
    }
    if in_dialog && has_any(label, CONFIRMS) {
        return Verdict::Final;
    }
    Verdict::Ok
}

/// Inside a dialog, alert or sheet (where "OK" and "Save" answer a question).
fn in_dialog(el: &Element) -> bool {
    let mut current = el.element("AXParent");
    for _ in 0..40 {
        let Some(node) = current else { return false };
        let role = node.string("AXRole");
        let subrole = node.string("AXSubrole");
        if role == "AXSheet" || matches!(subrole.as_str(), "AXDialog" | "AXSystemDialog") || role == "AXDialog" {
            return true;
        }
        if role == "AXWindow" || role == "AXApplication" {
            return false;
        }
        current = node.element("AXParent");
    }
    false
}

fn is_password_field(el: &Element) -> bool {
    el.string("AXSubrole") == "AXSecureTextField" || el.string("AXRole") == "AXSecureTextField"
}

fn focused_element() -> Option<Element> {
    let system = Element::wrap(unsafe { AXUIElementCreateSystemWide() })?;
    system.element("AXFocusedUIElement")
}

/// A text box where Enter searches or navigates rather than sending.
fn is_search_box(el: &Element) -> bool {
    let role = el.string("AXRole");
    let subrole = el.string("AXSubrole");
    role == "AXSearchField" || subrole == "AXSearchField" || has_any(&el.label(), &["search", "find", "where would you like to go", "go to", "filter", "address and search bar", "url"])
}

fn typing_verdict_for(el: &Element, text: &str) -> Verdict {
    if is_password_field(el) || has_any(&el.label(), &["password", "passcode", "one time code", "verification code", "2fa"]) || has_any(&el.label(), MONEY_WORDS) {
        return Verdict::Never;
    }
    typing_verdict_for_text(text)
}

fn typing_verdict_for_text(text: &str) -> Verdict {
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    let card_like = text.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') && (13..=19).contains(&digits.len());
    if card_like {
        return Verdict::Never;
    }
    Verdict::Ok
}

/// The same judgement for a known focused control (e.g. inside a background app).
fn key_verdict_for(focus: Option<&Element>, key: &str, modifiers: &[String]) -> Verdict {
    let enter = matches!(key.to_lowercase().as_str(), "return" | "enter");
    let shifted = modifiers.iter().any(|m| m.eq_ignore_ascii_case("shift"));
    if !enter || shifted {
        let delete = matches!(key.to_lowercase().as_str(), "delete" | "backspace" | "forwarddelete");
        if delete && modifiers.iter().any(|m| m.eq_ignore_ascii_case("command") || m.eq_ignore_ascii_case("cmd")) {
            return Verdict::Final;
        }
        return Verdict::Ok;
    }
    match focus {
        Some(el) if is_password_field(el) => Verdict::Never,
        Some(el) if is_search_box(&el) => Verdict::Ok,
        // Enter in any other text box sends or submits; unknown focus is treated the same way.
        Some(el) if matches!(el.string("AXRole").as_str(), "AXTextArea" | "AXTextField" | "AXComboBox" | "AXWebArea") => Verdict::Final,
        Some(el) if has_any(&el.label(), FINAL_WORDS) => Verdict::Final,
        Some(_) => Verdict::Final,
        None => Verdict::Final,
    }
}

// ── Doing things ──────────────────────────────────────────────────────────────

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "couldn't create input events".to_string())
}

fn post(event: CGEvent) {
    event.post(CGEventTapLocation::HID);
    std::thread::sleep(Duration::from_millis(8));
}

/// The control under a screen point: (role, label).
pub fn control_at(x: f64, y: f64) -> (String, String) {
    let (role, label, _) = control_at_in(x, y);
    (role, label)
}

/// The control under a screen point: (role, label, inside a dialog or sheet).
pub fn control_at_in(x: f64, y: f64) -> (String, String, bool) {
    let Some(system) = Element::wrap(unsafe { AXUIElementCreateSystemWide() }) else { return Default::default() };
    let mut raw: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(system.raw(), x as f32, y as f32, &mut raw) };
    let Some(mut el) = (err == 0).then(|| Element::wrap(raw)).flatten() else { return Default::default() };
    // Text inside a button belongs to the button.
    for _ in 0..3 {
        let role = el.string("AXRole");
        if matches!(role.as_str(), "AXButton" | "AXLink" | "AXMenuItem" | "AXCheckBox" | "AXTextField" | "AXTextArea") {
            break;
        }
        match el.element("AXParent") {
            Some(parent) if matches!(parent.string("AXRole").as_str(), "AXButton" | "AXLink" | "AXMenuItem") => el = parent,
            _ => break,
        }
    }
    let dialog = in_dialog(&el);
    (el.string("AXRole"), el.label(), dialog)
}

pub fn click(x: f64, y: f64, double: bool, right: bool) -> Result<(), String> {
    let src = source()?;
    let point = CGPoint::new(x, y);
    let (down, up, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };
    let mv = CGEvent::new_mouse_event(src.clone(), CGEventType::MouseMoved, point, button).map_err(|_| "mouse event failed")?;
    post(mv);
    for n in 1..=(if double { 2 } else { 1 }) {
        let d = CGEvent::new_mouse_event(src.clone(), down, point, button).map_err(|_| "mouse event failed")?;
        d.set_integer_value_field(core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE, n);
        post(d);
        let u = CGEvent::new_mouse_event(src.clone(), up, point, button).map_err(|_| "mouse event failed")?;
        u.set_integer_value_field(core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE, n);
        post(u);
    }
    Ok(())
}

pub(crate) fn key_code(key: &str) -> Option<CGKeyCode> {
    let k = key.to_lowercase();
    let code = match k.as_str() {
        "return" | "enter" => 36, "tab" => 48, "space" => 49, "delete" | "backspace" => 51, "escape" | "esc" => 53,
        "forwarddelete" => 117, "left" => 123, "right" => 124, "down" => 125, "up" => 126, "home" => 115, "end" => 119,
        "pageup" => 116, "pagedown" => 121, "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96,
        "f6" => 97, "f7" => 98, "f8" => 100, "f9" => 101, "f10" => 109, "f11" => 103, "f12" => 111,
        "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7, "c" => 8, "v" => 9, "b" => 11,
        "q" => 12, "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "1" => 18, "2" => 19, "3" => 20, "4" => 21,
        "6" => 22, "5" => 23, "=" => 24, "9" => 25, "7" => 26, "-" => 27, "8" => 28, "0" => 29, "]" => 30, "o" => 31,
        "u" => 32, "[" => 33, "i" => 34, "p" => 35, "l" => 37, "j" => 38, "'" => 39, "k" => 40, ";" => 41, "\\" => 42,
        "," => 43, "/" => 44, "n" => 45, "m" => 46, "." => 47, "`" => 50,
        _ => return None,
    };
    Some(code)
}

fn modifier_flags(modifiers: &[String]) -> Result<CGEventFlags, String> {
    let mut flags = CGEventFlags::empty();
    for m in modifiers {
        flags |= match m.to_lowercase().as_str() {
            "command" | "cmd" => CGEventFlags::CGEventFlagCommand,
            "shift" => CGEventFlags::CGEventFlagShift,
            "option" | "alt" => CGEventFlags::CGEventFlagAlternate,
            "control" | "ctrl" => CGEventFlags::CGEventFlagControl,
            "fn" => CGEventFlags::CGEventFlagSecondaryFn,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
    }
    Ok(flags)
}

pub fn press(key: &str, modifiers: &[String]) -> Result<(), String> {
    let code = key_code(key).ok_or_else(|| format!("unknown key \"{key}\""))?;
    let mut flags = CGEventFlags::empty();
    for m in modifiers {
        flags |= match m.to_lowercase().as_str() {
            "command" | "cmd" => CGEventFlags::CGEventFlagCommand,
            "shift" => CGEventFlags::CGEventFlagShift,
            "option" | "alt" => CGEventFlags::CGEventFlagAlternate,
            "control" | "ctrl" => CGEventFlags::CGEventFlagControl,
            "fn" => CGEventFlags::CGEventFlagSecondaryFn,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
    }
    let src = source()?;
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(src.clone(), code, down).map_err(|_| "key event failed")?;
        ev.set_flags(flags);
        post(ev);
    }
    Ok(())
}

/// Types text as keystrokes; a newline becomes Shift+Return so a draft never sends itself.
pub fn type_text(text: &str) -> Result<(), String> {
    let src = source()?;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            press("return", &["shift".into()])?;
        }
        let chars: Vec<char> = line.chars().collect();
        for chunk in chars.chunks(16) {
            let s: String = chunk.iter().collect();
            for down in [true, false] {
                let ev = CGEvent::new_keyboard_event(src.clone(), 0, down).map_err(|_| "key event failed")?;
                ev.set_string(&s);
                post(ev);
            }
        }
    }
    Ok(())
}

pub fn scroll(x: Option<f64>, y: Option<f64>, dx: i32, dy: i32) -> Result<(), String> {
    let src = source()?;
    if let (Some(x), Some(y)) = (x, y) {
        let mv = CGEvent::new_mouse_event(src.clone(), CGEventType::MouseMoved, CGPoint::new(x, y), CGMouseButton::Left).map_err(|_| "mouse event failed")?;
        post(mv);
    }
    drop(src);
    // Line units (1); two wheels: vertical then horizontal.
    let ev = unsafe { CGEventCreateScrollWheelEvent(std::ptr::null(), 1, 2, -dy, -dx) };
    if ev.is_null() {
        return Err("scroll event failed".into());
    }
    unsafe {
        CGEventPost(0, ev);
        CFRelease(ev);
    }
    Ok(())
}

/// Media keys (play/pause, next, previous) the way the keyboard sends them, so they work for any
/// player — Music, Spotify or YouTube Music in a browser.
pub fn media_key(key: &str) -> Result<(), String> {
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let code: isize = match key {
        "playpause" => 16,
        "next" => 17,
        "previous" => 18,
        _ => return Err(format!("unknown media key {key}")),
    };
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]);
    }
    #[repr(C)]
    struct CgEvent {
        _private: [u8; 0],
    }
    unsafe impl RefEncode for CgEvent {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__CGEvent", &[]));
    }
    let class = AnyClass::get(c"NSEvent").ok_or("AppKit isn't available")?;
    for down in [true, false] {
        let flags: usize = if down { 0xa00 } else { 0xb00 };
        let data1: isize = (code << 16) | if down { 0xa << 8 } else { 0xb << 8 };
        let event: *mut AnyObject = unsafe {
            msg_send![class, otherEventWithType: 14usize, location: Point { x: 0.0, y: 0.0 }, modifierFlags: flags, timestamp: 0.0f64, windowNumber: 0isize, context: std::ptr::null::<AnyObject>(), subtype: 8i16, data1: data1, data2: -1isize]
        };
        if event.is_null() {
            return Err("couldn't create the media key event".into());
        }
        let cg: *mut CgEvent = unsafe { msg_send![event, CGEvent] };
        unsafe { CGEventPost(0, cg as *mut c_void) };
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

// ── Permissions ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: bool,
    pub screen: bool,
}

#[tauri::command]
pub fn mac_permissions() -> Permissions {
    Permissions { accessibility: accessibility_granted(), screen: screen_granted() }
}

/// Shows macOS's own permission prompt and opens the matching System Settings page.
#[tauri::command]
pub fn mac_request_permission(kind: String) {
    // A switch turned on for an older build of E.V doesn't count for this one; clearing
    // E.V's own stale entry lets macOS add a fresh one that matches.
    let service = if kind == "screen" { "ScreenCapture" } else { "Accessibility" };
    let granted = if kind == "screen" { screen_granted() } else { accessibility_granted() };
    if !granted {
        let _ = run("/usr/bin/tccutil", &["reset", service, "com.ducknac.ev"]);
    }
    match kind.as_str() {
        "accessibility" => {
            let key = CFString::new("AXTrustedCheckOptionPrompt");
            let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
            unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef()) };
            let _ = run("/usr/bin/open", &["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
        }
        "screen" => {
            unsafe { CGRequestScreenCaptureAccess() };
            let _ = run("/usr/bin/open", &["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
        }
        _ => {}
    }
}

// ── Commands for the agent tools ──────────────────────────────────────────────

/// Looks at an app in the background; with `use_screen`, brings it over for a moment to take the
/// picture (for windows on another desktop), then puts the user's app back.
#[tauri::command]
pub async fn mac_look(app: Option<String>, use_screen: Option<bool>, picture: Option<bool>) -> Result<Look, String> {
    let picture = picture.unwrap_or(false) || use_screen.unwrap_or(false);
    tokio::task::spawn_blocking(move || match (app.as_deref(), use_screen.unwrap_or(false)) {
        (Some(name), true) if !name.trim().is_empty() => borrow(name, || look(Some(name), true)),
        _ => look(app.as_deref(), picture),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickRequest {
    pub app: String,
    pub id: Option<usize>,
    /// Click the control with this label (read fresh), instead of an id from the last look.
    pub label: Option<String>,
    pub role: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub double: Option<bool>,
    pub right: Option<bool>,
    /// Set only after the user approved this exact final action.
    pub approved: Option<bool>,
    /// Allowed to bring the app forward for this step (after the background way didn't work).
    pub use_screen: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub verdict: Verdict,
    pub done: bool,
    /// What the control said, e.g. "Button · Send".
    pub target: String,
    /// Screen point that was (or would be) clicked, so an approved retry hits the same spot.
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// "background" (the user's screen untouched), "screen" (borrowed briefly), or "" when not done.
    pub mode: String,
    /// The background way didn't work; this step needs the screen for a moment.
    pub needs_screen: bool,
    /// What the window showed afterwards: true changed, false nothing changed, None not checked.
    pub changed: Option<bool>,
    /// The change in words (new controls with their current numbers, a sheet, "nothing changed").
    pub report: String,
}

fn result(verdict: Verdict, done: bool, target: String, mode: &str) -> ActionResult {
    ActionResult { verdict, done, target, x: None, y: None, mode: mode.into(), needs_screen: false, changed: None, report: String::new() }
}

fn needs_screen(verdict: Verdict, target: String) -> ActionResult {
    ActionResult { verdict, done: false, target, x: None, y: None, mode: String::new(), needs_screen: true, changed: None, report: String::new() }
}

impl ActionResult {
    fn checked(mut self, change: hands::Change) -> Self {
        self.changed = change.changed;
        self.report = change.report;
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Front {
    pub app: String,
    pub window: String,
    /// Text the user has highlighted in that app, if any.
    pub selected: String,
}

/// What the user is looking at right now: the front app, its window title and any highlighted text.
#[tauri::command]
pub async fn mac_front() -> Result<Front, String> {
    tokio::task::spawn_blocking(|| {
        let (app, pid) = front_app().ok_or("couldn't tell which app is in front")?;
        if !accessibility_granted() {
            return Ok(Front { app, window: String::new(), selected: String::new() });
        }
        let app_el = Element::app(pid).ok_or("couldn't reach that app")?;
        wake_accessibility(&app_el);
        let window = main_window(&app_el).map(|w| w.string("AXTitle")).unwrap_or_default();
        let selected = app_el.element("AXFocusedUIElement").map(|e| e.string("AXSelectedText")).unwrap_or_default();
        Ok(Front { app, window, selected: selected.chars().take(4000).collect() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mac_user_idle() -> f64 {
    user_idle_seconds()
}

#[tauri::command]
pub async fn mac_click(request: ClickRequest) -> Result<ActionResult, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        let use_screen = request.use_screen.unwrap_or(false);
        let double = request.double.unwrap_or(false);
        let right = request.right.unwrap_or(false);
        // A control from the last look (or named by its label): judge it by its own role and label.
        let named = match (request.id, request.label.as_deref().filter(|l| !l.trim().is_empty())) {
            (Some(id), _) => Some(seen_control(&request.app, id).ok_or_else(|| format!("no control #{id} — look at {} again", request.app))?),
            (None, Some(label)) => Some(hands::find_by_label(&request.app, label, request.role.as_deref())?),
            _ => None,
        };
        if let Some((pid, mut control, element)) = named {
            // Off-screen (further down a page or list): scroll it into view first, in the background.
            if !control.place.is_empty() {
                hands::bring_into_view(pid, &mut control, &element);
            }
            let target = format!("{} · {}", control.role, control.label);
            let verdict = click_verdict_in(&format!("AX{}", control.role), &control.label, in_dialog(&element));
            let (cx, cy) = (control.x + control.w / 2.0, control.y + control.h / 2.0);
            let spot = CGPoint::new(cx, cy);
            let mut out = result(verdict, false, target.clone(), "");
            out.x = Some(cx);
            out.y = Some(cy);
            if verdict == Verdict::Never || (verdict == Verdict::Final && request.approved != Some(true)) {
                return Ok(out);
            }
            let before = hands::snapshot(&request.app, pid);
            let pixels = before.as_ref().map(|b| hands::spot_pixels(b, Some(spot))).unwrap_or_default();
            let check = |out: ActionResult| match &before {
                Some(b) => out.checked(hands::compare(b, Some(spot), &pixels)),
                None => out,
            };
            if !use_screen {
                // Background, way 1: press it, or select it (list rows), without touching the mouse.
                let pressed = !double && !right && (element.perform("AXPress") || {
                    element.set_bool("AXSelected", true);
                    element.bool("AXSelected") == Some(true)
                });
                if pressed {
                    out.done = true;
                    out.mode = "background".into();
                    return Ok(check(out));
                }
                // Way 2: a mouse click sent straight to that window.
                if hands::background_mouse(pid, spot, None, double, right).is_ok() {
                    out.done = true;
                    out.mode = "background".into();
                    let out = check(out);
                    if out.changed != Some(false) {
                        return Ok(out);
                    }
                }
                let mut need = needs_screen(verdict, target);
                need.x = Some(cx);
                need.y = Some(cy);
                return Ok(need);
            }
            borrow(&request.app, || click(cx, cy, double, right))?;
            out.done = true;
            out.mode = "screen".into();
            return Ok(check(out));
        }
        let (x, y) = match (request.x, request.y) {
            (Some(x), Some(y)) => (x, y),
            _ => return Err("give a control id, a label, or x and y".into()),
        };
        let (role, label, dialog) = control_at_in(x, y);
        let target = format!("{} · {}", role.trim_start_matches("AX"), label);
        let verdict = click_verdict_in(&role, &label, dialog);
        if verdict == Verdict::Never || (verdict == Verdict::Final && request.approved != Some(true)) {
            let mut out = result(verdict, false, target, "");
            out.x = Some(x);
            out.y = Some(y);
            return Ok(out);
        }
        let spot = CGPoint::new(x, y);
        let pid = background_pid(&request.app)?;
        let before = hands::snapshot(&request.app, pid);
        let pixels = before.as_ref().map(|b| hands::spot_pixels(b, Some(spot))).unwrap_or_default();
        let check = |out: ActionResult| match &before {
            Some(b) => out.checked(hands::compare(b, Some(spot), &pixels)),
            None => out,
        };
        if !use_screen {
            if hands::background_mouse(pid, spot, None, double, right).is_ok() {
                let mut out = check(result(verdict, true, target.clone(), "background"));
                out.x = Some(x);
                out.y = Some(y);
                if out.changed != Some(false) {
                    return Ok(out);
                }
            }
            let mut need = needs_screen(verdict, target);
            need.x = Some(x);
            need.y = Some(y);
            return Ok(need);
        }
        borrow(&request.app, || click(x, y, double, right))?;
        let mut out = check(result(verdict, true, target, "screen"));
        out.x = Some(x);
        out.y = Some(y);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragRequest {
    pub app: String,
    pub from_id: Option<usize>,
    pub from_label: Option<String>,
    pub from_x: Option<f64>,
    pub from_y: Option<f64>,
    pub to_id: Option<usize>,
    pub to_label: Option<String>,
    pub to_x: Option<f64>,
    pub to_y: Option<f64>,
    pub right: Option<bool>,
    pub use_screen: Option<bool>,
}

/// A drag's end: a control from the last look, a control named by label, or a screen point.
fn drag_end(app: &str, id: Option<usize>, label: Option<&str>, x: Option<f64>, y: Option<f64>) -> Result<(CGPoint, String), String> {
    let center = |c: &Control| (CGPoint::new(c.x + c.w / 2.0, c.y + c.h / 2.0), format!("{} · {}", c.role, c.label));
    if let Some(id) = id {
        let (_, control, _) = seen_control(app, id).ok_or_else(|| format!("no control #{id} — look at {app} again"))?;
        return Ok(center(&control));
    }
    if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
        let (_, control, _) = hands::find_by_label(app, label, None)?;
        return Ok(center(&control));
    }
    match (x, y) {
        (Some(x), Some(y)) => Ok((CGPoint::new(x, y), format!("{x:.0},{y:.0}"))),
        _ => Err("each end of a drag needs an id, a label, or x and y".into()),
    }
}

/// Real-mouse drag for when the background one doesn't take.
fn screen_drag(from: CGPoint, to: CGPoint, right: bool) -> Result<(), String> {
    let src = source()?;
    let (down, dragged, up, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseDragged, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseDragged, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };
    let event = |kind, p| CGEvent::new_mouse_event(src.clone(), kind, p, button).map_err(|_| "mouse event failed".to_string());
    post(event(CGEventType::MouseMoved, from)?);
    std::thread::sleep(Duration::from_millis(30));
    post(event(down, from)?);
    std::thread::sleep(Duration::from_millis(60));
    for i in 1..=20 {
        let t = i as f64 / 20.0;
        post(event(dragged, CGPoint::new(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t))?);
        std::thread::sleep(Duration::from_millis(10));
    }
    post(event(up, to)?);
    Ok(())
}

#[tauri::command]
pub async fn mac_drag(request: DragRequest) -> Result<ActionResult, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        let app = request.app.clone();
        let (from, from_name) = drag_end(&app, request.from_id, request.from_label.as_deref(), request.from_x, request.from_y)?;
        let (to, to_name) = drag_end(&app, request.to_id, request.to_label.as_deref(), request.to_x, request.to_y)?;
        let target = format!("{from_name} → {to_name}");
        let (role, label) = control_at(from.x, from.y);
        if click_verdict(&role, &label) == Verdict::Never || money_blocked(&app) {
            return Ok(result(Verdict::Never, false, target, ""));
        }
        let right = request.right.unwrap_or(false);
        let pid = background_pid(&app)?;
        let before = hands::snapshot(&app, pid);
        let pixels = before.as_ref().map(|b| hands::spot_pixels(b, Some(to))).unwrap_or_default();
        let check = |out: ActionResult| match &before {
            Some(b) => out.checked(hands::compare(b, Some(to), &pixels)),
            None => out,
        };
        if !request.use_screen.unwrap_or(false) {
            if hands::background_mouse(pid, from, Some(to), false, right).is_ok() {
                let out = check(result(Verdict::Ok, true, target.clone(), "background"));
                if out.changed != Some(false) {
                    return Ok(out);
                }
            }
            return Ok(needs_screen(Verdict::Ok, target));
        }
        borrow(&app, || screen_drag(from, to, right))?;
        Ok(check(result(Verdict::Ok, true, target, "screen")))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuResult {
    /// The path ended at a menu (or a part wasn't found): its items, to pick from.
    pub listing: String,
    pub action: Option<ActionResult>,
}

/// Runs a menu item by its path ("File > Export > PDF"), in the background. A path that ends at a
/// menu lists what's in it.
#[tauri::command]
pub async fn mac_menu(app: String, path: String, approved: Option<bool>) -> Result<MenuResult, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        if money_blocked(&app) {
            return Err(MONEY_REFUSAL.into());
        }
        let (pid, item, full) = match hands::find_menu(&app, &path) {
            Ok(hands::MenuStep::Listed(listing)) => return Ok(MenuResult { listing, action: None }),
            Ok(hands::MenuStep::Item(pid, item, full)) => (pid, item, full),
            Err(message) if message.starts_with("no \"") => return Ok(MenuResult { listing: message, action: None }),
            Err(message) => return Err(message),
        };
        let leaf = full.rsplit(" > ").next().unwrap_or(&full).to_string();
        let verdict = click_verdict("AXMenuItem", &leaf);
        let mut out = result(verdict, false, format!("MenuItem · {full}"), "");
        if verdict == Verdict::Never || (verdict == Verdict::Final && approved != Some(true)) {
            return Ok(MenuResult { listing: String::new(), action: Some(out) });
        }
        let before = hands::snapshot_app(&app);
        let how = hands::run_menu_item(pid, &item)?;
        out.done = true;
        out.mode = if how == "pressed" { "background".into() } else { "background-shortcut".into() };
        if let Some(b) = &before {
            out = out.checked(hands::compare(b, None, &[]));
        }
        Ok(MenuResult { listing: String::new(), action: Some(out) })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The focused control inside one app (works while the app is in the background).
fn app_focus(app: &str) -> Option<(i32, Element)> {
    let pid = pid_of(app)?;
    let app_el = Element::app(pid)?;
    Some((pid, app_el.element("AXFocusedUIElement")?))
}

fn describe(el: &Element) -> String {
    format!("{} · {}", el.string("AXRole").trim_start_matches("AX"), el.label())
}

fn text_of(el: &Element) -> String {
    el.string("AXValue")
}

#[tauri::command]
pub async fn mac_type(text: String, app: Option<String>, use_screen: Option<bool>) -> Result<ActionResult, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        let app = app.unwrap_or_default();
        let focus = if app.is_empty() { focused_element().map(|e| (0, e)) } else { app_focus(&app) };
        let verdict = match &focus {
            Some((_, el)) => typing_verdict_for(el, &text),
            None => typing_verdict_for_text(&text),
        };
        let target = focus.as_ref().map(|(_, e)| describe(e)).unwrap_or_default();
        if verdict == Verdict::Never {
            return Ok(result(verdict, false, target, ""));
        }
        if use_screen.unwrap_or(false) || app.is_empty() {
            if app.is_empty() {
                type_text(&text)?;
            } else {
                borrow(&app, || type_text(&text))?;
            }
            return Ok(result(verdict, true, target, "screen"));
        }
        let Some((pid, el)) = focus else { return Ok(needs_screen(verdict, target)) };
        let snap = hands::snapshot(&app, pid);
        let check = |out: ActionResult| match &snap {
            Some(b) => out.checked(hands::compare(b, None, &[])),
            None => out,
        };
        let before = text_of(&el);
        // Background, way 1: write into the field directly.
        if !before.contains(&text) && el.set_string("AXValue", &format!("{before}{text}")) && text_of(&el).contains(&text) {
            let mut out = check(result(verdict, true, target, "background"));
            // The field's own text is the receipt: it holds what was typed.
            out.changed = Some(true);
            return Ok(out);
        }
        // Way 2: keystrokes delivered only to that app.
        type_to(pid, &text)?;
        std::thread::sleep(Duration::from_millis(250));
        let after = text_of(&el);
        if after != before && after.contains(text.lines().last().unwrap_or(&text)) {
            let mut out = check(result(verdict, true, target, "background"));
            out.changed = Some(true);
            return Ok(out);
        }
        Ok(needs_screen(verdict, target))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mac_key(key: String, modifiers: Vec<String>, approved: Option<bool>, app: Option<String>, use_screen: Option<bool>) -> Result<ActionResult, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        let app = app.unwrap_or_default();
        let front = if app.is_empty() { front_app().map(|(n, _)| n).unwrap_or_default() } else { app.clone() };
        if opens_devtools(&front, &key, &modifiers) {
            return Err(DEVTOOLS_REFUSAL.into());
        }
        let focus = if app.is_empty() { focused_element().map(|e| (0, e)) } else { app_focus(&app) };
        let verdict = key_verdict_for(focus.as_ref().map(|(_, e)| e), &key, &modifiers);
        let target = focus.as_ref().map(|(_, e)| describe(e)).unwrap_or_default();
        if verdict == Verdict::Never || (verdict == Verdict::Final && approved != Some(true)) {
            return Ok(result(verdict, false, target, ""));
        }
        if use_screen.unwrap_or(false) || app.is_empty() {
            if app.is_empty() {
                press(&key, &modifiers)?;
            } else {
                borrow(&app, || press(&key, &modifiers))?;
            }
            return Ok(result(verdict, true, target, "screen"));
        }
        let pid = pid_of(&app).ok_or_else(|| format!("{app} isn't running"))?;
        let before = hands::snapshot(&app, pid);
        press_to(pid, &key, &modifiers)?;
        let out = result(verdict, true, target, "background");
        Ok(match &before {
            Some(b) => out.checked(hands::compare(b, None, &[])),
            None => out,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mac_scroll(app: Option<String>, x: Option<f64>, y: Option<f64>, dx: i32, dy: i32, use_screen: Option<bool>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if !accessibility_granted() {
            return Err("PERMISSION:accessibility".into());
        }
        match app.filter(|a| !a.is_empty()) {
            // Background first: the wheel goes straight to that window, the user's mouse and screen
            // stay put. Only a window that ignores it needs the screen (the caller asks first).
            Some(app) if use_screen != Some(true) => Ok(if hands::background_scroll(&app, x, y, dx, dy)? { "background".into() } else { "needs_screen".into() }),
            Some(app) => borrow(&app, || scroll(x, y, dx, dy)).map(|_| "screen".into()),
            None => scroll(x, y, dx, dy).map(|_| "screen".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Media control. "play" and "pause" are exact for Music and Spotify (asked directly); for
/// anything else (e.g. YouTube Music in a browser) they fall back to the play/pause key.
#[tauri::command]
pub async fn mac_media(key: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if key == "play" || key == "pause" {
            for player in ["Spotify", "Music"] {
                if pid_of(player).is_none() {
                    continue;
                }
                let state = run_timed("/usr/bin/osascript", &["-e", &format!("tell application \"{player}\" to player state as string")], 3).unwrap_or_default();
                let playing = state.contains("playing");
                if playing == (key == "play") {
                    return Ok(format!("{player} was already {}", if playing { "playing" } else { "paused" }));
                }
                if state.contains("playing") || state.contains("paused") {
                    run_timed("/usr/bin/osascript", &["-e", &format!("tell application \"{player}\" to {key}")], 3)?;
                    return Ok(format!("{player}: {key}"));
                }
            }
            media_key("playpause")?;
            return Ok("toggled play/pause".into());
        }
        media_key(&key)?;
        Ok(key)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Picture of the whole screen (main display), for tasks that span apps.
#[tauri::command]
pub async fn mac_screen() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        if !screen_granted() {
            return Err("PERMISSION:screen".into());
        }
        let path = std::env::temp_dir().join(format!("gideon-screen-{}.jpg", std::process::id()));
        let p = path.to_str().unwrap_or_default().to_string();
        run("/usr/sbin/screencapture", &["-x", "-m", "-t", "jpg", &p])?;
        run("/usr/bin/sips", &["-Z", "1600", "-s", "formatOptions", "70", &p])?;
        let data = std::fs::read(&path).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&path);
        Ok(base64_encode(&data?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_clicks() {
        assert_eq!(click_verdict("AXButton", "Send"), Verdict::Final);
        assert_eq!(click_verdict("AXButton", "Send message"), Verdict::Final);
        assert_eq!(click_verdict("AXButton", "Delete"), Verdict::Final);
        assert_eq!(click_verdict("AXButton", "Place your order"), Verdict::Never);
        assert_eq!(click_verdict("AXButton", "Pay now"), Verdict::Never);
        assert_eq!(click_verdict("AXButton", "Add to Cart"), Verdict::Never);
        assert_eq!(click_verdict("AXRow", "Chris"), Verdict::Ok);
        assert_eq!(click_verdict("AXButton", "Search"), Verdict::Ok);
        assert_eq!(click_verdict("AXTextArea", "Message @Chris"), Verdict::Ok);
        assert_eq!(click_verdict("AXLink", "Sender settings"), Verdict::Ok);
    }

    #[test]
    fn refuses_card_numbers() {
        assert_eq!(typing_verdict_for_text("4111 1111 1111 1111"), Verdict::Never);
        assert_eq!(typing_verdict_for_text("Hey Chris, project due tomorrow at 12"), Verdict::Ok);
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn treats_command_delete_as_final() {
        assert_eq!(key_verdict_for(None, "delete", &["command".into()]), Verdict::Final);
        assert_eq!(key_verdict_for(None, "return", &[]), Verdict::Final);
        assert_eq!(key_verdict_for(None, "tab", &[]), Verdict::Ok);
        assert_eq!(key_verdict_for(None, "return", &["shift".into()]), Verdict::Ok);
    }
}

// ── Money block (locked; also enforced in the frontend) ──────────────────────

const MONEY_DOMAINS: &[&str] = &[
    "paypal.com", "paypal.me", "venmo.com", "cash.app", "zellepay.com", "stripe.com", "pay.google.com",
    "wise.com", "remitly.com", "westernunion.com", "moneygram.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
    "capitalone.com", "usbank.com", "pnc.com", "americanexpress.com", "discover.com", "schwab.com", "fidelity.com", "vanguard.com",
    "robinhood.com", "etrade.com", "sofi.com", "chime.com", "ally.com", "coinbase.com", "binance.com", "binance.us", "kraken.com",
    "crypto.com", "gemini.com", "metamask.io", "klarna.com", "affirm.com", "afterpay.com",
];
const MONEY_PATHS: &[&str] = &["checkout", "/cart", "/basket", "/payment", "/pay/", "/billing", "/purchase", "/buy/", "/order/place", "/gp/buy", "/shop/bag", "/donate"];
const MONEY_APPS: &[&str] = &[
    "wallet", "paypal", "venmo", "cash app", "coinbase", "robinhood", "binance", "kraken", "exodus", "ledger live", "metamask", "chase",
    "bank of america", "wells fargo", "capital one", "schwab", "fidelity", "e*trade", "sofi", "chime",
];

/// True for anything to do with money: payment, banking, brokerage, crypto and checkout.
pub fn money_blocked(target: &str) -> bool {
    let t = target.trim().to_lowercase();
    if let Ok(url) = t.parse::<tauri::Url>() {
        if let Some(host) = url.host_str() {
            if MONEY_DOMAINS.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
                return true;
            }
            let path = url.path();
            if MONEY_PATHS.iter().any(|p| path.contains(p)) {
                return true;
            }
            return host.starts_with("checkout.") || host.starts_with("pay.") || host.starts_with("billing.");
        }
    }
    MONEY_APPS.iter().any(|a| t == *a || t.trim_end_matches(".app") == *a)
}

const MONEY_REFUSAL: &str = "NEVER:money — E.V never does anything involving money. Tell the user what to do themselves.";

pub(crate) fn run_timed(program: &str, args: &[&str], seconds: u64) -> Result<String, String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!("timed out after {seconds}s"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Opens an app, a website (optionally in a given app, e.g. Vivaldi) or a file/folder.
#[tauri::command]
pub async fn mac_open(target: Option<String>, app: Option<String>, background: Option<bool>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let target = target.unwrap_or_default().trim().to_string();
        let app = app.unwrap_or_default().trim().to_string();
        if money_blocked(&target) || money_blocked(&app) {
            return Err(MONEY_REFUSAL.into());
        }
        // A web address with no app goes to the default browser, which may be Vivaldi too.
        if is_vivaldi(&app) || (app.is_empty() && target.contains("://")) {
            crate::gideon_browser::step_aside();
        }
        if target.to_lowercase().starts_with("javascript:") {
            return Err(DEVTOOLS_REFUSAL.into());
        }
        // The hidden E.V Browser is still open (the panel is in use): reach the user's own Vivaldi
        // directly. Its program hands an address to the running copy that owns the normal profile —
        // the user's — and never to E.V's, which has a profile of its own.
        if is_vivaldi(&app) && crate::gideon_browser::own_pid().is_some() {
            if target.contains("://") {
                std::process::Command::new("/Applications/Vivaldi.app/Contents/MacOS/Vivaldi")
                    .arg(&target)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("couldn't open Vivaldi: {e}"))?;
                return Ok(format!("Opened {target} in {app}"));
            }
            if target.is_empty() {
                if let Some(pid) = pid_of(&app) {
                    activate_pid(pid);
                    return Ok(format!("Opened {app}"));
                }
            }
        }
        // -g: open without bringing it forward (for E.V's own work, so the user isn't interrupted).
        let background = background.unwrap_or(false);
        let target_arg = (!target.is_empty()).then(|| if target.contains("://") { target.clone() } else { crate::shell_env::expand_tilde(&target).display().to_string() });
        if !app.is_empty() && !app.contains('/') {
            // Already open: use that copy. Asking macOS to "open" it by name can start a second copy
            // from another folder.
            if let Some(pid) = pid_of(&app) {
                match (&target_arg, bundle_path_of(pid)) {
                    (None, _) => {
                        if !background {
                            activate_pid(pid);
                        }
                        return Ok(format!("{app} was already open — brought that window forward (no second copy started)"));
                    }
                    (Some(t), Some(path)) => {
                        let mut args = vec!["-a", path.as_str(), t.as_str()];
                        if background {
                            args.insert(0, "-g");
                        }
                        run_timed("/usr/bin/open", &args, 20)?;
                        return Ok(format!("Opened {target} in the {app} that was already open"));
                    }
                    (Some(_), None) => {}
                }
            } else {
                launch(&app, background, target_arg.as_deref())?;
                return Ok(match target_arg {
                    None => format!("Opened {app}"),
                    Some(_) => format!("Opened {target} in {app}"),
                });
            }
        }
        let mut args: Vec<String> = Vec::new();
        if background {
            args.push("-g".into());
        }
        if !app.is_empty() {
            args.extend(["-a".to_string(), app.clone()]);
        }
        if let Some(t) = target_arg {
            args.push(t);
        }
        if args.is_empty() {
            return Err("nothing to open".into());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_timed("/usr/bin/open", &refs, 20)?;
        Ok(match (target.is_empty(), app.is_empty()) {
            (true, _) => format!("Opened {app}"),
            (false, true) => format!("Opened {target}"),
            (false, false) => format!("Opened {target} in {app}"),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs AppleScript (or JavaScript for Automation) — how scriptable apps are controlled. The
/// frontend only calls this after the user approved the script (or a plan that names it).
#[tauri::command]
pub async fn mac_applescript(script: String, javascript: Option<bool>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let lower = script.to_lowercase();
        if MONEY_DOMAINS.iter().any(|d| lower.contains(d)) || MONEY_APPS.iter().any(|a| lower.contains(&format!("application \"{a}"))) {
            return Err(MONEY_REFUSAL.into());
        }
        if is_vivaldi(&lower) {
            crate::gideon_browser::step_aside();
        }
        // Running code inside the user's browser pages could do anything their logins allow.
        if BROWSERS.iter().any(|b| lower.contains(&format!("application \"{b}")) || lower.contains(&format!("app(\"{b}"))) && (lower.contains("javascript") || lower.contains("devtools")) {
            return Err(DEVTOOLS_REFUSAL.into());
        }
        // Scripted keystrokes and clicks would skip the Send/Delete checks in mac_click and mac_key.
        if lower.contains("system events") && ["keystroke", "key code", "key down", "click", "perform action"].iter().any(|w| lower.contains(w)) {
            return Err("scripted keystrokes and clicks aren't allowed; use mac_click and mac_key".into());
        }
        let mut args = Vec::new();
        if javascript.unwrap_or(false) {
            args.extend(["-l", "JavaScript"]);
        }
        args.extend(["-e", script.as_str()]);
        run_timed("/usr/bin/osascript", &args, 60)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mac_shortcut(name: String, input: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let input_file = std::env::temp_dir().join(format!("gideon-shortcut-{}.txt", std::process::id()));
        let mut args = vec!["run".to_string(), name];
        if let Some(text) = input {
            std::fs::write(&input_file, text).map_err(|e| e.to_string())?;
            args.extend(["-i".to_string(), input_file.display().to_string()]);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run_timed("/usr/bin/shortcuts", &refs, 120);
        let _ = std::fs::remove_file(&input_file);
        out
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mac_quit(app: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let script = format!("tell application \"{}\" to quit", app.replace(['"', '\\'], ""));
        run_timed("/usr/bin/osascript", &["-e", &script], 30).map(|_| format!("Quit {app}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads the clipboard, or writes `write` to it.
#[tauri::command]
pub async fn mac_clipboard(write: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || match write {
        Some(text) => {
            use std::io::Write;
            let mut child = std::process::Command::new("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
            child.stdin.take().ok_or("no clipboard")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            Ok("Copied to the clipboard".into())
        }
        None => run_timed("/usr/bin/pbpaste", &[], 5),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemState {
    pub volume: Option<i64>,
    pub muted: Option<bool>,
    pub dark_mode: Option<bool>,
}

fn read_system() -> SystemState {
    let volume = run_timed("/usr/bin/osascript", &["-e", "output volume of (get volume settings)"], 5).ok().and_then(|v| v.parse().ok());
    let muted = run_timed("/usr/bin/osascript", &["-e", "output muted of (get volume settings)"], 5).ok().map(|v| v == "true");
    let dark_mode = Some(run_timed("/usr/bin/defaults", &["read", "-g", "AppleInterfaceStyle"], 5).map(|v| v == "Dark").unwrap_or(false));
    SystemState { volume, muted, dark_mode }
}

/// Volume, mute and dark mode. Returns the settings from before, so the change can be undone.
#[tauri::command]
pub async fn mac_system(volume: Option<i64>, muted: Option<bool>, dark_mode: Option<bool>) -> Result<SystemState, String> {
    tokio::task::spawn_blocking(move || {
        let before = read_system();
        if let Some(v) = volume {
            run_timed("/usr/bin/osascript", &["-e", &format!("set volume output volume {}", v.clamp(0, 100))], 5)?;
        }
        if let Some(m) = muted {
            run_timed("/usr/bin/osascript", &["-e", &format!("set volume output muted {m}")], 5)?;
        }
        if let Some(d) = dark_mode {
            let script = format!("tell application \"System Events\" to tell appearance preferences to set dark mode to {d}");
            run_timed("/usr/bin/osascript", &["-e", &script], 15)?;
        }
        Ok(before)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod money_tests {
    use super::money_blocked;

    #[test]
    fn blocks_money_places() {
        for t in ["https://www.paypal.com/myaccount", "https://secure.chase.com/", "https://www.amazon.com/gp/buy/spc", "https://shop.example.com/checkout/step1", "https://checkout.shopify.com/x", "Coinbase", "Wallet"] {
            assert!(money_blocked(t), "{t}");
        }
        for t in ["https://music.youtube.com", "https://discord.com/channels/@me", "Discord", "Vivaldi", "/Users/me/Documents"] {
            assert!(!money_blocked(t), "{t}");
        }
    }
}

/// Read-only diagnostic: look at `app` in the background and report what happened.
pub fn background_report(app: &str) -> String {
    let front_before = front_app().map(|(n, _)| n).unwrap_or_default();
    let started = std::time::Instant::now();
    let look = look(Some(app), true);
    let front_after = front_app().map(|(n, _)| n).unwrap_or_default();
    match look {
        Ok(l) => format!(
            "front_before={front_before}\nfront_after={front_after}\nms={}\nwindow={}\ncontrols={}\nimage_bytes={}\n{}sample:\n{}\n",
            started.elapsed().as_millis(),
            l.window,
            l.controls.len(),
            l.image.len(),
            capture_report(app),
            l.controls.iter().take(25).map(|c| format!("  #{} {} \"{}\"", c.id, c.role, c.label.chars().take(60).collect::<String>())).collect::<Vec<_>>().join("\n")
        ),
        Err(e) => format!("front_before={front_before}\nfront_after={front_after}\nerror={e}\n"),
    }
}

/// Read-only diagnostic: why a background window picture did or didn't work.
pub fn capture_report(app: &str) -> String {
    let Some(pid) = pid_of(app) else { return "not running".into() };
    let Some(app_el) = Element::app(pid) else { return "no app element".into() };
    let Some(window) = main_window(&app_el) else { return "no window".into() };
    let id = window.window_id();
    let minimized = window.bool("AXMinimized");
    let hidden = app_el.bool("AXHidden");
    let path = std::env::temp_dir().join("gideon-capture-check.jpg");
    let p = path.to_str().unwrap_or_default().to_string();
    let mut lines = Vec::new();
    if let Some(id) = id {
        for (name, result) in [
            ("in_process", inprocess_capture(id, &p)),
            ("screencapture", run("/usr/sbin/screencapture", &["-x", "-o", "-t", "jpg", "-l", &id.to_string(), &p])),
        ] {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let _ = std::fs::remove_file(&path);
            lines.push(format!("{name}={result:?} bytes={size}"));
        }
    }
    format!("window_id={id:?}\nminimized={minimized:?}\napp_hidden={hidden:?}\n{}\nframe={:?}\n", lines.join("\n"), window.frame())
}

// ── Browser audio ─────────────────────────────────────────────────────────────

/// Whether one of a Chromium browser's tabs (Brave, Chrome, Arc, Edge, Vivaldi, Opera) is marked
/// "Audio playing" — the tab strip tells Accessibility so. A browser keeps its sound output open for
/// a while after a video or song is paused, so that alone doesn't mean anything is playing.
/// None when E.V can't tell (no Accessibility permission, or a window without tabs).
pub(crate) fn browser_tab_playing(pid: i32) -> Option<bool> {
    if !accessibility_granted() {
        return None;
    }
    let app = Element::app(pid)?;
    let windows: Vec<Element> = app
        .attr("AXWindows")
        .and_then(|v| v.downcast::<CFArray>())
        .map(|arr| arr.iter().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) })).collect())
        .unwrap_or_default();
    fn walk(el: &Element, depth: usize, seen: &mut usize, tabs: &mut usize) -> bool {
        if depth > 20 || *seen > 5000 {
            return false;
        }
        *seen += 1;
        let role = el.string("AXRole");
        if role == "AXWebArea" {
            return false;
        }
        if role == "AXRadioButton" || role == "AXTab" {
            *tabs += 1;
            if el.label().to_lowercase().contains("audio playing") {
                return true;
            }
        }
        el.children().iter().any(|child| walk(child, depth + 1, seen, tabs))
    }
    let (mut seen, mut tabs) = (0, 0);
    if windows.iter().any(|w| walk(w, 0, &mut seen, &mut tabs)) {
        return Some(true);
    }
    (tabs > 0).then_some(false)
}

// ── Notch check (diagnostic) ──────────────────────────────────────────────────

fn ax_text(el: &Element, depth: usize, out: &mut Vec<String>) {
    if depth > 40 || out.len() > 3000 {
        return;
    }
    let label = el.label();
    if !label.is_empty() {
        out.push(format!("{}{} · {}", "  ".repeat(depth.min(12)), el.string("AXRole"), label));
    }
    for child in el.children() {
        ax_text(&child, depth + 1, out);
    }
}

/// Every piece of text an app's windows show (panels included), read through Accessibility.
pub fn ax_dump(app: &str) -> String {
    let Some(pid) = pid_of(app) else { return format!("{app} isn't running\n") };
    let Some(app_el) = Element::app(pid) else { return "no accessibility element\n".into() };
    let windows: Vec<Element> = app_el
        .attr("AXWindows")
        .and_then(|v| v.downcast::<CFArray>())
        .map(|arr| arr.iter().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) })).collect())
        .unwrap_or_default();
    let mut out = vec![format!("{app} (pid {pid}) · {} windows", windows.len())];
    for (i, window) in windows.iter().enumerate() {
        out.push(format!("── window {i} {:?} {}", window.frame(), window.string("AXSubrole")));
        ax_text(window, 1, &mut out);
    }
    out.join("\n") + "\n"
}

/// `gideon --notch-look <dir>`: hovers the notch (as a person would), then saves what it shows —
/// its text (notch.txt) and a picture of it (notch.png) — and puts the pointer back.
pub fn notch_look(dir: &str) {
    let screen = core_graphics::display::CGDisplay::main().bounds();
    let back = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .ok()
        .and_then(|s| CGEvent::new(s).ok())
        .map(|e| e.location())
        .unwrap_or(CGPoint::new(screen.size.width / 2.0, screen.size.height / 2.0));
    let notch = CGPoint::new(screen.origin.x + screen.size.width / 2.0, screen.origin.y + 4.0);
    let hover = |point: CGPoint| {
        unsafe { CGWarpMouseCursorPosition(point) };
        if let Ok(src) = source() {
            if let Ok(mv) = CGEvent::new_mouse_event(src, CGEventType::MouseMoved, point, CGMouseButton::Left) {
                mv.post(CGEventTapLocation::HID);
            }
        }
    };
    hover(notch);
    std::thread::sleep(Duration::from_millis(400));
    hover(CGPoint::new(notch.x + 2.0, notch.y + 6.0));
    std::thread::sleep(Duration::from_millis(1800));
    let _ = std::fs::write(format!("{dir}/notch.txt"), ax_dump("Vorssaint"));
    let w = 820.0f64.min(screen.size.width);
    let rect = format!("{},{},{},{}", (notch.x - w / 2.0) as i64, screen.origin.y as i64, w as i64, 560);
    let _ = std::process::Command::new("/usr/sbin/screencapture").args(["-x", "-R", &rect]).arg(format!("{dir}/notch.png")).status();
    hover(back);
}

fn find_by_label(el: &Element, label: &str, depth: usize) -> Option<Element> {
    if depth > 40 {
        return None;
    }
    if el.string("AXRole") == "AXButton" && el.label() == label {
        return Some(el.clone());
    }
    el.children().iter().find_map(|c| find_by_label(c, label, depth + 1))
}

/// `gideon --notch-press <label>` (diagnostic): presses a notch button by its label, the way
/// VoiceOver would — no mouse involved.
pub fn notch_press(label: &str) -> String {
    let Some(pid) = pid_of("Vorssaint") else { return "Vorssaint isn't running".into() };
    let Some(app) = Element::app(pid) else { return "no accessibility element".into() };
    let windows: Vec<Element> = app
        .attr("AXWindows")
        .and_then(|v| v.downcast::<CFArray>())
        .map(|arr| arr.iter().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) })).collect())
        .unwrap_or_default();
    match windows.iter().find_map(|w| find_by_label(w, label, 0)) {
        Some(button) if button.perform("AXPress") => format!("pressed {label}"),
        Some(_) => format!("{label} didn't respond"),
        None => format!("no button {label}"),
    }
}

// ── The user's own browser ────────────────────────────────────────────────────

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyDefaultApplicationURLForURL(url: CFTypeRef, role: u32, error: *mut CFTypeRef) -> CFTypeRef;
}

/// The app macOS opens web links with (the user's default browser), e.g. "Brave Browser".
#[tauri::command]
pub fn mac_default_browser() -> String {
    use core_foundation::url::CFURL;
    let address = CFString::new("https://example.com");
    let raw = unsafe { core_foundation::url::CFURLCreateWithString(std::ptr::null(), address.as_concrete_TypeRef(), std::ptr::null()) };
    if raw.is_null() {
        return "Safari".into();
    }
    let link = unsafe { CFURL::wrap_under_create_rule(raw) };
    let app = unsafe { LSCopyDefaultApplicationURLForURL(link.as_CFTypeRef(), 0xFFFF_FFFF, std::ptr::null_mut()) };
    if app.is_null() {
        return "Safari".into();
    }
    let app = unsafe { CFURL::wrap_under_create_rule(app as _) };
    app.to_path()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Safari".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub window: usize,
    pub tab: usize,
    pub active: bool,
    pub title: String,
    pub url: String,
}

fn script_text(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Safari names things differently from Chromium browsers (Brave, Chrome, Vivaldi, Arc, Edge).
fn is_safari(app: &str) -> bool {
    app.to_lowercase().contains("safari")
}

// `tab` can't be the separator: inside `tell application "Brave Browser"` it means a browser tab
// (the text "tab"), so Chromium browsers listed nothing. `sep` is set outside the tell block.
fn list_tabs(app: &str) -> Result<Vec<BrowserTab>, String> {
    let (active, title) = if is_safari(app) { ("current tab of window w", "name") } else { ("active tab of window w", "title") };
    let script = format!(
        "set out to \"\"\nset sep to character id 9\ntell application {app}\nrepeat with w from 1 to count of windows\nset cur to {active}\nrepeat with t from 1 to count of tabs of window w\nset tb to tab t of window w\nset out to out & w & sep & t & sep & (tb is cur) & sep & ({title} of tb) & sep & (URL of tb) & linefeed\nend repeat\nend repeat\nend tell\nreturn out",
        app = script_text(app)
    );
    let out = run_timed("/usr/bin/osascript", &["-e", &script], 8)?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(5, '\t');
            Some(BrowserTab {
                window: f.next()?.trim().parse().ok()?,
                tab: f.next()?.trim().parse().ok()?,
                active: f.next()? == "true",
                title: f.next()?.to_string(),
                url: f.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

fn switch_tab(app: &str, window: usize, tab: usize, show: bool) -> Result<(), String> {
    let pick = if is_safari(app) { format!("set current tab of window {window} to tab {tab} of window {window}") } else { format!("set active tab index of window {window} to {tab}") };
    // The window comes to the top of the browser's own windows (so its page is the one read), but the
    // browser itself only comes forward when the user asked to see it.
    let front = if show { "\nactivate" } else { "" };
    let script = format!("tell application {}\n{pick}\nset index of window {window} to 1{front}\nend tell", script_text(app));
    run_timed("/usr/bin/osascript", &["-e", &script], 8).map(|_| ())
}

/// The user's browser tabs: "list" them, or "switch" to one — by window and tab number, or by text
/// in its title or address (`matching`). Never opens or closes tabs.
#[tauri::command]
pub async fn mac_tabs(app: String, action: String, window: Option<usize>, tab: Option<usize>, matching: Option<String>, show: Option<bool>) -> Result<Vec<BrowserTab>, String> {
    tokio::task::spawn_blocking(move || {
        let tabs = list_tabs(&app)?;
        if action != "switch" {
            return Ok(tabs);
        }
        let want = matching.as_deref().map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty());
        let target = match (window, tab, want) {
            (Some(w), Some(t), _) => tabs.iter().find(|x| x.window == w && x.tab == t),
            (_, _, Some(m)) => tabs.iter().find(|x| x.active && (x.url.to_lowercase().contains(&m) || x.title.to_lowercase().contains(&m))).or_else(|| tabs.iter().find(|x| x.url.to_lowercase().contains(&m) || x.title.to_lowercase().contains(&m))),
            _ => return Err("say which tab: window and tab numbers, or text from its title or address".into()),
        }
        .ok_or("no open tab like that — list the tabs to see what's open")?;
        if money_blocked(&target.url) {
            return Err(MONEY_REFUSAL.into());
        }
        let (w, t) = (target.window, target.tab);
        switch_tab(&app, w, t, show.unwrap_or(false))?;
        std::thread::sleep(Duration::from_millis(250));
        let now = list_tabs(&app)?;
        Ok(now.into_iter().filter(|x| x.active && x.window == 1).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
