//! Background clicks and drags, menus by name, and a before/after check for every action.
//!
//! The methods follow Atticus (github.com/SaarthurR/atticus-mac, MIT; see CREDITS.md): mouse
//! events are posted to one app's process with its window stamped in, after a window-server focus
//! record makes that window take input without being raised — so the pointer, the front app and the
//! window order stay as the user left them. Each action reads the window before and after and
//! reports what changed, so the AI can't claim an action worked when nothing happened.

use super::*;
use core_foundation::number::CFNumber;
use std::sync::OnceLock;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: i32) -> *mut c_void;
    fn CGEventCreateMouseEvent(source: *const c_void, kind: u32, point: CGPoint, button: u32) -> *mut c_void;
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
    fn CGEventSetLocation(event: *mut c_void, point: CGPoint);
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
    fn CGEventCreateScrollWheelEvent(source: *const c_void, units: u32, count: u32, wheel1: i32, ...) -> *mut c_void;
}

const MOUSE_MOVED: u32 = 5;
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const LEFT_DRAGGED: u32 = 6;
const RIGHT_DRAGGED: u32 = 7;

// ── SkyLight (optional: without it, the public per-process post is used) ─────

struct Sky {
    post: Option<unsafe extern "C" fn(i32, *mut c_void)>,
    stamp: Option<unsafe extern "C" fn(*mut c_void, CGPoint)>,
    record: Option<unsafe extern "C" fn(*const c_void, *const c_void) -> i32>,
    process_for_pid: Option<unsafe extern "C" fn(i32, *mut c_void) -> i32>,
}

fn sky() -> &'static Sky {
    static SKY: OnceLock<Sky> = OnceLock::new();
    SKY.get_or_init(|| unsafe {
        let open = |path: &std::ffi::CStr| libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
        let skylight = open(c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");
        let services = open(c"/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices");
        let find = |lib: *mut c_void, name: &std::ffi::CStr| if lib.is_null() { std::ptr::null_mut() } else { libc::dlsym(lib, name.as_ptr()) };
        let post = find(skylight, c"SLEventPostToPid");
        let stamp = find(skylight, c"CGEventSetWindowLocation");
        let record = find(skylight, c"SLPSPostEventRecordTo");
        let process_for_pid = find(services, c"GetProcessForPID");
        Sky {
            post: (!post.is_null()).then(|| std::mem::transmute::<*mut c_void, unsafe extern "C" fn(i32, *mut c_void)>(post)),
            stamp: (!stamp.is_null()).then(|| std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, CGPoint)>(stamp)),
            record: (!record.is_null()).then(|| std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*const c_void, *const c_void) -> i32>(record)),
            process_for_pid: (!process_for_pid.is_null()).then(|| std::mem::transmute::<*mut c_void, unsafe extern "C" fn(i32, *mut c_void) -> i32>(process_for_pid)),
        }
    })
}

// ── Windows on screen ────────────────────────────────────────────────────────

struct WindowInfo {
    id: u32,
    pid: i32,
    bounds: (f64, f64, f64, f64),
}

fn number(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    dict.find(CFString::from_static_string(key)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64())
}

/// Visible app windows (layer 0), front to back.
fn windows_on_screen() -> Vec<WindowInfo> {
    let raw = unsafe { CGWindowListCopyWindowInfo(1, 0) };
    if raw.is_null() {
        return Vec::new();
    }
    let list: CFArray<CFDictionary<CFString, CFType>> = unsafe { CFArray::wrap_under_create_rule(raw as _) };
    list.iter()
        .filter_map(|dict| {
            if number(&dict, "kCGWindowLayer")? != 0.0 || number(&dict, "kCGWindowAlpha").unwrap_or(1.0) <= 0.0 {
                return None;
            }
            let bounds = dict.find(CFString::from_static_string("kCGWindowBounds"))?.downcast::<CFDictionary>()?;
            let bounds: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
            Some(WindowInfo {
                id: number(&dict, "kCGWindowNumber")? as u32,
                pid: number(&dict, "kCGWindowOwnerPID")? as i32,
                bounds: (number(&bounds, "X")?, number(&bounds, "Y")?, number(&bounds, "Width")?, number(&bounds, "Height")?),
            })
        })
        .collect()
}

