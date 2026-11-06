//! Hold to talk: a shortcut held down anywhere on the Mac. The microphone starts natively the
//! instant the key goes down, the words heard so far show in the Vorssaint notch, and letting go
//! transcribes on the Mac and hands the text to the frontend to send. The shortcut is a key combo
//! (⌃⌥Space) or one key on its own (fn, Right Option…). A keyboard event tap watches for it —
//! Accessibility, which E.V already has, allows that — and a combo's own key presses are kept from
//! the front app. The same tap answers approvals with the user's three approval shortcuts.

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CGEventRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events: u64,
        callback: extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef,
        info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: CFRunLoopSourceRef, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
const FIELD_KEYCODE: u32 = 9;
const FIELD_AUTOREPEAT: u32 = 8;
const ESCAPE: i64 = 53;

const SHIFT: u64 = 0x0002_0000;
const CONTROL: u64 = 0x0004_0000;
const OPTION: u64 = 0x0008_0000;
const COMMAND: u64 = 0x0010_0000;
const FN: u64 = 0x0080_0000;
const MODIFIERS: u64 = SHIFT | CONTROL | OPTION | COMMAND;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Spec {
    /// A key with exactly these modifiers held.
    Combo { code: i64, flags: u64 },
    /// One modifier key on its own (its own key code, so Right Option isn't Left Option).
    Alone { code: i64, flag: u64 },
}

fn parse(shortcut: &str) -> Result<Spec, String> {
    let s = shortcut.trim().to_lowercase().replace(' ', "");
    let alone = |code, flag| Ok(Spec::Alone { code, flag });
    match s.as_str() {
        "fn" | "globe" => return alone(63, FN),
        "rightoption" | "rightalt" => return alone(61, OPTION),
        "rightcommand" | "rightcmd" => return alone(54, COMMAND),
        "rightcontrol" | "rightctrl" => return alone(62, CONTROL),
        "rightshift" => return alone(60, SHIFT),
        _ => {}
    }
    let parts: Vec<&str> = s.split('+').filter(|p| !p.is_empty()).collect();
    let (key, mods) = parts.split_last().ok_or("no shortcut set")?;
    let mut flags = 0;
    for m in mods {
        flags |= match *m {
            "control" | "ctrl" => CONTROL,
            "option" | "alt" => OPTION,
            "command" | "cmd" => COMMAND,
            "shift" => SHIFT,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
    }
    let code = crate::mac_control::key_code(key).ok_or_else(|| format!("unknown key \"{key}\""))? as i64;
    // A bare letter would fire while typing; F-keys alone are fine.
    if flags == 0 && !key.starts_with('f') {
        return Err("add at least one modifier (⌃ ⌥ ⌘ ⇧), or use an F-key or a single key like fn".into());
    }
    Ok(Spec::Combo { code, flags })
}

struct State {
    spec: Option<Spec>,
    held: bool,
    tap: usize,
}

static STATE: Mutex<State> = Mutex::new(State { spec: None, held: false, tap: 0 });
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The approval shortcuts work only while an approval is waiting.
static APPROVAL_KEYS: AtomicBool = AtomicBool::new(false);
/// Approve, approve always, cancel: (key code, modifiers).
static APPROVAL_COMBOS: Mutex<[Option<(i64, u64)>; 3]> = Mutex::new([None, None, None]);
/// The quick panel's shortcut (key code, modifiers): opens or closes the panel from any app.
static PANEL_COMBO: Mutex<Option<(i64, u64)>> = Mutex::new(None);
/// While the key is held: the notch keeps showing the words heard so far.
static HOLDING: AtomicBool = AtomicBool::new(false);

/// The key went down, came up, or was used for something else. Work happens off the tap's thread,
/// which must answer macOS at once.
fn emit(what: &str) {
    match what {
        "down" => {
            mic::start();
            HOLDING.store(true, Ordering::SeqCst);
            std::thread::spawn(|| {
                crate::notch::send_ev("listening", "", None);
                // The words so far, about once a second (on the Mac, so it costs nothing).
                while HOLDING.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    let (samples, rate) = mic::snapshot();
                    if !HOLDING.load(Ordering::SeqCst) || samples.len() < rate as usize / 2 || !crate::voice_engine::parakeet_ready() {
                        continue;
                    }
                    if let Ok(text) = crate::voice_engine::transcribe(&samples, rate as i32) {
                        if HOLDING.load(Ordering::SeqCst) && !text.is_empty() {
                            crate::notch::send_ev("listening", &text, None);
                        }
                    }
                }
            });
        }
        "up" => {
            HOLDING.store(false, Ordering::SeqCst);
            std::thread::spawn(|| {
                let (samples, rate) = mic::stop();
                if samples.len() < (rate as usize * 3) / 10 {
                    crate::notch::send_ev("clear", "", None);
                    return;
                }
                if !crate::voice_engine::parakeet_ready() {
                    crate::notch::send_ev("say", "Hold to talk needs E.V's speech engine: E.V Settings → Voice.", Some(5.0));
                    return;
                }
                let text = crate::voice_engine::transcribe(&samples, rate as i32).unwrap_or_default();
                if text.is_empty() {
                    crate::notch::send_ev("heard", "Didn't catch that", None);
                    return;
                }
                crate::notch::send_ev("heard", &text, None);
                if let Some(app) = APP.get() {
                    let _ = app.emit_to("main", "ptt-text", text);
                }
            });
        }
        _ => {
            HOLDING.store(false, Ordering::SeqCst);
            mic::cancel();
            std::thread::spawn(|| crate::notch::send_ev("clear", "", None));
        }
    }
}

