use crate::shell_env::which;
use serde::Serialize;
use tokio::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn claude_status() -> ClaudeStatus {
    let Some(path) = which("claude") else {
        return ClaudeStatus { available: false, path: None, version: None };
    };
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    ClaudeStatus { available: true, path: Some(path.display().to_string()), version }
}

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Percent of the window already used (0–100).
    pub utilization: f64,
    /// RFC 3339 timestamp when the window refills, if the plan reported one.
    pub resets_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
}

fn usage_window(value: &serde_json::Value) -> Option<UsageWindow> {
    let utilization = value.get("utilization")?.as_f64()?;
    let resets_at = value.get("resets_at").and_then(|v| v.as_str()).map(str::to_string);
    Some(UsageWindow { utilization, resets_at })
}

/// Reads the OAuth access token the `claude` CLI keeps in the login keychain. Going through
/// `/usr/bin/security` reuses the CLI's own keychain ACL, so no access prompt appears.
async fn cli_access_token() -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .await
        .map_err(|e| format!("could not read keychain: {e}"))?;
    if !output.status.success() {
        return Err("Claude CLI login not found in Keychain — run `claude` once to sign in".into());
    }
    let raw: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Claude CLI credentials are in an unexpected format".to_string())?;
    raw.pointer("/claudeAiOauth/accessToken")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Claude CLI is not signed in with a Claude plan".into())
}

/// Fetches the plan's 5-hour and weekly usage — the same numbers `/usage` shows in the CLI.
#[tauri::command]
pub async fn claude_usage() -> Result<ClaudeUsage, String> {
    let token = cli_access_token().await?;
    let response = reqwest::Client::new()
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/gideon")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("usage request failed: {e}"))?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err("Claude sign-in expired — send any Claude message to refresh it".into());
    }
    if !status.is_success() {
        return Err(format!("usage request returned HTTP {}", status.as_u16()));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(ClaudeUsage {
        five_hour: body.get("five_hour").and_then(usage_window),
        seven_day: body.get("seven_day").and_then(usage_window),
    })
}
