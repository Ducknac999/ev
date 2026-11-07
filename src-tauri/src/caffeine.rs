//! ☕ Caffeine: keeps the Mac awake. Two levels, like Vorssaint's:
//! - Awake: a power assertion (no password). The Mac never sleeps on its own while it's on.
//! - Lid closed too: `pmset disablesleep 1`, which needs root. Set up once with the admin
//!   password: a sudoers rule that allows exactly `pmset disablesleep 1` / `0` for this user.
//! Crash-safe: a flag file is written *before* sleep is disabled; if E.V quits or crashes with
//! it set, sleep is turned back on at the next launch (and on quit).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(kind: core_foundation::string::CFStringRef, level: u32, name: core_foundation::string::CFStringRef, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

#[derive(serde::Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Caffeine {
    pub on: bool,
    /// Sleep is off even with the lid closed right now.
    pub lid: bool,
    /// The lid-closed permission is set up (no password needed to switch it).
    pub lid_ready: bool,
    /// Turns off by itself at this time (seconds since 1970), if set.
    pub until: Option<u64>,
    /// Turns off by itself below this battery percentage, if set.
    pub battery_limit: Option<u8>,
    /// Why it last turned off by itself ("battery", "timer"), for the notch to say.
    pub ended: Option<String>,
}

static STATE: Mutex<Option<(Caffeine, u32)>> = Mutex::new(None);

fn rule_path(app: &AppHandle) -> String {
    format!("/etc/sudoers.d/{}-clamshell", app.config().identifier.replace('.', "-"))
}

