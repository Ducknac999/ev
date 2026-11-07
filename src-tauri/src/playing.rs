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

/// What the sound on the Mac actually is, so E.V knows whether to pause it, stay quiet, or just talk.
#[derive(serde::Serialize, Default, Debug)]
pub struct MediaNow {
    /// Really playing music or video, and E.V can pause it: "Spotify", "Brave Browser".
    pub music: Vec<String>,
    /// A call or meeting — never talked over.
    pub calls: Vec<String>,
    /// Sound E.V ignores: audio tools (FineTune, SoundSource…), a paused browser, system sounds.
    pub other: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Kind {
    Call,
    /// Spotify / Music: asked directly whether they're playing, paused and resumed by name.
    Scriptable,
    /// Chromium browsers: playing only when a tab says "Audio playing".
    Chromium,
    /// Other players (Safari, VLC, IINA, Podcasts…): playing when they make sound.
    Player,
    Other,
}

fn kind(name: &str) -> Kind {
    let n = name.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["zoom", "facetime", "discord", "teams", "webex", "skype", "whatsapp", "slack", "signal", "telegram", "gotomeeting", "around", "tuple"]) {
        Kind::Call
    } else if n == "spotify" || n == "music" {
        Kind::Scriptable
    } else if has(&["brave", "chrome", "chromium", "arc", "edge", "vivaldi", "opera"]) {
        Kind::Chromium
    } else if n == "tv" || has(&["safari", "firefox", "vlc", "iina", "quicktime", "podcasts", "tidal", "deezer", "youtube", "audible", "plexamp", "infuse", "mpv", "elmedia", "soundcloud", "pandora", "amazon music"]) {
        Kind::Player
    } else {
        Kind::Other
    }
}

fn player_state(app: &str) -> String {
    crate::mac_control::run_timed("/usr/bin/osascript", &["-e", &format!("tell application \"{app}\" to player state as string")], 3).unwrap_or_default()
}

/// Sorts what's making sound into music E.V can pause, calls it mustn't talk over, and the rest.
#[tauri::command]
pub async fn media_now() -> MediaNow {
    tokio::task::spawn_blocking(|| {
        let mut now = MediaNow::default();
        for pid in playing_pids() {
            let name = app_name(pid);
            if name.is_empty() {
                continue;
            }
            let list = match kind(&name) {
                Kind::Call => &mut now.calls,
                Kind::Scriptable if player_state(&name).contains("playing") => &mut now.music,
                Kind::Chromium if crate::mac_control::browser_tab_playing(pid) == Some(true) => &mut now.music,
                Kind::Player => &mut now.music,
                _ => &mut now.other,
            };
            if !list.contains(&name) {
                list.push(name);
            }
        }
        now
    })
    .await
    .unwrap_or_default()
}

/// Pauses what `media_now` found playing. Returns what it paused, for `media_resume`: Spotify and
/// Music by name, everything else with one press of the play/pause key ("key").
#[tauri::command]
pub async fn media_pause(music: Vec<String>) -> Vec<String> {
    tokio::task::spawn_blocking(move || {
        let mut paused = Vec::new();
        for name in music {
            if kind(&name) == Kind::Scriptable {
                if player_state(&name).contains("playing") && crate::mac_control::run_timed("/usr/bin/osascript", &["-e", &format!("tell application \"{name}\" to pause")], 3).is_ok() {
                    paused.push(name);
                }
            } else if !paused.iter().any(|p| p == "key") && crate::mac_control::media_key("playpause").is_ok() {
                paused.push("key".into());
            }
        }
        paused
    })
    .await
    .unwrap_or_default()
}

/// Resumes exactly what `media_pause` paused — nothing else.
#[tauri::command]
pub async fn media_resume(paused: Vec<String>) {
    let _ = tokio::task::spawn_blocking(move || {
        for name in paused {
            if name == "key" {
                let _ = crate::mac_control::media_key("playpause");
            } else if kind(&name) == Kind::Scriptable && player_state(&name).contains("paused") {
                let _ = crate::mac_control::run_timed("/usr/bin/osascript", &["-e", &format!("tell application \"{name}\" to play")], 3);
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_sound_sources() {
        assert_eq!(kind("FineTune"), Kind::Other);
        assert_eq!(kind("SoundSource"), Kind::Other);
        assert_eq!(kind("Spotify"), Kind::Scriptable);
        assert_eq!(kind("Music"), Kind::Scriptable);
        assert_eq!(kind("Brave Browser"), Kind::Chromium);
        assert_eq!(kind("Google Chrome"), Kind::Chromium);
        assert_eq!(kind("Safari"), Kind::Player);
        assert_eq!(kind("zoom.us"), Kind::Call);
        assert_eq!(kind("FaceTime"), Kind::Call);
    }
}
