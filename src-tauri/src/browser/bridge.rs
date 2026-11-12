//! The E.V extension's line to E.V, for browsers that can't run E.V's page agent themselves
//! (Firefox and its relatives, Chromium browsers without scripting).
//!
//! A WebSocket on 127.0.0.1 only. Web pages can't use it: the handshake must come from an
//! extension page (chrome-extension://, moz-extension://…) and then carry the secret written into
//! the extension E.V installed. Which browser a connection belongs to is read from the process at
//! the other end of the socket, so it works the same for a browser made yesterday.
//!
//! E.V → extension: {id, op:"page", tab, request}
//! extension → E.V: {type:"hello", token, ua} · {id, ok, result | error} · {type:"ping"}

use super::BrowserInfo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;

pub const PORTS: &[u16] = &[47615, 47616, 47617, 47618, 47619];
const EXTENSION_ID_GECKO: &str = "extension@ev.ducknac.com";

const MANIFEST: &str = include_str!("extension/manifest.json");
const BACKGROUND: &str = include_str!("extension/background.js");

struct Conn {
    id: u64,
    /// The browser app (…/Firefox.app) at the other end of the socket.
    app_path: String,
    app_name: String,
    tx: mpsc::UnboundedSender<String>,
}

static CONNS: Mutex<Vec<Conn>> = Mutex::new(Vec::new());
static PENDING: Mutex<Option<HashMap<u64, std::sync::mpsc::Sender<Result<Value, String>>>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);
static TOKEN: Mutex<Option<String>> = Mutex::new(None);
static PORT: Mutex<Option<u16>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn random_hex(bytes: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_err() {
        let seed = format!("{:?}{}", std::time::SystemTime::now(), std::process::id());
        use sha2::Digest;
        buf = sha2::Sha256::digest(seed.as_bytes())[..bytes.min(32)].to_vec();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The secret the installed extension carries; kept on disk so an installed extension keeps working.
fn token(dir: &Path) -> String {
    if let Some(t) = lock(&TOKEN).clone() {
        return t;
    }
    let file = dir.join("token");
    let t = std::fs::read_to_string(&file).ok().map(|s| s.trim().to_string()).filter(|s| s.len() >= 32).unwrap_or_else(|| {
        let t = random_hex(24);
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&file, &t);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
        t
    });
    *lock(&TOKEN) = Some(t.clone());
    t
}

pub fn extension_dir(app_data: &Path) -> PathBuf {
    app_data.join("browser-extension")
}

/// The top-level app of a process (a browser's extension host is a helper inside its bundle).
fn app_of_pid(pid: i32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps").args(["-o", "comm=", "-p", &pid.to_string()]).output().ok()?;
    let exe = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let at = exe.find(".app/")?;
    Some(exe[..at + 4].to_string())
}

/// Which process has the other end of our socket (client port `port`).
fn peer_app(port: u16) -> Option<String> {
    let me = std::process::id() as i32;
    let out = std::process::Command::new("/usr/sbin/lsof").args(["-nP", &format!("-iTCP@127.0.0.1:{port}"), "-sTCP:ESTABLISHED", "-Fp"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.strip_prefix('p')).filter_map(|p| p.trim().parse::<i32>().ok()).filter(|p| *p != me).find_map(app_of_pid)
}

pub fn connected_to(info: &BrowserInfo) -> bool {
    lock(&CONNS).iter().any(|c| c.app_path == info.path || c.app_name.eq_ignore_ascii_case(&info.name))
}

/// Browsers with the extension connected right now (app names).
pub fn connected_apps() -> Vec<String> {
    lock(&CONNS).iter().map(|c| c.app_name.clone()).collect()
}

/// Sends one page-agent request to the extension in `info`'s browser and waits for the answer.
pub fn request(info: &BrowserInfo, matching: Option<&str>, req: &Value) -> Result<Value, String> {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let tx = lock(&CONNS)
        .iter()
        .rev()
        .find(|c| c.app_path == info.path || c.app_name.eq_ignore_ascii_case(&info.name))
        .map(|c| c.tx.clone())
        .ok_or_else(|| format!("{}: {}", super::NEEDS_EXTENSION, info.name))?;
    let (done, wait) = std::sync::mpsc::channel();
    lock(&PENDING).get_or_insert_with(HashMap::new).insert(id, done);
    let message = json!({ "id": id, "op": "page", "tab": matching, "request": req, "agent": super::PAGE_AGENT_VERSION });
    if tx.send(message.to_string()).is_err() {
        lock(&PENDING).as_mut().map(|p| p.remove(&id));
        return Err(format!("{}: {} (the extension just disconnected)", super::NEEDS_EXTENSION, info.name));
    }
    let answer = wait.recv_timeout(Duration::from_secs(20));
    lock(&PENDING).as_mut().map(|p| p.remove(&id));
    match answer {
        Ok(Ok(v)) => {
            // The extension hands back the agent's JSON text, like the browsers' own scripting does.
            match v.as_str() {
                Some(text) => serde_json::from_str(text).map_err(|_| format!("the page didn't answer ({text})")),
                None => Ok(v),
            }
        }
        Ok(Err(e)) if e.starts_with("NO_TAB") => Err(format!("{}: {e}", super::NO_TAB)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("{} didn't answer in time (the page may be busy)", info.name)),
    }
}

fn finish(id: u64, result: Result<Value, String>) {
    if let Some(done) = lock(&PENDING).as_mut().and_then(|p| p.remove(&id)) {
        let _ = done.send(result);
    }
}

/// Starts listening (once). The first free port of PORTS is used; the extension tries them all.
pub fn start(app_data: PathBuf) {
    let dir = extension_dir(&app_data);
    let secret = token(&dir);
    tauri::async_runtime::spawn(async move {
        let mut listener = None;
        for port in PORTS {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", *port)).await {
                *lock(&PORT) = Some(*port);
                listener = Some(l);
                break;
            }
        }
        let Some(listener) = listener else {
            eprintln!("[browser bridge] every port in {PORTS:?} is taken; the E.V extension can't connect");
            return;
        };
        loop {
            let Ok((stream, peer)) = listener.accept().await else { continue };
            if !peer.ip().is_loopback() {
                continue;
            }
            let secret = secret.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(stream, peer.port(), secret).await;
            });
        }
    });
}