fn contains(b: (f64, f64, f64, f64), p: CGPoint) -> bool {
    p.x >= b.0 && p.y >= b.1 && p.x < b.0 + b.2 && p.y < b.1 + b.3
}

/// The app's window a real click at `p` would reach: its topmost visible window there.
fn window_at(p: CGPoint, pid: i32) -> Option<u32> {
    windows_on_screen().into_iter().find(|w| w.pid == pid && contains(w.bounds, p)).map(|w| w.id)
}

fn top_window(pid: i32) -> Option<u32> {
    windows_on_screen().into_iter().find(|w| w.pid == pid).map(|w| w.id)
}

// ── Background mouse ─────────────────────────────────────────────────────────

/// An app hands mouse input to a window's content only while it counts that window as key. This
/// window-server focus record makes it so without raising the window, activating the app or taking
/// key from the user's window. Off hands the app back its inactive state.
fn focus_without_raise(pid: i32, window: u32, on: bool) {
    let sky = sky();
    let (Some(record_to), Some(process_for_pid)) = (sky.record, sky.process_for_pid) else { return };
    let mut psn = [0u32; 2];
    if unsafe { process_for_pid(pid, psn.as_mut_ptr() as *mut c_void) } != 0 {
        return;
    }
    let mut record = [0u8; 0xF8];
    record[0x04] = 0xF8;
    record[0x08] = 0x0D;
    record[0x8A] = if on { 1 } else { 2 };
    record[0x3C..0x40].copy_from_slice(&window.to_le_bytes());
    if !on {
        std::thread::sleep(Duration::from_millis(50)); // the gesture's queued events land while the window is still key
    }
    unsafe { record_to(psn.as_ptr() as *const c_void, record.as_ptr() as *const c_void) };
    if on {
        std::thread::sleep(Duration::from_millis(50)); // AppKit settles its key window before the events arrive
    }
}

/// A click in a key window brings it in front of its app's other windows: put the one that was in
/// front back afterwards.
fn keep_order(pid: i32) -> impl FnOnce() {
    let before = top_window(pid);
    move || {
        std::thread::sleep(Duration::from_millis(50));
        let Some(before) = before else { return };
        if top_window(pid) == Some(before) {
            return;
        }
        if let Some(app) = Element::app(pid) {
            let windows = app.attr("AXWindows").and_then(|v| v.downcast::<CFArray>());
            for p in windows.iter().flat_map(|a| a.iter().filter(|p| !p.is_null()).map(|p| *p).collect::<Vec<_>>()) {
                let window = Element(unsafe { CFType::wrap_under_get_rule(p as CFTypeRef) });
                if window.window_id() == Some(before) {
                    window.perform("AXRaise");
                    break;
                }
            }
        }
    }
}

struct Gesture {
    pid: i32,
    window: u32,
    source: *mut c_void,
    id: i64,
}

impl Gesture {
    /// Field 0 carries the gesture phase, 1 the click count, 3 the button, 7 the subtype, 58 one id
    /// for the whole gesture; 40 routes it to the process, 51/91/92 to the window.
    fn post(&self, kind: u32, p: CGPoint, phase: i64, count: i64, subtype: i64, wait_ms: u64) -> Result<(), String> {
        let right = matches!(kind, RIGHT_DOWN | RIGHT_UP | RIGHT_DRAGGED);
        let e = unsafe { CGEventCreateMouseEvent(self.source, kind, p, if right { 1 } else { 0 }) };
        if e.is_null() {
            return Err("mouse event failed".into());
        }
        unsafe {
            CGEventSetFlags(e, 0);
            CGEventSetLocation(e, p);
            if let Some(stamp) = sky().stamp {
                stamp(e, p);
            }
            for (field, value) in [(0, phase), (1, count), (3, right as i64), (7, subtype), (58, self.id), (40, self.pid as i64), (51, self.window as i64), (91, self.window as i64), (92, self.window as i64)] {
                CGEventSetIntegerValueField(e, field, value);
            }
            match sky().post {
                Some(post) => post(self.pid, e),
                None => CGEventPostToPid(self.pid, e),
            }
            CFRelease(e);
        }
        if wait_ms > 0 {
            std::thread::sleep(Duration::from_millis(wait_ms));
        }
        Ok(())
    }
}

