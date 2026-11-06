use std::env;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Apps launched from Finder/Dock inherit a minimal PATH. Pull the user's login-shell PATH
/// so locally installed tools (`claude`, `whisper-cli`) resolve exactly as in Terminal.
pub fn hydrate_path() {
    let mut entries: Vec<String> = Vec::new();

    if let Some(shell_path) = login_shell_path() {
        entries.extend(shell_path.split(':').map(str::to_string));
    }
    if let Ok(current) = env::var("PATH") {
        entries.extend(current.split(':').map(str::to_string));
    }
    if let Ok(home) = env::var("HOME") {
        entries.push(format!("{home}/.local/bin"));
        entries.push(format!("{home}/.claude/local"));
        entries.push(format!("{home}/.npm-global/bin"));
        entries.push(format!("{home}/.cargo/bin"));
    }
    entries.extend(
        ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .iter()
            .map(|s| s.to_string()),
    );

    let mut seen = std::collections::HashSet::new();
    let merged: Vec<String> = entries
        .into_iter()
        .filter(|e| !e.is_empty() && seen.insert(e.clone()))
        .collect();
    env::set_var("PATH", merged.join(":"));
}

fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '__GIDEON_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.rsplit_once("__GIDEON_PATH__").map(|(_, p)| p.trim().to_string())
}

/// Locate an executable on the (hydrated) PATH.
pub fn which(binary: &str) -> Option<std::path::PathBuf> {
    let path = env::var("PATH").ok()?;
    path.split(':')
        .map(|dir| std::path::Path::new(dir).join(binary))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0)
                .unwrap_or(false)
        })
}

pub fn home_dir() -> std::path::PathBuf {
    env::var("HOME").map(Into::into).unwrap_or_else(|_| "/".into())
}

pub fn expand_tilde(input: &str) -> std::path::PathBuf {
    match input.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None if input == "~" => home_dir(),
        None => input.into(),
    }
}
