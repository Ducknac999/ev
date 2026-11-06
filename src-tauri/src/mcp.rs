//! Connections: E.V's MCP client. Only servers from the checked catalog below can be started —
//! the web view can't run anything else — each pinned to an exact version. Account keys live in
//! the Keychain ("E.V Connections"); the web view can save or delete them but never read them.
//! A connection that isn't switched on is never started, so its tools don't exist for any AI.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const KEYCHAIN_SERVICE: &str = "E.V Connections";

pub struct Secret {
    pub env: &'static str,
    pub label: &'static str,
}

pub struct Entry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// What the user needs before connecting (None: nothing, connect and go).
    pub account: Option<&'static str>,
    pub setup_url: Option<&'static str>,
    pub secrets: &'static [Secret],
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub env: &'static [(&'static str, &'static str)],
    pub source: &'static str,
    /// Run once before starting (e.g. download the browser engine); quick when already done.
    pub prepare: &'static [&'static str],
    /// Tools never offered or callable (e.g. "run any code").
    pub hidden: &'static [&'static str],
}

pub const CATALOG: &[Entry] = &[
    Entry {
        id: "browser",
        name: "E.V's browser (Playwright)",
        description: "E.V's own browser, by Microsoft: researches, reads and clicks through websites in the background without touching your Vivaldi tabs.",
        account: None,
        setup_url: None,
        secrets: &[],
        program: "npx",
        args: &["-y", "@playwright/mcp@0.0.83", "--headless", "--browser", "chromium", "--user-data-dir", "{data}/browser-profile", "--output-dir", "{data}/browser-output"],
        env: &[],
        source: "github.com/microsoft/playwright-mcp",
        prepare: &["-y", "@playwright/mcp@0.0.83", "install-browser", "chrome-for-testing"],
        hidden: &["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload"],
    },
    Entry {
        id: "google",
        name: "Google — Gmail, Calendar, Drive, Docs",
        description: "Read and draft email, see and add calendar events, find and read Drive files and Docs. Sending email always shows a preview first.",
        account: Some("Your Google account plus a free OAuth client from Google Cloud (Desktop app type). Sign-in opens in your browser the first time."),
        setup_url: Some("https://github.com/taylorwilsdon/google_workspace_mcp#-quick-start"),
        secrets: &[
            Secret { env: "GOOGLE_OAUTH_CLIENT_ID", label: "OAuth client ID" },
            Secret { env: "GOOGLE_OAUTH_CLIENT_SECRET", label: "OAuth client secret" },
        ],
        program: "uvx",
        args: &["workspace-mcp==2.1.0", "--tools", "gmail", "calendar", "drive", "docs", "sheets"],
        env: &[("OAUTHLIB_INSECURE_TRANSPORT", "1")],
        source: "github.com/taylorwilsdon/google_workspace_mcp",
        prepare: &[],
        hidden: &[],
    },
    Entry {
        id: "apple",
        name: "Apple apps — Notes, Reminders, Calendar, Contacts",
        description: "Read and add notes, reminders and events, and look up contacts. macOS asks once for each app the first time.",
        account: None,
        setup_url: None,
        secrets: &[],
        program: "npx",
        args: &["-y", "mcp-macos@4.1.0"],
        env: &[],
        source: "github.com/krmj22/macos-mcp",
        prepare: &[],
        hidden: &[],
    },
    Entry {
        id: "youtube",
        name: "YouTube transcripts",
        description: "Reads a video's transcript so E.V can summarise it or answer questions about it.",
        account: None,
        setup_url: None,
        secrets: &[],
        program: "npx",
        args: &["-y", "@kimtaeyoon83/mcp-server-youtube-transcript@0.1.1"],
        env: &[],
        source: "github.com/kimtaeyoon83/mcp-server-youtube-transcript",
        prepare: &[],
        hidden: &[],
    },
    Entry {
        id: "context7",
        name: "Context7 — coding docs",
        description: "Up-to-date documentation for programming libraries, so coding answers use current APIs.",
        account: None,
        setup_url: None,
        secrets: &[],
        program: "npx",
        args: &["-y", "@upstash/context7-mcp@4.3.0"],
        env: &[],
        source: "github.com/upstash/context7",
        prepare: &[],
        hidden: &[],
    },
    Entry {
        id: "github",
        name: "GitHub",
        description: "Repositories, issues and pull requests. Creating or merging always asks first.",
        account: Some("A GitHub account and a personal access token (Settings → Developer settings → Fine-grained tokens)."),
        setup_url: Some("https://github.com/settings/personal-access-tokens/new"),
        secrets: &[Secret { env: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "Personal access token" }],
        program: "npx",
        args: &["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: &[],
        source: "github.com/modelcontextprotocol/servers-archived",
        prepare: &[],
        hidden: &[],
    },
    Entry {
        id: "notion",
        name: "Notion",
        description: "Search, read and write the pages you share with the integration.",
        account: Some("A Notion account and an internal integration token, with your pages shared to it."),
        setup_url: Some("https://www.notion.so/profile/integrations"),
        secrets: &[Secret { env: "NOTION_TOKEN", label: "Integration token" }],
        program: "npx",
        args: &["-y", "@notionhq/notion-mcp-server@2.5.2"],
        env: &[],
        source: "github.com/makenotion/notion-mcp-server",
        prepare: &[],
        hidden: &[],
    },
];

fn entry(id: &str) -> Result<&'static Entry, String> {
    CATALOG.iter().find(|e| e.id == id).ok_or_else(|| format!("unknown connection {id}"))
}