/// The microphone, captured natively (Core Audio through cpal) on its own thread, since an input
/// stream can't move between threads.
mod mic {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    enum Command {
        Start,
        Stop(Sender<()>),
        Cancel,
    }

    /// Mono samples so far and their rate.
    static AUDIO: Mutex<(Vec<f32>, u32)> = Mutex::new((Vec::new(), 48_000));
    static COMMANDS: OnceLock<Mutex<Sender<Command>>> = OnceLock::new();

    fn push(data: &[f32], channels: usize) {
        let mut audio = AUDIO.lock().unwrap();
        audio.0.extend(data.chunks(channels.max(1)).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32));
    }

    fn open() -> Option<cpal::Stream> {
        let device = cpal::default_host().default_input_device()?;
        let config = device.default_input_config().ok()?;
        let channels = config.channels() as usize;
        {
            let mut audio = AUDIO.lock().unwrap();
            audio.0.clear();
            audio.1 = config.sample_rate().0;
        }
        let failed = |e| eprintln!("hold to talk: microphone error: {e}");
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| push(d, channels), failed, None),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |d: &[i16], _: &_| push(&d.iter().map(|s| *s as f32 / i16::MAX as f32).collect::<Vec<_>>(), channels),
                failed,
                None,
            ),
            _ => return None,
        }
        .ok()?;
        stream.play().ok()?;
        Some(stream)
    }

    fn sender() -> Sender<Command> {
        COMMANDS
            .get_or_init(|| {
                let (tx, rx) = channel::<Command>();
                std::thread::Builder::new()
                    .name("hold-to-talk-mic".into())
                    .spawn(move || {
                        let mut stream: Option<cpal::Stream> = None;
                        while let Ok(command) = rx.recv() {
                            match command {
                                Command::Start => {
                                    if stream.is_none() {
                                        stream = open();
                                    }
                                }
                                Command::Stop(done) => {
                                    stream = None;
                                    let _ = done.send(());
                                }
                                Command::Cancel => {
                                    stream = None;
                                    AUDIO.lock().unwrap().0.clear();
                                }
                            }
                        }
                    })
                    .expect("hold-to-talk mic thread");
                Mutex::new(tx)
            })
            .lock()
            .unwrap()
            .clone()
    }

    pub fn start() {
        let _ = sender().send(Command::Start);
    }

    /// Stops recording and hands over everything heard.
    pub fn stop() -> (Vec<f32>, u32) {
        let (done, wait) = channel();
        if sender().send(Command::Stop(done)).is_ok() {
            let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
        }
        let mut audio = AUDIO.lock().unwrap();
        (std::mem::take(&mut audio.0), audio.1)
    }

    pub fn snapshot() -> (Vec<f32>, u32) {
        let audio = AUDIO.lock().unwrap();
        (audio.0.clone(), audio.1)
    }

    pub fn cancel() {
        let _ = sender().send(Command::Cancel);
    }
}

extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: CGEventRef, _info: *mut c_void) -> CGEventRef {
    if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER {
        let tap = STATE.lock().map(|s| s.tap).unwrap_or(0);
        if tap != 0 {
            unsafe { CGEventTapEnable(tap as CFMachPortRef, true) };
        }
        return event;
    }
    let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
    let flags = unsafe { CGEventGetFlags(event) };
    if kind == KEY_DOWN && APPROVAL_KEYS.load(Ordering::Relaxed) && unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } == 0 {
        let combos = *APPROVAL_COMBOS.lock().unwrap();
        if let Some(index) = combos.iter().position(|c| *c == Some((code, flags & MODIFIERS))) {
            if let Some(app) = APP.get() {
                let _ = app.emit_to("main", "approval-key", ["approve", "always", "deny"][index]);
            }
            return std::ptr::null_mut();
        }
    }
    if kind == KEY_DOWN && unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } == 0 && *PANEL_COMBO.lock().unwrap() == Some((code, flags & MODIFIERS)) {
        if let Some(app) = APP.get() {
            crate::panel::toggle(app);
        }
        return std::ptr::null_mut();
    }
    let Ok(mut state) = STATE.lock() else { return event };
    let Some(spec) = state.spec else { return event };
    match spec {
        Spec::Combo { code: want, flags: want_flags } => {
            if kind == KEY_DOWN && code == ESCAPE && state.held {
                state.held = false;
                drop(state);
                emit("cancel");
                return std::ptr::null_mut();
            }
            if code != want || !matches!(kind, KEY_DOWN | KEY_UP) {
                return event;
            }
            if kind == KEY_DOWN {
                if state.held {
                    return std::ptr::null_mut(); // key repeat while held
                }
                let repeat = unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } != 0;
                if flags & MODIFIERS != want_flags || repeat {
                    return event;
                }
                state.held = true;
                drop(state);
                emit("down");
                return std::ptr::null_mut();
            }
            if state.held {
                state.held = false;
                drop(state);
                emit("up");
                return std::ptr::null_mut();
            }
            event
        }
        Spec::Alone { code: want, flag } => {
            if kind == FLAGS_CHANGED && code == want {
                let down = flags & flag != 0 && flags & MODIFIERS & !flag == 0;
                if down && !state.held {
                    state.held = true;
                    drop(state);
                    emit("down");
                } else if !down && state.held {
                    state.held = false;
                    drop(state);
                    emit("up");
                }
                return event;
            }
            // Another key while it's held: it was used as a modifier (fn+Delete, ⌥+letter), not to talk.
            if kind == KEY_DOWN && state.held {
                state.held = false;
                drop(state);
                emit("cancel");
            }
            event
        }
    }
}

