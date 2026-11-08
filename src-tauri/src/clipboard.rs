//! Clipboard history for the E.V notch (Settings → Notch → Clipboard). Twice a second the
//! clipboard's change count is checked (no reading unless it changed); a new copy is saved whole
//! by the helper library (helpers/cliplib.swift) — every type, so picking it later puts back
//! exactly what was copied — and listed in the notch's Clipboard tab. Passwords and other things
//! apps mark as private are never kept, and neither are copies from apps you list. Everything
//! stays on this Mac, in E.V's data folder.

use serde::{Deserialize, Serialize};
use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    /// "text" | "link" | "image" | "files"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// A small PNG (base64) for images and image files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// The app it was copied from (its icon: `clip_icons`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<String>,
    /// `thumb` is the file's Finder icon, not a picture of it.
    #[serde(default)]
    pub file_icon: bool,
    pub hash: String,
    pub bytes: u64,
    /// Milliseconds since 1970: when it was copied (or last picked).
    pub at: u64,
    #[serde(default)]
    pub pinned: bool,
    /// The saved copy (every type), in E.V's data folder.
    #[serde(skip_serializing)]
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Captured {
    count: isize,
    skip: Option<String>,
    kind: Option<String>,
    text: Option<String>,
    files: Option<Vec<String>>,
    thumb: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    app: Option<String>,
    bundle: Option<String>,
    app_icon: Option<String>,
    #[serde(default)]
    file_icon: bool,
    hash: Option<String>,
    bytes: Option<u64>,
    path: Option<String>,
}

struct Config {
    enabled: bool,
    limit: usize,
    /// App names or bundle IDs, lowercased.
    ignore: Vec<String>,
}

static CONFIG: Mutex<Config> = Mutex::new(Config { enabled: false, limit: 100, ignore: Vec::new() });
static HISTORY: Mutex<Vec<ClipItem>> = Mutex::new(Vec::new());
static LOADED: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/// The clipboard change count already looked at (E.V's own restores set it, so they aren't re-added).
static SEEN: AtomicIsize = AtomicIsize::new(-1);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Each app's icon (bundle ID → small PNG, base64), shared by all its items.
static ICONS: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

// ── The helper library ───────────────────────────────────────────────────────

struct Lib {
    count: unsafe extern "C" fn() -> isize,
    capture: unsafe extern "C" fn(*const c_char) -> *mut c_char,
    restore: unsafe extern "C" fn(*const c_char) -> isize,
    paste_key: unsafe extern "C" fn() -> bool,
    free: unsafe extern "C" fn(*mut c_char),
}

fn lib() -> Result<&'static Lib, String> {
    static LIB: OnceLock<Option<Lib>> = OnceLock::new();
    LIB.get_or_init(|| {
        let path = CString::new(crate::doc::lib_path()?.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return None;
        }
        let sym = |name: &CStr| {
            let p = unsafe { libc::dlsym(handle, name.as_ptr()) };
            (!p.is_null()).then_some(p as usize)
        };
        let (count, capture, restore, paste_key, free) = (sym(c"ev_clip_count")?, sym(c"ev_clip_capture")?, sym(c"ev_clip_restore")?, sym(c"ev_clip_paste_key")?, sym(c"ev_clip_free")?);
        Some(unsafe {
            Lib {
                count: std::mem::transmute::<usize, unsafe extern "C" fn() -> isize>(count),
                capture: std::mem::transmute::<usize, unsafe extern "C" fn(*const c_char) -> *mut c_char>(capture),
                restore: std::mem::transmute::<usize, unsafe extern "C" fn(*const c_char) -> isize>(restore),
                paste_key: std::mem::transmute::<usize, unsafe extern "C" fn() -> bool>(paste_key),
                free: std::mem::transmute::<usize, unsafe extern "C" fn(*mut c_char)>(free),
            }
        })
    })
    .as_ref()
    .ok_or_else(|| "E.V's clipboard helper is missing — reinstall E.V".to_string())
}

fn capture(lib: &Lib, dir: &std::path::Path) -> Option<Captured> {
    let dir = CString::new(dir.display().to_string()).ok()?;
    let raw = unsafe { (lib.capture)(dir.as_ptr()) };
    if raw.is_null() {
        return None;
    }
    let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
    unsafe { (lib.free)(raw) };
    serde_json::from_str(&json).ok()
}