async fn serve(stream: tokio::net::TcpStream, peer_port: u16, secret: String) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::Message;

    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).unwrap_or_default().to_lowercase();
        let extension = ["chrome-extension://", "moz-extension://", "safari-web-extension://", "extension://"].iter().any(|p| origin.starts_with(p));
        if extension {
            Ok(resp)
        } else {
            let mut refuse = ErrorResponse::new(Some("only the E.V extension may connect".into()));
            *refuse.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
            Err(refuse)
        }
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, check).await.map_err(|e| e.to_string())?;
    let (mut sink, mut source) = ws.split();

    // The first message must be the hello with the right secret, within a few seconds.
    let hello = tokio::time::timeout(Duration::from_secs(5), source.next()).await.map_err(|_| "no hello")?;
    let Some(Ok(Message::Text(text))) = hello else { return Err("no hello".into()) };
    let hello: Value = serde_json::from_str(text.as_str()).map_err(|e| e.to_string())?;
    if hello.get("token").and_then(|t| t.as_str()) != Some(secret.as_str()) {
        let _ = sink.send(Message::Text(json!({ "type": "refused", "reason": "This E.V extension is out of date — reinstall it from E.V's Settings → Browsers." }).to_string().into())).await;
        return Err("wrong token".into());
    }
    let app_path = tokio::task::spawn_blocking(move || peer_app(peer_port)).await.ok().flatten().unwrap_or_default();
    let app_name = Path::new(&app_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| hello.get("ua").and_then(|u| u.as_str()).unwrap_or("browser").to_string());
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    lock(&CONNS).push(Conn { id, app_path, app_name: app_name.clone(), tx });
    let _ = sink.send(Message::Text(json!({ "type": "welcome", "app": app_name }).to_string().into())).await;
    emit_change();

    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(out) = out else { break };
                if sink.send(Message::Text(out.into())).await.is_err() { break; }
            }
            incoming = source.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if let Some(rid) = v.get("id").and_then(|i| i.as_u64()) {
                    let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                    finish(rid, if ok { Ok(v.get("result").cloned().unwrap_or(Value::Null)) } else { Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("the extension failed").to_string()) });
                }
            }
        }
    }
    lock(&CONNS).retain(|c| c.id != id);
    emit_change();
    Ok(())
}

static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

pub fn set_app(app: tauri::AppHandle) {
    *lock(&APP) = Some(app);
}

fn emit_change() {
    use tauri::Emitter;
    if let Some(app) = lock(&APP).clone() {
        let _ = app.emit("browser-extension-changed", connected_apps());
    }
}

/// Writes the E.V extension (with this Mac's secret) and returns its folder.
fn write_extension(app_data: &Path) -> Result<PathBuf, String> {
    let dir = extension_dir(app_data);
    let folder = dir.join("E.V extension");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let secret = token(&dir);
    let config = format!("self.EV_BRIDGE = {};\n", json!({ "ports": PORTS, "token": secret }));
    let manifest = MANIFEST.replace("__GECKO_ID__", EXTENSION_ID_GECKO);
    for (name, body) in [("manifest.json", manifest.as_str()), ("background.js", BACKGROUND), ("page_agent.js", super::PAGE_AGENT), ("config.js", config.as_str())] {
        std::fs::write(folder.join(name), body).map_err(|e| e.to_string())?;
    }
    Ok(folder)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSetup {
    pub folder: String,
    /// The page to open in the browser to load it.
    pub page: String,
    /// Plain steps for the user, one per line.
    pub steps: Vec<String>,
}

/// Writes the extension, shows its folder in Finder and opens the browser's extensions page.
#[tauri::command]
pub async fn browser_extension_install(app: tauri::AppHandle, browser: String) -> Result<ExtensionSetup, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let info = super::info_for(&browser)?;
        let folder = write_extension(&data)?;
        let gecko = matches!(info.engine.as_str(), "gecko" | "goanna");
        let page = if gecko { "about:debugging#/runtime/this-firefox" } else { "chrome://extensions" };
        let steps: Vec<String> = if gecko {
            vec![
                format!("In {}, the page about:debugging is open (or type it in the address bar).", info.name),
                "Click “Load Temporary Add-on…”.".into(),
                "Pick manifest.json in the “E.V extension” folder Finder is showing.".into(),
                format!("If {} asks, allow it on all websites. Firefox forgets temporary add-ons when it quits — E.V shows this again if that happens.", info.name),
            ]
        } else {
            vec![
                format!("In {}, the extensions page is open (or type {page} in the address bar).", info.name),
                "Turn on Developer mode (top right).".into(),
                "Click “Load unpacked” and pick the “E.V extension” folder Finder is showing.".into(),
            ]
        };
        let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(folder.join("manifest.json")).status();
        let _ = std::process::Command::new("/usr/bin/open").args(["-a", &info.path, page]).status();
        Ok(ExtensionSetup { folder: folder.display().to_string(), page: page.into(), steps })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_extension_status() -> Vec<String> {
    connected_apps()
}
