//! What's making sound on the Mac right now, so E.V doesn't talk over music or a video.
//! Core Audio lists every process sending audio to an output (macOS 14.2+); E.V's own
//! processes (its web view plays E.V's voice) don't count.

use std::ffi::c_void;

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
    fn AudioObjectGetPropertyData(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
}

const fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

const SYSTEM_OBJECT: u32 = 1;
const GLOBAL: u32 = code(b"glob");
const PROCESS_LIST: u32 = code(b"prs#");
const PROCESS_PID: u32 = code(b"ppid");
const RUNNING_OUTPUT: u32 = code(b"piro");

fn property<T: Default + Copy>(object: u32, selector: u32) -> Option<T> {
    let address = Address { selector, scope: GLOBAL, element: 0 };
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(object, &address, 0, std::ptr::null(), &mut size, &mut value as *mut T as *mut c_void) };
    (status == 0).then_some(value)
}

fn processes() -> Vec<u32> {
    let address = Address { selector: PROCESS_LIST, scope: GLOBAL, element: 0 };
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size) } != 0 || size == 0 {
        return Vec::new();
    }
    let mut ids = vec![0u32; size as usize / 4];
    let status = unsafe { AudioObjectGetPropertyData(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / 4);
    ids
}

/// The app responsible for a helper process (a web view's audio process belongs to its app).
fn responsible(pid: i32) -> i32 {
    type Responsible = unsafe extern "C" fn(i32) -> i32;
    static FN: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let f = *FN.get_or_init(|| unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) as usize });
    if f == 0 {
        return pid;
    }
    let owner = unsafe { std::mem::transmute::<usize, Responsible>(f)(pid) };
    if owner > 0 { owner } else { pid }
}

fn app_name(pid: i32) -> String {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let Some(class) = AnyClass::get(c"NSRunningApplication") else { return String::new() };
        let app: *mut AnyObject = msg_send![class, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return String::new();
        }
        let name: *mut AnyObject = msg_send![app, localizedName];
        if name.is_null() {
            return String::new();
        }
        let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
        if utf8.is_null() { String::new() } else { std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned() }
    }
}

/// Names of the apps playing sound right now, E.V itself left out.
#[tauri::command]
pub fn audio_playing() -> Vec<String> {
    let mut names: Vec<String> = playing_pids().into_iter().map(app_name).filter(|name| !name.is_empty()).collect();
    names.sort();
    names.dedup();
    names
}

fn playing_pids() -> Vec<i32> {
    let own = std::process::id() as i32;
    let mut pids: Vec<i32> = processes()
        .into_iter()
        .filter(|&object| property::<u32>(object, RUNNING_OUTPUT).unwrap_or(0) != 0)
        .filter_map(|object| property::<i32>(object, PROCESS_PID))
        .map(responsible)
        .filter(|&pid| pid != own)
        .collect();
    pids.sort();
    pids.dedup();
    pids
}

/// What macOS Now Playing says (what Control Center shows): the app it belongs to and whether
/// it's playing. Read by loading E.V's helper library into /usr/bin/perl — since macOS 15.4 only
/// Apple-signed programs may read Now Playing (see helpers/nowplayinglib.swift).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct NowPlaying {
    pub playing: bool,
    #[serde(default)]
    pub pid: i32,
    #[serde(default)]
    pub app: String,
}

const LOADER: &str = r#"use DynaLoader; my $h = DynaLoader::dl_load_file($ARGV[0], 0) or exit 2; my $s = DynaLoader::dl_find_symbol($h, $ARGV[1]) or exit 3; DynaLoader::dl_install_xsub("main::get", $s); main::get();"#;

/// Runs one of the helper library's Now Playing functions inside /usr/bin/perl; its JSON line.
fn read_now_playing(symbol: &str, artwork: bool) -> Option<String> {
    let lib = crate::doc::lib_path()?;
    let mut child = std::process::Command::new("/usr/bin/perl");
    child.args(["-e", LOADER, &lib.display().to_string(), symbol]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    if artwork {
        child.env("EV_NP_ARTWORK", "1");
    }
    let mut child = child.spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while child.try_wait().ok()?.is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let out = child.wait_with_output().ok()?;
    String::from_utf8(out.stdout).ok()?.lines().last().map(str::to_string)
}

/// None when Now Playing can't be read (a future macOS may block it): E.V then falls back to
/// asking Spotify and Music directly, and never presses play/pause on a guess.
pub fn now_playing() -> Option<NowPlaying> {
    let mut now: NowPlaying = serde_json::from_str(&read_now_playing("ev_nowplaying_get", false)?).ok()?;
    // E.V's own voice never counts.
    if now.pid == std::process::id() as i32 {
        now.playing = false;
    }
    Some(now)
}

/// The song for the notch's music card (title, artist, position…), as Now Playing reports it.
/// `artwork`: include the cover (base64) — asked once per song.
#[tauri::command]
pub async fn now_playing_info(artwork: Option<bool>) -> Option<serde_json::Value> {
    tokio::task::spawn_blocking(move || {
        let mut value: serde_json::Value = serde_json::from_str(&read_now_playing("ev_nowplaying_info", artwork.unwrap_or(false))?).ok()?;
        if value.get("pid").and_then(|p| p.as_i64()) == Some(std::process::id() as i64) {
            return None;
        }
        value.get("error").is_none().then(|| {
            value["fetchedAt"] = serde_json::json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0));
            value
        })
    })
    .await
    .ok()
    .flatten()
}