fn flag(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("sleep-disabled.flag"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn pmset_disablesleep(on: bool) -> bool {
    std::process::Command::new("/usr/bin/sudo")
        .args(["-n", "/usr/bin/pmset", "disablesleep", if on { "1" } else { "0" }])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether the rule lets this user switch lid sleep without a password.
fn lid_ready() -> bool {
    std::process::Command::new("/usr/bin/sudo")
        .args(["-n", "-l", "/usr/bin/pmset", "disablesleep", "0"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn install_rule(app: &AppHandle) -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    let path = rule_path(app);
    let rule = format!("#{uid} ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0");
    let command = format!("mkdir -p /etc/sudoers.d && chmod 0755 /etc/sudoers.d && echo '{rule}' > {path} && chmod 0440 {path} && /usr/sbin/visudo -c -f {path} || {{ rm -f {path}; exit 1; }}");
    let script = format!("do shell script \"{command}\" with prompt \"E.V needs your password once so it can keep your Mac awake with the lid closed.\" with administrator privileges");
    let out = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    if out.status.success() && lid_ready() {
        Ok(())
    } else if String::from_utf8_lossy(&out.stderr).contains("-128") {
        Err("Cancelled — the lid-closed mode needs your password once.".into())
    } else {
        Err("Couldn't set up the lid-closed mode.".into())
    }
}

fn assertion() -> u32 {
    let kind = core_foundation::string::CFString::new("PreventUserIdleSystemSleep");
    let name = core_foundation::string::CFString::new("E.V Caffeine");
    let mut id = 0u32;
    use core_foundation::base::TCFType;
    let ok = unsafe { IOPMAssertionCreateWithName(kind.as_concrete_TypeRef(), 255, name.as_concrete_TypeRef(), &mut id) };
    if ok == 0 { id } else { 0 }
}

fn snapshot() -> Caffeine {
    STATE.lock().unwrap().as_ref().map(|(c, _)| c.clone()).unwrap_or_default()
}

fn announce(app: &AppHandle) {
    let _ = app.emit("caffeine-changed", snapshot());
}

/// Turns lid sleep back on (if E.V turned it off) and drops the assertion.
fn release(app: &AppHandle, ended: Option<&str>) {
    let mut restored = true;
    let mut state = STATE.lock().unwrap();
    if let Some((c, id)) = state.as_mut() {
        if *id != 0 {
            unsafe { IOPMAssertionRelease(*id) };
            *id = 0;
        }
        if c.lid {
            restored = pmset_disablesleep(false);
            c.lid = false;
        }
        c.on = false;
        c.until = None;
        c.ended = ended.map(str::to_string);
    }
    drop(state);
    // Kept if sleep couldn't be turned back on, so the next launch tries again.
    if restored {
        if let Some(f) = flag(app) {
            let _ = std::fs::remove_file(f);
        }
    }
}

fn apply(app: &AppHandle, on: bool, lid: bool, minutes: Option<u32>, battery_limit: Option<u8>) -> Result<(), String> {
    if !on {
        release(app, None);
        return Ok(());
    }
    let ready = lid_ready();
    if lid && !ready {
        install_rule(app)?;
    }
    let mut state = STATE.lock().unwrap();
    let (c, id) = state.get_or_insert_with(Default::default);
    if *id == 0 {
        *id = assertion();
    }
    c.on = true;
    c.ended = None;
    c.lid_ready = ready || lid;
    c.battery_limit = battery_limit.filter(|b| *b > 0 && *b < 100);
    c.until = minutes.filter(|m| *m > 0).map(|m| now() + m as u64 * 60);
    if lid && !c.lid {
        // Written first: a crash right after must not leave the Mac unable to sleep.
        if let Some(f) = flag(app) {
            let _ = std::fs::write(f, "1");
        }
        c.lid = pmset_disablesleep(true);
        if !c.lid {
            return Err("Couldn't turn off sleep for the lid-closed mode.".into());
        }
    } else if !lid && c.lid {
        pmset_disablesleep(false);
        c.lid = false;
        if let Some(f) = flag(app) {
            let _ = std::fs::remove_file(f);
        }
    }
    Ok(())
}

/// Battery percentage and whether the Mac runs on battery right now.
fn battery() -> Option<(u8, bool)> {
    let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let on_battery = text.contains("'Battery Power'");
    let percent = text.split('%').next()?.rsplit(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    Some((percent, on_battery))
}

/// At launch: undoes a lid-closed mode left on by a crash. Then watches the timer and battery.
pub fn start(app: AppHandle) {
    if flag(&app).is_some_and(|f| f.exists()) {
        pmset_disablesleep(false);
        if let Some(f) = flag(&app) {
            let _ = std::fs::remove_file(f);
        }
    }
    {
        let mut state = STATE.lock().unwrap();
        state.get_or_insert_with(Default::default).0.lid_ready = lid_ready();
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let c = snapshot();
        if !c.on {
            continue;
        }
        let ended = if c.until.is_some_and(|u| now() >= u) {
            Some("timer")
        } else if let (Some(limit), Some((percent, true))) = (c.battery_limit, battery()) {
            (percent <= limit).then_some("battery")
        } else {
            None
        };
        if let Some(why) = ended {
            release(&app, Some(why));
            announce(&app);
        }
    });
}

/// On quit: sleep works normally again.
pub fn stop(app: &AppHandle) {
    release(app, None);
}

#[tauri::command]
pub async fn caffeine_set(app: AppHandle, on: bool, lid: bool, minutes: Option<u32>, battery_limit: Option<u8>) -> Result<Caffeine, String> {
    let handle = app.clone();
    let result = tokio::task::spawn_blocking(move || apply(&handle, on, lid, minutes, battery_limit)).await.map_err(|e| e.to_string())?;
    announce(&app);
    result.map(|_| snapshot())
}

#[tauri::command]
pub fn caffeine_status() -> Caffeine {
    snapshot()
}

/// Settings → "Remove the lid-closed permission": deletes the sudoers rule (password asked).
#[tauri::command]
pub async fn caffeine_remove_permission(app: AppHandle) -> Result<Caffeine, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        release(&handle, None);
        let path = rule_path(&handle);
        let script = format!("do shell script \"rm -f {path}\" with prompt \"E.V is removing its lid-closed permission.\" with administrator privileges");
        let ok = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).status().map(|s| s.success()).unwrap_or(false);
        if let Some((c, _)) = STATE.lock().unwrap().as_mut() {
            c.lid_ready = lid_ready();
        }
        if ok { Ok(()) } else { Err("Not removed.".to_string()) }
    })
    .await
    .map_err(|e| e.to_string())??;
    announce(&app);
    Ok(snapshot())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_battery() {
        // The real Mac: just checks the parser doesn't panic.
        let _ = super::battery();
    }
}