fn data_dir() -> std::path::PathBuf {
    crate::shell_env::home_dir().join("Library/Application Support/com.ducknac.ev")
}

// ── Keychain ──────────────────────────────────────────────────────────────────

async fn secret(id: &str, env: &str) -> Option<String> {
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", &format!("{id}:{env}"), "-w"])
        .output()
        .await
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn connection_set_secret(id: String, env: String, value: String) -> Result<(), String> {
    let e = entry(&id)?;
    if !e.secrets.iter().any(|s| s.env == env) {
        return Err("unknown key for this connection".into());
    }
    let value = value.trim();
    if value.is_empty() {
        return Err("empty value".into());
    }
    let status = Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", &format!("{id}:{env}"), "-w", value])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    status.success().then_some(()).ok_or_else(|| "Could not save to the Keychain".into())
}

#[tauri::command]
pub async fn connection_forget_secrets(id: String) -> Result<(), String> {
    for s in entry(&id)?.secrets {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", &format!("{id}:{}", s.env)])
            .output()
            .await;
    }
    Ok(())
}

// ── Catalog for the Settings page ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    env: &'static str,
    label: &'static str,
    saved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInfo {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    account: Option<&'static str>,
    setup_url: Option<&'static str>,
    source: &'static str,
    secrets: Vec<SecretInfo>,
    /// The program it needs (npx or uvx) is installed.
    runnable: bool,
    running: bool,
}

#[tauri::command]
pub async fn connections_catalog() -> Vec<CatalogInfo> {
    let running = SERVERS.lock().await.keys().cloned().collect::<Vec<_>>();
    let mut out = Vec::new();
    for e in CATALOG {
        let mut secrets = Vec::new();
        for s in e.secrets {
            secrets.push(SecretInfo { env: s.env, label: s.label, saved: secret(e.id, s.env).await.is_some() });
        }
        out.push(CatalogInfo {
            id: e.id,
            name: e.name,
            description: e.description,
            account: e.account,
            setup_url: e.setup_url,
            source: e.source,
            secrets,
            runnable: crate::shell_env::which(e.program).is_some(),
            running: running.iter().any(|r| r == e.id),
        });
    }
    out
}

// ── Running servers ───────────────────────────────────────────────────────────

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Server {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    tools: Vec<Value>,
}

static SERVERS: std::sync::LazyLock<Mutex<HashMap<String, Server>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

async fn request(stdin: &mut ChildStdin, pending: &Pending, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id, tx);
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string() + "\n";
    stdin.write_all(line.as_bytes()).await.map_err(|e| format!("connection stopped: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("connection stopped".into()),
        Err(_) => {
            pending.lock().await.remove(&id);
            Err(format!("{method} timed out"))
        }
    }
}

async fn notify(stdin: &mut ChildStdin, method: &str) -> Result<(), String> {
    let line = json!({ "jsonrpc": "2.0", "method": method }).to_string() + "\n";
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    name: String,
    description: String,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
}

fn tool_list(tools: &[Value]) -> Vec<McpTool> {
    tools
        .iter()
        .filter_map(|t| {
            Some(McpTool {
                name: t.get("name")?.as_str()?.to_string(),
                description: t.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                input_schema: t.get("inputSchema").cloned().unwrap_or(json!({ "type": "object", "properties": {} })),
                read_only: t.pointer("/annotations/readOnlyHint").and_then(Value::as_bool).unwrap_or(false),
                destructive: t.pointer("/annotations/destructiveHint").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// Starts a connection (if not running) and returns its tools.
#[tauri::command]
pub async fn connection_start(id: String) -> Result<Vec<McpTool>, String> {
    if let Some(server) = SERVERS.lock().await.get(&id) {
        return Ok(tool_list(&server.tools));
    }
    let e = entry(&id)?;
    let program = crate::shell_env::which(e.program).ok_or_else(|| format!("`{}` isn't installed", e.program))?;
    let data = data_dir();
    let _ = std::fs::create_dir_all(&data);
    let mut cmd = Command::new(program);
    cmd.args(e.args.iter().map(|a| a.replace("{data}", &data.display().to_string())))
        .current_dir(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (k, v) in e.env {
        cmd.env(k, v);
    }
    for s in e.secrets {
        let value = secret(e.id, s.env).await.ok_or_else(|| format!("{} isn't saved yet", s.label))?;
        cmd.env(s.env, value);
    }
    if !e.prepare.is_empty() {
        let prepared = tokio::time::timeout(
            Duration::from_secs(600),
            Command::new(crate::shell_env::which(e.program).unwrap()).args(e.prepare).current_dir(&data).stdin(Stdio::null()).output(),
        )
        .await
        .map_err(|_| format!("{} setup took too long", e.name))?
        .map_err(|err| err.to_string())?;
        if !prepared.status.success() {
            return Err(format!("{} setup failed", e.name));
        }
    }
    let mut child = cmd.spawn().map_err(|err| format!("couldn't start {}: {err}", e.name))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let pending: Pending = Arc::default();

    let reader_pending = pending.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
            if let Some(tx) = reader_pending.lock().await.remove(&id) {
                let result = match msg.get("error") {
                    Some(err) => Err(err.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
        }
        // Server exited: fail anything still waiting.
        for (_, tx) in reader_pending.lock().await.drain() {
            let _ = tx.send(Err("connection stopped".into()));
        }
    });

    // First start may download the package: allow time.
    request(
        &mut stdin,
        &pending,
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "E.V", "version": "1.0.0" } }),
        Duration::from_secs(180),
    )
    .await?;
    notify(&mut stdin, "notifications/initialized").await?;
    let listed = request(&mut stdin, &pending, "tools/list", json!({}), Duration::from_secs(30)).await?;
    let tools: Vec<Value> = listed
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| !e.hidden.contains(&t.get("name").and_then(Value::as_str).unwrap_or("")))
        .collect();
    let out = tool_list(&tools);
    SERVERS.lock().await.insert(id, Server { child, stdin, pending, tools });
    Ok(out)
}

#[tauri::command]
pub async fn connection_stop(id: String) -> Result<(), String> {
    if let Some(mut server) = SERVERS.lock().await.remove(&id) {
        let _ = server.child.kill().await;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct CallResult {
    text: String,
    images: Vec<String>,
    error: bool,
}

/// Calls one tool on a running connection. Approval rules were already applied by the caller.
#[tauri::command]
pub async fn connection_call(id: String, tool: String, args: Value) -> Result<CallResult, String> {
    let (call_id, reply, pending) = {
        let mut servers = SERVERS.lock().await;
        let server = servers.get_mut(&id).ok_or("That connection isn't running — it may be switched off")?;
        if !server.tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(tool.as_str())) {
            return Err(format!("{tool} isn't a tool of this connection"));
        }
        // The server lock is held only while writing; the reply arrives on the reader task.
        let call_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        server.pending.lock().await.insert(call_id, tx);
        let line = json!({ "jsonrpc": "2.0", "id": call_id, "method": "tools/call", "params": { "name": tool, "arguments": args } }).to_string() + "\n";
        server.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("connection stopped: {e}"))?;
        server.stdin.flush().await.map_err(|e| e.to_string())?;
        (call_id, rx, server.pending.clone())
    };
    let result = match tokio::time::timeout(Duration::from_secs(120), reply).await {
        Ok(Ok(r)) => r?,
        Ok(Err(_)) => return Err("connection stopped".into()),
        Err(_) => {
            pending.lock().await.remove(&call_id);
            return Err("the connection took too long".into());
        }
    };
    let mut text = Vec::new();
    let mut images = Vec::new();
    for item in result.get("content").and_then(Value::as_array).cloned().unwrap_or_default() {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => text.push(item.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            Some("image") => {
                if let Some(data) = item.get("data").and_then(Value::as_str) {
                    images.push(data.to_string());
                }
            }
            Some("resource") => text.push(item.pointer("/resource/text").and_then(Value::as_str).unwrap_or("").to_string()),
            _ => {}
        }
    }
    Ok(CallResult { text: text.join("\n"), images, error: result.get("isError").and_then(Value::as_bool).unwrap_or(false) })
}

/// Quitting E.V stops every connection.
pub fn stop_all() {
    if let Ok(mut servers) = SERVERS.try_lock() {
        for (_, mut server) in servers.drain() {
            let _ = server.child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_pinned_and_unique() {
        let mut ids = std::collections::HashSet::new();
        for e in CATALOG {
            assert!(ids.insert(e.id), "duplicate {}", e.id);
            let package = e.args.iter().find(|a| a.contains('@') || a.contains("==")).expect("a package");
            assert!(package.contains("@0") || package.contains("@1") || package.contains("@2") || package.contains("@4") || package.contains("=="), "{} must pin a version: {package}", e.id);
        }
    }

    #[test]
    fn only_catalog_entries_can_start() {
        assert!(entry("rm -rf").is_err());
        assert!(entry("browser").is_ok());
    }

    /// Real start of a no-account connection (network: downloads the package once).
    #[tokio::test]
    #[ignore]
    async fn youtube_connection_lists_its_tool() {
        crate::shell_env::hydrate_path();
        let tools = connection_start("youtube".into()).await.unwrap();
        assert!(tools.iter().any(|t| t.name.contains("transcript")), "{:?}", tools.iter().map(|t| &t.name).collect::<Vec<_>>());
        connection_stop("youtube".into()).await.unwrap();
    }
}