// ── Storage ─────────────────────────────────────────────────────────────────

fn folder() -> Option<PathBuf> {
    APP.get()?.path().app_data_dir().ok().map(|d| d.join("clipboard"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load() {
    if LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(dir) = folder() else { return };
    let Ok(text) = std::fs::read_to_string(dir.join("history.json")) else { return };
    let Ok(items) = serde_json::from_str::<Vec<StoredItem>>(&text) else { return };
    let mut history = HISTORY.lock().unwrap();
    *history = items.into_iter().map(ClipItem::from).filter(|i| std::path::Path::new(&i.path).exists()).collect();
}

/// On disk the saved copy's path is kept (it's left out of what the notch gets).
#[derive(Serialize, Deserialize)]
struct StoredItem {
    #[serde(flatten)]
    item: ClipItemFields,
    path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipItemFields {
    id: String,
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    bundle: Option<String>,
    #[serde(default)]
    file_icon: bool,
    hash: String,
    bytes: u64,
    at: u64,
    #[serde(default)]
    pinned: bool,
}

impl From<StoredItem> for ClipItem {
    fn from(s: StoredItem) -> Self {
        let f = s.item;
        ClipItem { id: f.id, kind: f.kind, text: f.text, files: f.files, thumb: f.thumb, width: f.width, height: f.height, app: f.app, bundle: f.bundle, file_icon: f.file_icon, hash: f.hash, bytes: f.bytes, at: f.at, pinned: f.pinned, path: s.path }
    }
}

impl From<&ClipItem> for StoredItem {
    fn from(i: &ClipItem) -> Self {
        StoredItem {
            item: ClipItemFields {
                id: i.id.clone(),
                kind: i.kind.clone(),
                text: i.text.clone(),
                files: i.files.clone(),
                thumb: i.thumb.clone(),
                width: i.width,
                height: i.height,
                app: i.app.clone(),
                bundle: i.bundle.clone(),
                file_icon: i.file_icon,
                hash: i.hash.clone(),
                bytes: i.bytes,
                at: i.at,
                pinned: i.pinned,
            },
            path: i.path.clone(),
        }
    }
}

fn save(history: &[ClipItem]) {
    let Some(dir) = folder() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let stored: Vec<StoredItem> = history.iter().map(StoredItem::from).collect();
    if let Ok(json) = serde_json::to_string(&stored) {
        let tmp = dir.join("history.json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, dir.join("history.json"));
        }
    }
}

/// Newest first; pinned ones always stay, the rest up to the limit. Returns the saved copies to delete.
fn trim(history: &mut Vec<ClipItem>, limit: usize) -> Vec<String> {
    history.sort_by(|a, b| b.at.cmp(&a.at));
    let mut kept = 0;
    let mut gone = Vec::new();
    history.retain(|item| {
        if item.pinned {
            return true;
        }
        kept += 1;
        if kept <= limit {
            true
        } else {
            gone.push(item.path.clone());
            false
        }
    });
    gone
}

fn changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("notch", "clipboard-changed", ());
    }
}

fn ignored(config: &Config, app: Option<&str>, bundle: Option<&str>) -> bool {
    let names = [app.unwrap_or("").to_lowercase(), bundle.unwrap_or("").to_lowercase()];
    config.ignore.iter().any(|i| !i.is_empty() && names.iter().any(|n| n == i))
}

/// A new copy: added at the top (an identical one already listed moves up instead, keeping its pin).
fn add(c: Captured) {
    if let (Some(bundle), Some(icon)) = (&c.bundle, &c.app_icon) {
        remember_icon(bundle, icon);
    }
    let (Some(kind), Some(hash), Some(path)) = (c.kind, c.hash, c.path) else { return };
    let limit = CONFIG.lock().unwrap().limit;
    let mut history = HISTORY.lock().unwrap();
    let mut pinned = false;
    let mut remove = Vec::new();
    history.retain(|i| {
        if i.hash == hash && i.kind == kind {
            pinned |= i.pinned;
            remove.push(i.path.clone());
            false
        } else {
            true
        }
    });
    history.insert(
        0,
        ClipItem {
            id: format!("{:x}{:04x}", now_ms(), rand_u16()),
            kind,
            text: c.text,
            files: c.files.unwrap_or_default(),
            thumb: c.thumb,
            width: c.width,
            height: c.height,
            app: c.app,
            bundle: c.bundle,
            file_icon: c.file_icon,
            hash,
            bytes: c.bytes.unwrap_or(0),
            at: now_ms(),
            pinned,
            path,
        },
    );
    remove.extend(trim(&mut history, limit));
    save(&history);
    drop(history);
    for p in remove {
        let _ = std::fs::remove_file(p);
    }
    changed();
}

fn icons() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, String>>> {
    let mut icons = ICONS.lock().unwrap();
    if icons.is_none() {
        let stored = folder().and_then(|d| std::fs::read_to_string(d.join("icons.json")).ok()).and_then(|t| serde_json::from_str(&t).ok());
        *icons = Some(stored.unwrap_or_default());
    }
    icons
}

fn remember_icon(bundle: &str, icon: &str) {
    let mut icons = icons();
    let map = icons.as_mut().expect("loaded");
    if map.get(bundle).map(String::as_str) == Some(icon) {
        return;
    }
    map.insert(bundle.to_string(), icon.to_string());
    if let (Some(dir), Ok(json)) = (folder(), serde_json::to_string(map)) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("icons.json"), json);
    }
}

