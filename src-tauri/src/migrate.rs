//! "Move my E.V into this app": a one-time move from the personal build (com.gideon.multichat)
//! into this one. It runs at launch, before any window exists, when a marker asks for it: the old
//! app is quit, its data copied (never moved, so the old app still works as a fallback), its
//! keychain secrets copied under this app's names, and its terminal server kept, so open Claude
//! and terminal sessions carry on. Then the start window opens at Permissions, since macOS asks
//! again for a new app.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const OLD_ID: &str = "com.gideon.multichat";
const NEW_ID: &str = "com.ducknac.ev";
const MARKER: &str = "move-from-gideon";

fn support(id: &str) -> PathBuf {
    crate::shell_env::home_dir().join("Library/Application Support").join(id)
}

fn webkit(id: &str) -> PathBuf {
    crate::shell_env::home_dir().join("Library/WebKit").join(id).join("WebsiteData")
}

/// Whether there's a personal E.V on this Mac to move from.
pub fn available() -> bool {
    support(OLD_ID).join("settings.json").exists()
}

/// Asks for the move at the next launch.
pub fn request() -> Result<(), String> {
    if !available() {
        return Err("There's no other E.V on this Mac to move from.".into());
    }
    let dir = support(NEW_ID);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MARKER), b"1").map_err(|e| e.to_string())
}

fn copy_dir(from: &Path, to: &Path) {
    if from.exists() {
        let _ = std::fs::create_dir_all(to);
        let _ = Command::new("/usr/bin/ditto").arg(from).arg(to).status();
    }
}

fn secret(service: &str, account: &str) -> Option<String> {
    let out = Command::new("/usr/bin/security").args(["find-generic-password", "-s", service, "-a", account, "-w"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}

fn copy_secret(old_service: &str, new_service: &str, account: &str) {
    if let Some(value) = secret(old_service, account) {
        let _ = Command::new("/usr/bin/security").args(["add-generic-password", "-U", "-s", new_service, "-a", account, "-w", &value]).status();
    }
}

/// Accounts saved under a keychain service (connection secrets have one per connection).
fn accounts(service: &str) -> Vec<String> {
    let Ok(out) = Command::new("/usr/bin/security").arg("dump-keychain").output() else { return Vec::new() };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut found = Vec::new();
    for item in text.split("keychain: ") {
        if !item.contains(&format!("\"svce\"<blob>=\"{service}\"")) {
            continue;
        }
        if let Some(rest) = item.split("\"acct\"<blob>=\"").nth(1) {
            if let Some(account) = rest.split('"').next() {
                found.push(account.to_string());
            }
        }
    }
    found
}

/// Runs a requested move. Called first thing at launch.
pub fn run_if_requested() {
    let new_dir = support(NEW_ID);
    let marker = new_dir.join(MARKER);
    if !marker.exists() {
        return;
    }
    let _ = std::fs::remove_file(&marker);
    if !available() {
        return;
    }
    // The old app must be closed so its chats are fully written; its terminal server keeps running.
    let _ = Command::new("/usr/bin/osascript").args(["-e", &format!("quit app id \"{OLD_ID}\"")]).status();
    for _ in 0..20 {
        let running = Command::new("/usr/bin/pgrep").args(["-x", "gideon"]).output().map(|o| o.status.success()).unwrap_or(false);
        if !running {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = Command::new("/usr/bin/pkill").args(["-x", "gideon"]).status();
    std::thread::sleep(Duration::from_millis(400));

    copy_dir(&support(OLD_ID), &new_dir);
    let _ = std::fs::remove_file(new_dir.join("tmux.conf")); // rewritten with this app's paths
    copy_dir(&webkit(OLD_ID), &webkit(NEW_ID));

    for (old, new, account) in [("Gideon Vault Key", "E.V Vault Key", "vault"), ("Gideon Voice Approval", "E.V Voice Approval", "passphrase")] {
        copy_secret(old, new, account);
    }
    for account in accounts("Gideon Connections") {
        copy_secret("Gideon Connections", "E.V Connections", &account);
    }

    // Open sessions live on the old app's terminal server: keep using it.
    let _ = std::fs::write(new_dir.join("tmux-server"), b"gideon");

    // The start window opens at Permissions (macOS asks again for a new app); everything else is set.
    let settings_path = new_dir.join("settings.json");
    if let Ok(text) = std::fs::read_to_string(&settings_path) {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) {
            value["onboarded"] = serde_json::Value::Bool(false);
            value["onboardStart"] = serde_json::Value::from(4);
            value["movedFromPersonal"] = serde_json::Value::Bool(true);
            if let Ok(out) = serde_json::to_string_pretty(&value) {
                let _ = std::fs::write(&settings_path, out);
            }
        }
    }
}

#[tauri::command]
pub fn move_from_personal_available() -> bool {
    available()
}

/// Asks for the move and restarts into it.
#[tauri::command]
pub fn move_from_personal(app: tauri::AppHandle) -> Result<(), String> {
    request()?;
    app.restart();
}
