//! E.V's chat list on disk, built to survive crashes.
//!
//! The list lives in `<app data>/chats/workspace.json`. Every save goes to a temporary file that is
//! flushed and then renamed over the old one, so a crash mid-save leaves the previous complete
//! copy. Backups: one at every launch (last 10), hourly (last 24), daily (last 7), and a copy taken
//! before any save that would drop most of the chats (last 20). A file that can't be read is moved
//! aside, never overwritten, and the newest good backup is loaded instead.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const FILE: &str = "workspace.json";
const KEEP_LAUNCH: usize = 10;
const KEEP_HOURLY: usize = 24;
const KEEP_DAILY: usize = 7;
const KEEP_DROP: usize = 20;

/// Chat count of the copy on disk (None until the first load or save this run).
static ON_DISK: Mutex<Option<usize>> = Mutex::new(None);
/// The launch backup is taken once per run (the notch and popups load the list too).
static LAUNCH_BACKED_UP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Set while a backup is being put back, so the closing window can't save over it.
static SAVES_BLOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stops all saves until E.V restarts (used by a restore).
pub fn block_saves() {
    SAVES_BLOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("chats");
    fs::create_dir_all(dir.join("backups")).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn stamp() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    ms.to_string()
}

/// Number of chats in a saved workspace, or None when it isn't a readable save.
fn chat_count(text: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("state")?.get("chats")?.as_array().map(Vec::len)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Backups of one kind (`<kind>-<millis>.json`), newest first.
fn backups(dir: &Path, kind: &str) -> Vec<PathBuf> {
    let prefix = format!("{kind}-");
    let mut list: Vec<(u128, PathBuf)> = fs::read_dir(dir.join("backups"))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let ms = name.strip_prefix(&prefix)?.strip_suffix(".json")?.parse::<u128>().ok()?;
                    Some((ms, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.into_iter().map(|(_, p)| p).collect()
}

fn backup(dir: &Path, kind: &str, keep: usize, text: &str) {
    let path = dir.join("backups").join(format!("{kind}-{}.json", stamp()));
    if write_atomic(&path, text).is_ok() {
        for old in backups(dir, kind).into_iter().skip(keep) {
            let _ = fs::remove_file(old);
        }
    }
}

fn age(path: &Path) -> Duration {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).unwrap_or(Duration::MAX)
}

/// Keeps an hourly and a daily copy of the current file.
fn rolling(dir: &Path, text: &str) {
    for (kind, keep, every) in [("hourly", KEEP_HOURLY, 3600), ("daily", KEEP_DAILY, 86_400)] {
        let due = backups(dir, kind).first().map_or(true, |p| age(p) >= Duration::from_secs(every));
        if due {
            backup(dir, kind, keep, text);
        }
    }
}

/// Newest backup (any kind) that holds a readable list with at least one chat.
fn newest_good_backup(dir: &Path) -> Option<String> {
    let mut all: Vec<PathBuf> = ["launch", "hourly", "daily", "drop"].iter().flat_map(|k| backups(dir, k)).collect();
    all.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH)));
    all.into_iter().filter_map(|p| fs::read_to_string(p).ok()).find(|t| chat_count(t).is_some_and(|n| n > 0))
}

/// The saved chat list, or None when there's none yet (the app then moves the old browser-storage
/// copy over). A damaged file is moved aside and the newest good backup is returned instead.
#[tauri::command]
pub fn chats_load(app: AppHandle) -> Result<Option<String>, String> {
    let dir = dir(&app)?;
    let path = dir.join(FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let restored = newest_good_backup(&dir);
            *ON_DISK.lock().unwrap() = restored.as_deref().and_then(chat_count);
            return Ok(restored);
        }
        Err(e) => return Err(e.to_string()),
    };
    match chat_count(&text) {
        Some(n) => {
            if !LAUNCH_BACKED_UP.swap(true, std::sync::atomic::Ordering::SeqCst) {
                backup(&dir, "launch", KEEP_LAUNCH, &text);
            }
            *ON_DISK.lock().unwrap() = Some(n);
            Ok(Some(text))
        }
        None => {
            let _ = fs::rename(&path, dir.join(format!("damaged-{}.json", stamp())));
            let restored = newest_good_backup(&dir);
            *ON_DISK.lock().unwrap() = restored.as_deref().and_then(chat_count);
            Ok(restored)
        }
    }
}

/// Saves the chat list. Refuses anything that isn't a complete list; a save that drops most of the
/// chats at once keeps a copy of the previous list first.
#[tauri::command]
pub fn chats_save(app: AppHandle, value: String) -> Result<(), String> {
    if SAVES_BLOCKED.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let count = chat_count(&value).ok_or("not a complete chat list")?;
    let dir = dir(&app)?;
    let path = dir.join(FILE);
    let before = *ON_DISK.lock().unwrap();
    if let Some(old) = before {
        let big_drop = (old > 0 && count == 0) || (old >= 4 && count * 2 < old);
        if big_drop {
            if let Ok(previous) = fs::read_to_string(&path) {
                backup(&dir, "drop", KEEP_DROP, &previous);
            }
        }
    }
    write_atomic(&path, &value)?;
    *ON_DISK.lock().unwrap() = Some(count);
    rolling(&dir, &value);
    Ok(())
}

/// Marks this run as started; returns true when the previous run ended without quitting normally
/// (a crash or a force quit), so the app can say everything was restored.
#[tauri::command]
pub fn chats_previous_run_crashed(app: AppHandle) -> bool {
    let Ok(dir) = dir(&app) else { return false };
    let marker = dir.join("running");
    let crashed = marker.exists();
    let _ = fs::write(&marker, now().to_string());
    crashed
}

/// Called when E.V quits normally.
pub fn mark_clean_exit(app: &AppHandle) {
    if let Ok(dir) = dir(app) {
        let _ = fs::remove_file(dir.join("running"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_complete_lists() {
        assert_eq!(chat_count(r#"{"state":{"chats":[{},{}]},"version":5}"#), Some(2));
        assert_eq!(chat_count(r#"{"state":{}}"#), None);
        assert_eq!(chat_count("{\"state\":{\"chats\":["), None);
    }
}