/// The icons of the apps things were copied from (bundle ID → small PNG, base64).
#[tauri::command]
pub fn clip_icons() -> std::collections::HashMap<String, String> {
    icons().clone().unwrap_or_default()
}

fn rand_u16() -> u16 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.finish() as u16
}

/// The watcher (one thread for the app's life; it only looks while history is on).
pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("clipboard".into())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !CONFIG.lock().unwrap().enabled {
                continue;
            }
            let Ok(lib) = lib() else { continue };
            let count = unsafe { (lib.count)() };
            let seen = SEEN.load(Ordering::SeqCst);
            if count == seen {
                continue;
            }
            SEEN.store(count, Ordering::SeqCst);
            // The first look after turning on: what's already there counts as copied now.
            let Some(dir) = folder() else { continue };
            let Some(c) = capture(lib, &dir) else { continue };
            SEEN.store(c.count, Ordering::SeqCst);
            if c.skip.is_some() {
                continue;
            }
            let skip = {
                let config = CONFIG.lock().unwrap();
                ignored(&config, c.app.as_deref(), c.bundle.as_deref())
            };
            if skip {
                if let Some(p) = &c.path {
                    let _ = std::fs::remove_file(p);
                }
                continue;
            }
            add(c);
        })
        .expect("clipboard thread");
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Settings → Notch → Clipboard: on or off, how many to keep, apps never recorded, and the
/// shortcut that opens it (or none).
#[tauri::command]
pub fn clip_configure(app: AppHandle, enabled: bool, limit: usize, ignore_apps: Vec<String>, shortcut: Option<String>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    load();
    {
        let mut config = CONFIG.lock().unwrap();
        config.enabled = enabled;
        config.limit = limit.clamp(10, 1000);
        config.ignore = ignore_apps.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    }
    {
        let mut history = HISTORY.lock().unwrap();
        let gone = trim(&mut history, limit.clamp(10, 1000));
        if !gone.is_empty() {
            save(&history);
        }
        for p in gone {
            let _ = std::fs::remove_file(p);
        }
    }
    crate::ptt::clip_shortcut(&app, if enabled { shortcut } else { None })
}

#[tauri::command]
pub fn clip_history() -> Vec<ClipItem> {
    load();
    HISTORY.lock().unwrap().clone()
}

/// Puts an item back on the clipboard (it moves to the top) and, with `paste`, pastes it into
/// the app you were in.
#[tauri::command]
pub async fn clip_pick(app: AppHandle, id: String, paste: bool) -> Result<(), String> {
    let lib = lib()?;
    let path = {
        let history = HISTORY.lock().unwrap();
        history.iter().find(|i| i.id == id).map(|i| i.path.clone()).ok_or("That item is gone.")?
    };
    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    let count = tauri::async_runtime::spawn_blocking(move || unsafe { (lib.restore)(c_path.as_ptr()) }).await.map_err(|e| e.to_string())?;
    if count < 0 {
        return Err("Couldn't put it back on the clipboard.".into());
    }
    SEEN.store(count, Ordering::SeqCst);
    {
        let mut history = HISTORY.lock().unwrap();
        if let Some(item) = history.iter_mut().find(|i| i.id == id) {
            item.at = now_ms();
        }
        let limit = CONFIG.lock().unwrap().limit;
        let _ = trim(&mut history, limit);
        save(&history);
    }
    changed();
    if !paste {
        return Ok(());
    }
    if !crate::mac_control::accessibility_granted() {
        return Err("PERMISSION:accessibility".into());
    }
    crate::notch_window::give_back_keyboard(&app);
    tokio::time::sleep(std::time::Duration::from_millis(220)).await;
    if unsafe { (lib.paste_key)() } {
        Ok(())
    } else {
        Err("Couldn't paste".into())
    }
}

