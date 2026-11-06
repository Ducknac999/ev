//! The start window's helpers: which coding agents and local-model runner are installed, installing
//! them with their official installers, checking an API key (by reading the provider's model list),
//! and the microphone and browser permissions. Every install is a fixed command; nothing typed by the
//! user or the AI is run here.

use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
pub struct Tools {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub ollama: Option<String>,
    pub ollama_running: bool,
    pub npm: bool,
    pub brew: bool,
    /// This Mac's memory in GB (which local models fit).
    pub memory_gb: f64,
}

fn memory_gb() -> f64 {
    let out = Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output().ok();
    out.and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok()).map(|b| (b / 1_073_741_824.0).round()).unwrap_or(0.0)
}

fn found(binary: &str, extra: &[&str]) -> Option<String> {
    if let Some(path) = crate::shell_env::which(binary) {
        return Some(path.display().to_string());
    }
    let home = crate::shell_env::home_dir();
    extra.iter().map(|p| crate::shell_env::expand_tilde(p)).find(|p| p.is_file()).map(|p| p.display().to_string()).or_else(|| {
        let local = home.join(".local/bin").join(binary);
        local.is_file().then(|| local.display().to_string())
    })
}

fn ollama_up() -> bool {
    std::net::TcpStream::connect_timeout(&"127.0.0.1:11434".parse().unwrap(), Duration::from_millis(300)).is_ok()
}