/// Starts the keyboard watcher once (hold to talk and the approval keys share it).
pub(crate) fn ensure_tap(app: &AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    if STATE.lock().unwrap().tap != 0 {
        return Ok(());
    }
    start_tap()
}

pub(crate) fn set_approval_keys(on: bool) {
    APPROVAL_KEYS.store(on, Ordering::Relaxed);
}

/// The user's approve / approve always / cancel shortcuts (key combos from Settings → Approvals).
#[tauri::command]
pub fn approval_keys_configure(app: AppHandle, approve: String, always: String, cancel: String) -> Result<(), String> {
    let combo = |s: &str| match parse(s) {
        Ok(Spec::Combo { code, flags }) => Ok(Some((code, flags))),
        Ok(Spec::Alone { .. }) => Err(format!("\"{s}\" is a single key; approval shortcuts need a combo")),
        Err(e) => Err(e),
    };
    let combos = [combo(&approve)?, combo(&always)?, combo(&cancel)?];
    *APPROVAL_COMBOS.lock().unwrap() = combos;
    ensure_tap(&app)
}

/// The quick panel's shortcut (a key combo from Settings → Voice & shortcuts), or none.
#[tauri::command]
pub fn panel_configure(app: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    let combo = match shortcut.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => match parse(s)? {
            Spec::Combo { code, flags } => Some((code, flags)),
            Spec::Alone { .. } => return Err(format!("\"{s}\" is a single key; the panel shortcut needs a combo")),
        },
    };
    *PANEL_COMBO.lock().unwrap() = combo;
    if combo.is_some() {
        ensure_tap(&app)?;
    }
    Ok(())
}

/// On while an approval is waiting, so the shortcuts never take keys from other apps otherwise.
#[tauri::command]
pub fn approval_keys_active(on: bool) {
    set_approval_keys(on);
}

fn start_tap() -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("hold-to-talk".into())
        .spawn(move || unsafe {
            let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
            // Session tap, head insert, active filter (so a combo's own key presses can be kept from the app in front).
            let tap = CGEventTapCreate(1, 0, 0, mask, on_event, std::ptr::null_mut());
            if tap.is_null() {
                let _ = tx.send(false);
                return;
            }
            STATE.lock().unwrap().tap = tap as usize;
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            let _ = tx.send(true);
            CFRunLoopRun();
        })
        .map_err(|e| e.to_string())?;
    match rx.recv() {
        Ok(true) => Ok(()),
        _ => Err("PERMISSION:accessibility".into()),
    }
}

// ── E.V's small windows ─────────────────────────────────────────────────────

/// Puts one of E.V's small windows in front of every app without activating E.V, or hides it.
pub(crate) fn order(app: &AppHandle, label: &str, show: bool) {
    let Some(window) = app.get_webview_window(label) else { return };
    let _ = app.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let Ok(ns) = window.ns_window() else { return };
        let ns = ns as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        unsafe {
            if show {
                let _: () = msg_send![ns, orderFrontRegardless];
            } else {
                let _: () = msg_send![ns, orderOut: std::ptr::null::<AnyObject>()];
            }
        }
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Turns hold to talk on with this shortcut, or off.
#[tauri::command]
pub fn ptt_configure(app: AppHandle, enabled: bool, shortcut: String) -> Result<(), String> {
    let _ = APP.set(app.clone());
    if !enabled {
        let mut state = STATE.lock().unwrap();
        state.spec = None;
        state.held = false;
        return Ok(());
    }
    let spec = parse(&shortcut)?;
    ensure_tap(&app)?;
    let mut state = STATE.lock().unwrap();
    state.spec = Some(spec);
    state.held = false;
    Ok(())
}