#[tauri::command]
pub fn clip_pin(id: String, pinned: bool) {
    let mut history = HISTORY.lock().unwrap();
    if let Some(item) = history.iter_mut().find(|i| i.id == id) {
        item.pinned = pinned;
    }
    save(&history);
    drop(history);
    changed();
}

#[tauri::command]
pub fn clip_delete(id: String) {
    let mut history = HISTORY.lock().unwrap();
    let mut gone = Vec::new();
    history.retain(|i| {
        if i.id == id {
            gone.push(i.path.clone());
            false
        } else {
            true
        }
    });
    save(&history);
    drop(history);
    for p in gone {
        let _ = std::fs::remove_file(p);
    }
    changed();
}

/// Clears the history; pinned items stay unless `pinned_too`.
#[tauri::command]
pub fn clip_clear(pinned_too: bool) {
    let mut history = HISTORY.lock().unwrap();
    let mut gone = Vec::new();
    history.retain(|i| {
        if i.pinned && !pinned_too {
            true
        } else {
            gone.push(i.path.clone());
            false
        }
    });
    save(&history);
    drop(history);
    for p in gone {
        let _ = std::fs::remove_file(p);
    }
    changed();
}

/// The shortcut was pressed: the notch opens on (or closes) its Clipboard tab.
pub(crate) fn shortcut(app: &AppHandle) {
    if crate::notch_window::active() {
        let _ = app.emit_to("notch", "notch-open-clipboard", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, at: u64, pinned: bool) -> ClipItem {
        ClipItem { id: id.into(), kind: "text".into(), text: Some(id.into()), files: vec![], thumb: None, width: None, height: None, app: None, bundle: None, file_icon: false, hash: id.into(), bytes: 1, at, pinned, path: format!("/tmp/{id}.clip") }
    }

    #[test]
    fn trim_keeps_pins_and_newest() {
        let mut h = vec![item("a", 1, true), item("b", 5, false), item("c", 3, false), item("d", 4, false)];
        let gone = trim(&mut h, 2);
        let ids: Vec<&str> = h.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["b", "d", "a"]);
        assert_eq!(gone, ["/tmp/c.clip"]);
    }

    #[test]
    fn ignores_listed_apps() {
        let config = Config { enabled: true, limit: 100, ignore: vec!["1password".into(), "com.apple.keychainaccess".into()] };
        assert!(ignored(&config, Some("1Password"), None));
        assert!(ignored(&config, Some("Keychain Access"), Some("com.apple.keychainaccess")));
        assert!(!ignored(&config, Some("Safari"), Some("com.apple.Safari")));
    }

    #[test]
    fn stored_keeps_the_path() {
        let i = item("x", 9, true);
        let json = serde_json::to_string(&StoredItem::from(&i)).unwrap();
        let back: ClipItem = serde_json::from_str::<StoredItem>(&json).unwrap().into();
        assert_eq!(back.path, "/tmp/x.clip");
        assert!(back.pinned);
        // The notch never gets the path.
        assert!(!serde_json::to_string(&i).unwrap().contains("/tmp/"));
    }

    #[test]
    #[ignore]
    fn captures_this_mac() {
        // Copies a few words and reads them back with the real helper on this Mac.
        let lib = lib().expect("helper");
        let dir = std::env::temp_dir().join("ev-clip-test");
        let _ = std::process::Command::new("/bin/sh").arg("-c").arg("printf 'clipboard test' | pbcopy").status();
        let c = capture(lib, &dir).expect("capture");
        assert_eq!(c.kind.as_deref(), Some("text"));
        assert_eq!(c.text.as_deref(), Some("clipboard test"));
        assert!(c.bundle.is_none() || c.app_icon.is_some(), "the front app's icon comes with it");
        // (Putting it back waits on the main thread, which only the app runs.)
        let path = c.path.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 0);
        let _ = std::fs::remove_file(path);
    }
}