impl Drop for Gesture {
    fn drop(&mut self) {
        if !self.source.is_null() {
            unsafe { CFRelease(self.source) };
        }
    }
}

/// Clicks (or drags from `from` to `to`) inside `pid`'s window at that point, entirely in the
/// background. Err when there is no visible window of that app there.
pub(super) fn background_mouse(pid: i32, from: CGPoint, to: Option<CGPoint>, double: bool, right: bool) -> Result<(), String> {
    let window = window_at(from, pid).ok_or("no visible window of that app at that point")?;
    let source = unsafe { CGEventSourceCreate(1) };
    let id = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(1)) as i64;
    let g = Gesture { pid, window, source, id };
    let restore_order = keep_order(pid);
    focus_without_raise(pid, window, true);
    let result = (|| {
        // A move primes the window's hit-testing; an off-screen click opens Chromium's user-activation gate for background input.
        g.post(MOUSE_MOVED, from, 2, 0, 3, 15)?;
        if !right {
            g.post(LEFT_DOWN, CGPoint::new(-1.0, -1.0), 1, 1, 3, 1)?;
            g.post(LEFT_UP, CGPoint::new(-1.0, -1.0), 2, 1, 3, 100)?;
        }
        let (down, dragged, up) = if right { (RIGHT_DOWN, RIGHT_DRAGGED, RIGHT_UP) } else { (LEFT_DOWN, LEFT_DRAGGED, LEFT_UP) };
        if let Some(to) = to {
            g.post(down, from, 3, 1, 0, 30)?;
            let drag = (|| {
                for i in 1..=20 {
                    let t = i as f64 / 20.0;
                    g.post(dragged, CGPoint::new(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t), 3, 1, 0, if i == 20 { 50 } else { 8 })?;
                }
                Ok::<(), String>(())
            })();
            // Never leave the button held down, even if a step failed.
            g.post(up, to, 3, 1, 0, 0)?;
            return drag;
        }
        for count in 1..=(if double { 2 } else { 1 }) {
            g.post(down, from, 3, count, 3, if right { 28 } else { 1 })?;
            g.post(up, from, 3, count, 3, if double && count == 1 { 80 } else { 0 })?;
        }
        Ok(())
    })();
    focus_without_raise(pid, window, false);
    restore_order();
    result
}

// ── Before/after check ───────────────────────────────────────────────────────

/// One read of an app's window: its controls (kept live, so the AI can click them next), focus and
/// any sheet or dialog.
pub(super) struct Snap {
    app: String,
    pid: i32,
    window_id: u32,
    title: String,
    frame: (f64, f64, f64, f64),
    found: Vec<(Control, Element)>,
    focused: String,
    sheet: String,
}

pub(super) fn snapshot(app: &str, pid: i32) -> Option<Snap> {
    let app_el = Element::app(pid)?;
    let window = main_window(&app_el)?;
    let frame = window.frame()?;
    let mut found = Vec::new();
    collect(&window, &mut found, 0, frame);
    let focused = app_el.element("AXFocusedUIElement").map(|e| describe(&e)).unwrap_or_default();
    let sheet = window
        .attr("AXSheets")
        .and_then(|v| v.downcast::<CFArray>())
        .and_then(|a| a.iter().next().filter(|p| !p.is_null()).map(|p| Element(unsafe { CFType::wrap_under_get_rule(*p as CFTypeRef) })))
        .map(|s| s.label())
        .unwrap_or_default();
    Some(Snap { app: app.to_string(), pid, window_id: window.window_id().unwrap_or(0), title: window.string("AXTitle"), frame, found, focused, sheet })
}

fn key(c: &Control) -> (String, String) {
    (c.role.clone(), c.label.clone())
}

fn line(c: &Control) -> String {
    format!(
        "#{} {}{}{}{}",
        c.id,
        c.role,
        if c.label.is_empty() { String::new() } else { format!(" \"{}\"", c.label.chars().take(80).collect::<String>()) },
        if c.focused { " (focused)" } else { "" },
        if c.place.is_empty() { String::new() } else { format!(" ({}, off screen)", c.place) }
    )
}