#[tauri::command]
pub fn onboard_tools() -> Tools {
    Tools {
        claude: found("claude", &["~/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]),
        codex: found("codex", &["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]),
        ollama: found("ollama", &["/Applications/Ollama.app/Contents/Resources/ollama", "~/Applications/Ollama.app/Contents/Resources/ollama", "/opt/homebrew/bin/ollama"]),
        ollama_running: ollama_up(),
        npm: crate::shell_env::which("npm").is_some(),
        brew: crate::shell_env::which("brew").is_some() || std::path::Path::new("/opt/homebrew/bin/brew").exists(),
        memory_gb: memory_gb(),
    }
}

/// The official way to install each one, as a login shell would run it.
fn script(name: &str) -> Result<&'static str, String> {
    Ok(match name {
        "claude" => "curl -fsSL https://claude.ai/install.sh | bash",
        "codex" => {
            "if command -v npm >/dev/null; then npm install -g @openai/codex; \
             elif command -v brew >/dev/null || [ -x /opt/homebrew/bin/brew ]; then PATH=/opt/homebrew/bin:$PATH brew install --cask codex; \
             else echo 'Codex needs Node.js (nodejs.org) or Homebrew (brew.sh) first.' >&2; exit 2; fi"
        }
        // Ollama's own Mac app (it runs the local server), into Applications.
        "ollama" => {
            "set -e; T=$(mktemp -d); curl -fsSL -o \"$T/Ollama.zip\" https://ollama.com/download/Ollama-darwin.zip; \
             D=/Applications; [ -w \"$D\" ] || { D=\"$HOME/Applications\"; mkdir -p \"$D\"; }; \
             rm -rf \"$D/Ollama.app\"; ditto -xk \"$T/Ollama.zip\" \"$D\"; rm -rf \"$T\"; \
             xattr -dr com.apple.quarantine \"$D/Ollama.app\" 2>/dev/null || true; open -g \"$D/Ollama.app\""
        }
        _ => return Err(format!("unknown tool {name}")),
    })
}

/// Installs Claude Code, Codex or Ollama. Returns the last lines of the installer's output.
#[tauri::command]
pub async fn onboard_install(name: String) -> Result<String, String> {
    let command = script(&name)?.to_string();
    tokio::task::spawn_blocking(move || {
        let out = Command::new("/bin/zsh").args(["-lc", &command]).output().map_err(|e| e.to_string())?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let tail: Vec<&str> = text.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        if out.status.success() {
            if name == "ollama" {
                // Its server takes a few seconds to come up after the first launch.
                for _ in 0..30 {
                    if ollama_up() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
            Ok(tail.join("\n"))
        } else {
            Err(tail.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A provider's model list (`GET <base>/models`): proves the key works and fills the model menu.
#[tauri::command]
pub async fn provider_models(base: String, key: String, provider: String) -> Result<Vec<String>, String> {
    let base = base.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("https://") || base.starts_with("http://localhost") || base.starts_with("http://127.0.0.1")) {
        return Err("the address has to start with https:// (or be a local server)".into());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let url = if provider == "gemini" { format!("{base}/models?key={}", key.trim()) } else { format!("{base}/models") };
    let mut request = client.get(&url).header("Accept", "application/json");
    if provider == "anthropic" {
        request = request.header("x-api-key", key.trim()).header("anthropic-version", "2023-06-01");
    } else if provider != "gemini" && !key.trim().is_empty() {
        request = request.bearer_auth(key.trim());
    }
    let response = request.send().await.map_err(|e| format!("couldn't reach it: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let message = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).or_else(|| body["message"].as_str()).unwrap_or("rejected");
        return Err(if status.as_u16() == 401 || status.as_u16() == 403 { format!("that key was rejected ({message})") } else { format!("HTTP {}: {message}", status.as_u16()) });
    }
    let list = body["data"].as_array().or_else(|| body["models"].as_array()).cloned().unwrap_or_default();
    let mut ids: Vec<String> = list
        .iter()
        .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).or_else(|| m["model"].as_str()))
        .map(|id| id.trim_start_matches("models/").to_string())
        .collect();
    ids.dedup();
    Ok(ids)
}

#[derive(Serialize)]
pub struct MorePermissions {
    /// "granted", "denied" or "unknown" (never asked).
    pub microphone: String,
}

fn microphone_status() -> String {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    // AVFoundation isn't linked into E.V; load it so its class is there to ask.
    unsafe { libc::dlopen(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation".as_ptr(), libc::RTLD_LAZY) };
    let Some(class) = AnyClass::get(c"AVCaptureDevice") else { return "unknown".into() };
    let Some(ns_string) = AnyClass::get(c"NSString") else { return "unknown".into() };
    let media: *mut AnyObject = unsafe { msg_send![ns_string, stringWithUTF8String: c"soun".as_ptr()] };
    let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: media] };
    match status {
        3 => "granted",
        1 | 2 => "denied",
        _ => "unknown",
    }
    .into()
}

#[tauri::command]
pub fn onboard_permissions() -> MorePermissions {
    MorePermissions { microphone: microphone_status() }
}

/// Asks for the microphone: macOS shows its prompt the first time anything listens.
#[tauri::command]
pub fn onboard_request_microphone() {
    std::thread::spawn(|| {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let Some(device) = cpal::default_host().default_input_device() else { return };
        let Ok(config) = device.default_input_config() else { return };
        if let Ok(stream) = device.build_input_stream(&config.into(), |_: &[f32], _: &_| {}, |_| {}, None) {
            let _ = stream.play();
            std::thread::sleep(Duration::from_millis(800));
        }
    });
    let _ = Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone").spawn();
}

/// Asks to control a browser (macOS "Automation"): the prompt appears the first time E.V talks to it.
#[tauri::command]
pub async fn onboard_request_automation(app: String) -> Result<bool, String> {
    let app = app.replace('"', "");
    tokio::task::spawn_blocking(move || {
        let out = Command::new("/usr/bin/osascript").args(["-e", &format!("tell application \"{app}\" to get name")]).output().map_err(|e| e.to_string())?;
        Ok(out.status.success())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// This repository's releases, newest first: what each version changed (Settings → Updates).
#[derive(Serialize)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub date: String,
}

pub const REPO: &str = "Ducknac999/ev";

#[tauri::command]
pub async fn update_releases() -> Result<Vec<Release>, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let response = client
        .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=30"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "E.V updater")
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    if response.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status().as_u16()));
    }
    let list: Vec<serde_json::Value> = response.json().await.map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .filter(|r| r["draft"] != true && r["prerelease"] != true)
        .map(|r| Release {
            version: r["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string(),
            name: r["name"].as_str().unwrap_or("").to_string(),
            notes: r["body"].as_str().unwrap_or("").to_string(),
            date: r["published_at"].as_str().unwrap_or("").chars().take(10).collect(),
        })
        .collect())
}