/// What the sound on the Mac actually is, so E.V knows whether to pause it, stay quiet, or just talk.
#[derive(serde::Serialize, Default, Debug)]
pub struct MediaNow {
    /// Really playing (Now Playing says so), and E.V can pause it: "Spotify", "Brave Browser".
    pub music: Vec<String>,
    /// A call or meeting — never talked over.
    pub calls: Vec<String>,
    /// Sound E.V ignores: audio tools (FineTune, SoundSource…), paused players, system sounds.
    pub other: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Kind {
    Call,
    /// Spotify / Music: paused and resumed by name, so nothing else is touched.
    Scriptable,
    Other,
}

fn kind(name: &str) -> Kind {
    let n = name.to_lowercase();
    if ["zoom", "facetime", "discord", "teams", "webex", "skype", "whatsapp", "slack", "signal", "telegram", "gotomeeting", "tuple"].iter().any(|w| n.contains(w)) {
        Kind::Call
    } else if n == "spotify" || n == "music" {
        Kind::Scriptable
    } else {
        Kind::Other
    }
}

fn osascript(script: &str) -> Result<String, String> {
    crate::mac_control::run_timed("/usr/bin/osascript", &["-e", script], 3)
}

/// Whether an app is open (asking a closed app for its state would launch it).
fn running(app: &str) -> bool {
    std::process::Command::new("/usr/bin/pgrep").args(["-xq", app]).status().map(|s| s.success()).unwrap_or(false)
}

fn playing_names_all() -> Vec<String> {
    playing_pids().into_iter().map(app_name).filter(|n| !n.is_empty()).collect()
}

fn player_state(app: &str) -> String {
    if !running(app) {
        return String::new();
    }
    osascript(&format!("tell application \"{app}\" to player state as string")).unwrap_or_default()
}

fn sorted(now: Option<NowPlaying>, sounding: Vec<String>) -> MediaNow {
    let mut out = MediaNow::default();
    match &now {
        Some(np) if np.playing && !np.app.is_empty() && kind(&np.app) != Kind::Call => out.music.push(np.app.clone()),
        Some(_) => {}
        None => {
            for app in ["Spotify", "Music"] {
                if player_state(app).contains("playing") {
                    out.music.push(app.into());
                }
            }
        }
    }
    for name in sounding {
        let list = if kind(&name) == Kind::Call { &mut out.calls } else { &mut out.other };
        if !out.music.contains(&name) && !list.contains(&name) {
            list.push(name);
        }
    }
    out
}

/// Sorts what's making sound into music E.V can pause, calls it mustn't talk over, and the rest.
#[tauri::command]
pub async fn media_now() -> MediaNow {
    tokio::task::spawn_blocking(|| sorted(now_playing(), playing_names_all())).await.unwrap_or_default()
}

/// Waits up to ~1.5 s for Now Playing to report `playing`.
fn settles(playing: bool) -> bool {
    for _ in 0..6 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if now_playing().map(|n| n.playing) == Some(playing) {
            return true;
        }
    }
    false
}

/// Pauses what `media_now` found playing and checks that it stopped. Returns what it paused, for
/// `media_resume`: Spotify and Music by name, anything else as "key" (the play/pause key, pressed
/// only while Now Playing says something is playing).
#[tauri::command]
pub async fn media_pause(music: Vec<String>) -> Vec<String> {
    tokio::task::spawn_blocking(move || {
        let mut paused = Vec::new();
        for name in music {
            if kind(&name) == Kind::Scriptable {
                if player_state(&name).contains("playing") && osascript(&format!("tell application \"{name}\" to pause")).is_ok() {
                    paused.push(name);
                }
            } else if !paused.iter().any(|p| p == "key") && now_playing().map(|n| n.playing) == Some(true) && crate::mac_control::media_key("playpause").is_ok() {
                if settles(false) {
                    paused.push("key".into());
                } else {
                    // It didn't stop: press again so whatever the key did is undone, and talk over it.
                    let _ = crate::mac_control::media_key("playpause");
                }
            }
        }
        paused
    })
    .await
    .unwrap_or_default()
}

/// Resumes exactly what `media_pause` paused — and only if it's still paused (you may have
/// started something yourself meanwhile).
#[tauri::command]
pub async fn media_resume(paused: Vec<String>) {
    let _ = tokio::task::spawn_blocking(move || {
        for name in paused {
            if name == "key" {
                if now_playing().map(|n| n.playing) == Some(false) {
                    let _ = crate::mac_control::media_key("playpause");
                }
            } else if kind(&name) == Kind::Scriptable && player_state(&name).contains("paused") {
                let _ = osascript(&format!("tell application \"{name}\" to play"));
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn np(playing: bool, app: &str) -> Option<NowPlaying> {
        Some(NowPlaying { playing, pid: 1, app: app.into() })
    }

    #[test]
    fn sorts_sound_sources() {
        assert_eq!(kind("FineTune"), Kind::Other);
        assert_eq!(kind("Spotify"), Kind::Scriptable);
        assert_eq!(kind("zoom.us"), Kind::Call);
        assert_eq!(kind("FaceTime"), Kind::Call);
    }

    #[test]
    fn only_now_playing_counts_as_music() {
        let fine = || vec!["FineTune".to_string(), "Brave Browser".to_string()];
        let playing = sorted(np(true, "Brave Browser"), fine());
        assert_eq!(playing.music, vec!["Brave Browser"]);
        assert_eq!(playing.other, vec!["FineTune"]);
        let paused = sorted(np(false, "Brave Browser"), fine());
        assert!(paused.music.is_empty());
        assert_eq!(paused.other, vec!["FineTune", "Brave Browser"]);
        let call = sorted(np(false, "Spotify"), vec!["zoom.us".into()]);
        assert_eq!(call.calls, vec!["zoom.us"]);
    }

    #[test]
    fn reads_now_playing() {
        // The real Mac: just checks the reader answers (playing or not).
        if let Some(now) = now_playing() {
            println!("now playing: {now:?}");
        }
    }
}