// ── Background scrolling ─────────────────────────────────────────────────────

/// Where the first few visible controls sit: changes when the window really scrolled.
fn scroll_marks(snap: &Snap) -> Vec<(String, i64)> {
    snap.found.iter().filter(|(c, _)| c.place.is_empty()).take(25).map(|(c, _)| (c.label.clone(), c.y as i64)).collect()
}

/// Scrolls `app`'s window with wheel events sent to that window alone (no pointer move, no raise).
/// True when the window moved; false when it ignored it (then only the screen can do it).
pub(super) fn background_scroll(app: &str, x: Option<f64>, y: Option<f64>, dx: i32, dy: i32) -> Result<bool, String> {
    let pid = background_pid(app)?;
    let before = snapshot(app, pid).ok_or_else(|| format!("{app} has no readable window"))?;
    let (fx, fy, fw, fh) = before.frame;
    let at = CGPoint::new(x.unwrap_or(fx + fw / 2.0), y.unwrap_or(fy + fh / 2.0));
    let window = window_at(at, pid).unwrap_or(before.window_id);
    let source = unsafe { CGEventSourceCreate(1) };
    focus_without_raise(pid, window, true);
    // Several small notches, like a real wheel; pages ignore one huge jump.
    let steps = 4;
    for i in 0..steps {
        let (vy, vx) = (-dy / steps + if i == 0 { -dy % steps } else { 0 }, -dx / steps + if i == 0 { -dx % steps } else { 0 });
        let e = unsafe { CGEventCreateScrollWheelEvent(source, 1, 2, vy, vx) };
        if e.is_null() {
            continue;
        }
        unsafe {
            CGEventSetLocation(e, at);
            if let Some(stamp) = sky().stamp {
                stamp(e, at);
            }
            for (field, value) in [(40, pid as i64), (51, window as i64), (91, window as i64), (92, window as i64)] {
                CGEventSetIntegerValueField(e, field, value);
            }
            match sky().post {
                Some(post) => post(pid, e),
                None => CGEventPostToPid(pid, e),
            }
            CFRelease(e);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    focus_without_raise(pid, window, false);
    if !source.is_null() {
        unsafe { CFRelease(source) };
    }
    std::thread::sleep(Duration::from_millis(300));
    let Some(after) = snapshot(app, pid) else { return Ok(false) };
    let moved = scroll_marks(&before) != scroll_marks(&after);
    remember(&after.app, after.pid, after.found.iter().map(|(c, e)| (c.clone(), e.clone())).collect());
    Ok(moved)
}

/// An off-screen control: scrolls it into view (accessibility first, then the wheel, in the
/// background) and updates where it is, so the click lands on it.
pub(super) fn bring_into_view(pid: i32, control: &mut Control, element: &Element) {
    let app = Element::app(pid);
    let frame = app.as_ref().and_then(main_window).and_then(|w| w.frame());
    let inside = |c: &Control| frame.is_some_and(|(x, y, w, h)| c.x + c.w / 2.0 > x && c.x + c.w / 2.0 < x + w && c.y + c.h / 2.0 > y && c.y + c.h / 2.0 < y + h);
    let refresh = |c: &mut Control| {
        if let Some((x, y, w, h)) = element.frame() {
            (c.x, c.y, c.w, c.h) = (x.round(), y.round(), w.round(), h.round());
        }
    };
    element.perform("AXScrollToVisible");
    std::thread::sleep(Duration::from_millis(250));
    refresh(control);
    if !inside(control) {
        if let (Some((_, fy, _, fh)), Some(name)) = (frame, app.as_ref().map(|a| a.string("AXTitle")).filter(|n| !n.is_empty())) {
            for _ in 0..8 {
                let center = fy + fh / 2.0;
                let lines = (((control.y - center) / 40.0).round() as i32).clamp(-60, 60);
                if lines == 0 || background_scroll(&name, None, None, 0, lines).is_err() {
                    break;
                }
                refresh(control);
                if inside(control) {
                    break;
                }
            }
        }
    }
    if inside(control) {
        control.place.clear();
    }
}

pub(super) struct Change {
    /// None: the window couldn't be read afterwards, so the result can't be confirmed.
    pub changed: Option<bool>,
    pub report: String,
}

/// 64×40 grey thumbnail of a window (around `spot` when given), for changes the controls don't show.
fn fingerprint(window: u32, spot: Option<CGPoint>) -> Vec<u8> {
    type FingerprintFn = unsafe extern "C" fn(u32, f64, f64, *mut u8) -> i32;
    static LIB: OnceLock<Option<usize>> = OnceLock::new();
    let Some(f) = *LIB.get_or_init(|| {
        let path = resource("libgideoncapture.dylib")?;
        let c_path = std::ffi::CString::new(path.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        let f = (!handle.is_null()).then(|| unsafe { libc::dlsym(handle, c"gideon_window_fingerprint".as_ptr()) })?;
        (!f.is_null()).then_some(f as usize)
    }) else {
        return Vec::new();
    };
    if window == 0 || !screen_granted() {
        return Vec::new();
    }
    let mut pixels = vec![0u8; 64 * 40];
    let (x, y) = spot.map(|p| (p.x, p.y)).unwrap_or((-1.0, -1.0));
    let ok = unsafe { std::mem::transmute::<usize, FingerprintFn>(f)(window, x, y, pixels.as_mut_ptr()) };
    if ok == 1 { pixels } else { Vec::new() }
}

fn pixels_changed(before: &[u8], after: &[u8]) -> bool {
    !before.is_empty() && before.len() == after.len() && before.iter().zip(after).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / before.len() as f64 >= 1.5
}

/// A before-picture for actions whose effect may not show in the control list.
pub(super) fn spot_pixels(before: &Snap, spot: Option<CGPoint>) -> Vec<u8> {
    fingerprint(before.window_id, spot)
}

/// Waits for the window to settle, then compares it with `before` and remembers the new controls
/// (so their numbers are the ones the AI uses next).
pub(super) fn compare(before: &Snap, spot: Option<CGPoint>, before_pixels: &[u8]) -> Change {
    std::thread::sleep(Duration::from_millis(150));
    let mut after = snapshot(&before.app, before.pid);
    // A window still changing (a page loading, a sheet sliding in) is read again until it stops.
    for _ in 0..6 {
        let Some(current) = &after else { break };
        std::thread::sleep(Duration::from_millis(120));
        let next = snapshot(&before.app, before.pid);
        let same = next.as_ref().is_some_and(|n| n.title == current.title && n.found.len() == current.found.len() && n.found.iter().zip(&current.found).all(|(a, b)| key(&a.0) == key(&b.0)));
        after = next;
        if same {
            break;
        }
    }
    let Some(after) = after else {
        return Change { changed: None, report: "Couldn't read the window afterwards, so this couldn't be confirmed. Look again before saying it worked.".into() };
    };
    let controls: Vec<Control> = after.found.iter().map(|(c, _)| c.clone()).collect();
    remember(&after.app, after.pid, after.found.iter().map(|(c, e)| (c.clone(), e.clone())).collect());
    if after.window_id != before.window_id || after.title != before.title {
        // A text row repeating the control just before it (a link's or heading's own words) adds nothing.
        let mut shown: Vec<&Control> = Vec::new();
        for c in &controls {
            let repeat = c.role == "StaticText" && shown.last().is_some_and(|p| !c.label.is_empty() && p.label.contains(c.label.as_str()));
            if !repeat {
                shown.push(c);
            }
        }
        let list = shown.into_iter().take(60).map(line).collect::<Vec<_>>().join("\n");
        return Change { changed: Some(true), report: format!("Window now: \"{}\"\nControls (current numbers):\n{list}", after.title) };
    }
    let mut lines = Vec::new();
    if !after.sheet.is_empty() && after.sheet != before.sheet {
        lines.push(format!("A sheet opened: \"{}\"", after.sheet));
    }
    if after.frame != before.frame {
        lines.push("The window moved or resized.".into());
    }
    let before_keys: Vec<(String, String)> = before.found.iter().map(|(c, _)| key(c)).collect();
    let after_keys: Vec<(String, String)> = controls.iter().map(key).collect();
    for (role, label) in before_keys.iter().filter(|k| !after_keys.contains(k)).take(15) {
        lines.push(format!("Gone: {role}{}", if label.is_empty() { String::new() } else { format!(" \"{}\"", label.chars().take(60).collect::<String>()) }));
    }
    for c in controls.iter().filter(|c| !before_keys.contains(&key(c))).take(40) {
        lines.push(format!("New: {}", line(c)));
    }
    if after.focused != before.focused {
        lines.push(format!("Focused: {}", after.focused));
    }
    if !lines.is_empty() {
        return Change { changed: Some(true), report: format!("Changed:\n{}\n(Control numbers are current.)", lines.join("\n")) };
    }
    if !before_pixels.is_empty() {
        let now = fingerprint(after.window_id, spot);
        if pixels_changed(before_pixels, &now) {
            return Change { changed: Some(true), report: "The window's picture changed there (no control changed).".into() };
        }
        return Change { changed: Some(false), report: "Nothing changed — no control and nothing on screen there. It didn't work; try another way.".into() };
    }
    Change {
        changed: Some(false),
        report: "Nothing changed in the window's controls. If this action normally shows nothing (a sound, a save), check another way; otherwise it didn't work.".into(),
    }
}

/// Snapshot for an app by name, when it's running.
pub(super) fn snapshot_app(app: &str) -> Option<Snap> {
    let pid = pid_of(app)?;
    snapshot(app, pid)
}

// ── Clicking by label ────────────────────────────────────────────────────────

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['…', '.'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Forgiving form of a name: no case, emoji or punctuation, singular words, no repeated words —
/// "Quotes 💬" and "quote Quote" both become "quote". Different words still differ.
pub(super) fn loose(s: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    for w in s.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace() {
        let w = if w.chars().count() > 3 && w.ends_with('s') && !w.ends_with("ss") { &w[..w.len() - 1] } else { w };
        if words.last().map(|l| l.as_str()) != Some(w) {
            words.push(w.to_string());
        }
    }
    words.join(" ")
}

/// The control a label names in the app's window now: exact label first, then a label starting with
/// it, then containing it; `role` narrows it when given. Remembers the fresh look.
pub(super) fn find_by_label(app: &str, label: &str, role: Option<&str>) -> Result<(i32, Control, Element), String> {
    let pid = background_pid(app)?;
    let snap = snapshot(app, pid).ok_or_else(|| format!("{app} has no readable window"))?;
    let want = norm(label);
    let role = role.map(|r| r.trim_start_matches("AX").to_lowercase());
    let fits = |c: &Control| role.as_ref().is_none_or(|r| c.role.to_lowercase() == *r);
    let loose_want = loose(label);
    let want_words: Vec<&str> = loose_want.split(' ').filter(|w| !w.is_empty()).collect();
    // Exact, then starts with, then contains; then the forgiving form (case, plurals, emoji); then
    // every word present. On screen beats off screen within a tier.
    let pick = [0, 1, 2, 3, 4, 5].iter().find_map(|tier| {
        let matches = |c: &Control| {
            let l = norm(&c.label);
            let ll = loose(&c.label);
            fits(c)
                && !l.is_empty()
                && match tier {
                    0 => l == want,
                    1 => l.starts_with(&want),
                    2 => l.contains(&want),
                    3 => !loose_want.is_empty() && ll == loose_want,
                    4 => !loose_want.is_empty() && (ll.starts_with(&loose_want) || ll.contains(&loose_want)),
                    _ => !want_words.is_empty() && want_words.iter().all(|w| ll.split(' ').any(|x| x == *w)),
                }
        };
        snap.found.iter().find(|(c, _)| c.place.is_empty() && matches(c)).or_else(|| snap.found.iter().find(|(c, _)| matches(c)))
    });
    let found = pick.map(|(c, e)| (c.clone(), e.clone()));
    remember(app, pid, snap.found);
    let (control, element) = found.ok_or_else(|| format!("no control labelled \"{label}\" in {app} right now — look at it again"))?;
    Ok((pid, control, element))
}

// ── Menus by name ────────────────────────────────────────────────────────────

fn menu_children(el: &Element) -> Vec<Element> {
    // A menu bar item or menu item holds one AXMenu, whose children are the items.
    el.children().into_iter().flat_map(|c| if c.string("AXRole") == "AXMenu" { c.children() } else { vec![c] }).collect()
}

fn menu_title(el: &Element) -> String {
    el.string("AXTitle")
}

fn shortcut_of(el: &Element) -> Option<(String, Vec<String>)> {
    let ch = el.string("AXMenuItemCmdChar");
    if ch.trim().is_empty() {
        return None;
    }
    let mods = el.attr("AXMenuItemCmdModifiers").and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64()).unwrap_or(0);
    let mut out = Vec::new();
    if mods & 8 == 0 {
        out.push("command".to_string());
    }
    if mods & 1 != 0 {
        out.push("shift".into());
    }
    if mods & 2 != 0 {
        out.push("option".into());
    }
    if mods & 4 != 0 {
        out.push("control".into());
    }
    Some((ch.to_lowercase(), out))
}

fn shortcut_text((ch, mods): &(String, Vec<String>)) -> String {
    let sym = |m: &str| match m { "command" => "⌘", "shift" => "⇧", "option" => "⌥", "control" => "⌃", _ => "" };
    format!("{}{}", mods.iter().map(|m| sym(m)).collect::<String>(), ch.to_uppercase())
}

fn listing(items: &[Element]) -> String {
    items
        .iter()
        .filter_map(|i| {
            let t = menu_title(i);
            (!t.trim().is_empty()).then(|| {
                let sub = if menu_children(i).is_empty() { "" } else { " ›" };
                let off = if i.bool("AXEnabled") == Some(false) { " (disabled)" } else { "" };
                let key = shortcut_of(i).map(|s| format!("  {}", shortcut_text(&s))).unwrap_or_default();
                format!("{t}{sub}{off}{key}")
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) enum MenuStep {
    /// The path ends at a menu: what's in it.
    Listed(String),
    /// The item to run, with its full path.
    Item(i32, Element, String),
}

/// Walks "File > Export > PDF" in the app's menu bar (no menu is opened). Each part matches an item
/// exactly, then by start, then by containing it, ignoring case and "…".
pub(super) fn find_menu(app: &str, path: &str) -> Result<MenuStep, String> {
    let pid = background_pid(app)?;
    let app_el = Element::app(pid).ok_or("couldn't reach that app")?;
    let bar = app_el.element("AXMenuBar").ok_or_else(|| format!("{app} has no menu bar"))?;
    let parts: Vec<String> = path.split(['>', '›', '→']).map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        let tops: Vec<String> = bar.children().iter().map(menu_title).filter(|t| !t.is_empty()).collect();
        return Ok(MenuStep::Listed(format!("{app}'s menus: {}", tops.join(", "))));
    }
    let mut items = bar.children();
    let mut walked = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let want = norm(part);
        let found = [0, 1, 2].iter().find_map(|tier| {
            items.iter().find(|el| {
                let t = norm(&menu_title(el));
                !t.is_empty() && match tier { 0 => t == want, 1 => t.starts_with(&want), _ => t.contains(&want) }
            })
        });
        let Some(el) = found.cloned() else {
            let here = if walked.is_empty() { format!("{app}'s menu bar") } else { walked.join(" > ") };
            return Err(format!("no \"{part}\" in {here}. It has:\n{}", listing(&items)));
        };
        walked.push(menu_title(&el));
        let children = menu_children(&el);
        if i + 1 == parts.len() {
            return Ok(if children.is_empty() { MenuStep::Item(pid, el, walked.join(" > ")) } else { MenuStep::Listed(format!("{}:\n{}", walked.join(" > "), listing(&children))) });
        }
        items = children;
    }
    unreachable!("the loop returns at the last part")
}

/// Runs a menu item: pressed through accessibility, or by its keyboard shortcut sent to the app.
pub(super) fn run_menu_item(pid: i32, item: &Element) -> Result<&'static str, String> {
    if item.bool("AXEnabled") == Some(false) {
        return Err("that menu item is greyed out right now".into());
    }
    if item.perform("AXPress") {
        return Ok("pressed");
    }
    let (ch, mods) = shortcut_of(item).ok_or("the app didn't respond to the menu item and it has no keyboard shortcut")?;
    press_to(pid, &ch, &mods)?;
    Ok("shortcut")
}
