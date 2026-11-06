//! Local control channel for the Vorssaint notch. Speaks ClaudeDesk's protocol (newline-delimited
//! JSON over a 0600 Unix socket) so the notch shows and drives E.V's terminal sessions.
//!
//! Client → app: hello · attach{id} · detach{id} · input{id,text} · run{id,text,enter?}
//!   · resize{id,cols,rows} · release{id} · new{kind,cwd?,command?,ref?} · close{id}
//!   · interrupt{id} · signal{id,sig} · focus{id?}
//! App → client: hello · state{…} on change · screen{id,…} while attached output changes
//!   · created{id,ref} · error{message}

use crate::pty::{PtyKind, PtyRegistry, PtySession};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

const PROTOCOL_VERSION: u64 = 1;
/// History sent when a viewer first opens a session, and the most sent with any one update (the
/// notch keeps 2000 lines, so a burst of output never leaves a gap in its history).
const MAX_INITIAL_SCROLLBACK: u64 = 400;
const MAX_APPENDED_PER_FRAME: u64 = 2000;

/// Whether E.V currently owns the socket (and so may remove it on quit).
static OWNS_SOCKET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn release_socket() {
    if OWNS_SOCKET.swap(false, Ordering::SeqCst) {
        let _ = std::fs::remove_file(socket_path());
    }
}

/// Session details only the frontend knows (titles, badges, selection), pushed via `control_meta`.
#[derive(Default)]
pub struct ControlMeta {
    pub sessions: HashMap<String, Value>,
    pub presets: Vec<Value>,
    pub recent: Vec<String>,
    pub window_visible: bool,
    pending_created: HashMap<String, mpsc::UnboundedSender<String>>,
}

#[derive(Default)]
pub struct ControlState {
    pub meta: Mutex<ControlMeta>,
}

pub fn socket_path() -> PathBuf {
    if let Ok(path) = std::env::var("CLAUDEDESK_CONTROL_SOCK") {
        return PathBuf::from(path);
    }
    crate::shell_env::home_dir().join("Library/Application Support/ClaudeDesk/control.sock")
}

/// Binds the notch socket whenever no other app (a still-running ClaudeDesk) owns it.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let path = socket_path();
        loop {
            if UnixStream::connect(&path).await.is_err() {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::remove_file(&path);
                if let Ok(listener) = UnixListener::bind(&path) {
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                    OWNS_SOCKET.store(true, Ordering::SeqCst);
                    serve(app.clone(), listener).await;
                    OWNS_SOCKET.store(false, Ordering::SeqCst);
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn serve(app: AppHandle, listener: UnixListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        // Only processes of this user may connect.
        match stream.peer_cred() {
            Ok(cred) if cred.uid() == unsafe { libc::getuid() } => {}
            _ => continue,
        }
        tauri::async_runtime::spawn(client(app.clone(), stream));
    }
}

struct Viewer {
    greeted: bool,
    attached: HashSet<String>,
    sent_generation: HashMap<String, u64>,
    /// Absolute index of the top screen line in the last frame sent, per session.
    sent_base: HashMap<String, u64>,
    resized: HashSet<String>,
    last_state: String,
}

async fn client(app: AppHandle, stream: UnixStream) {
    let (read, mut write) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let viewer = Arc::new(Mutex::new(Viewer {
        greeted: false,
        attached: HashSet::new(),
        sent_generation: HashMap::new(),
        sent_base: HashMap::new(),
        resized: HashSet::new(),
        last_state: String::new(),
    }));

    // Push loop: state on change, screens for attached sessions at ~15 fps.
    let pusher = {
        let app = app.clone();
        let viewer = viewer.clone();
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(66)).await;
                if tx.is_closed() {
                    break;
                }
                push(&app, &viewer, &tx, false);
            }
        })
    };

    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        handle(&app, &viewer, &tx, &message).await;
        push(&app, &viewer, &tx, false);
    }

    // A viewer that disappears must not leave sessions stuck at the notch's size.
    let registry = app.state::<Arc<PtyRegistry>>();
    for id in viewer.lock().unwrap().resized.drain() {
        if let Some(session) = registry.get(&id) {
            let (cols, rows) = *session.window_grid.lock().unwrap();
            let _ = session.resize(cols, rows);
        }
    }
    pusher.abort();
    writer.abort();
}

fn send(tx: &mpsc::UnboundedSender<String>, value: Value) {
    let _ = tx.send(value.to_string());
}

async fn handle(app: &AppHandle, viewer: &Arc<Mutex<Viewer>>, tx: &mpsc::UnboundedSender<String>, message: &Value) {
    let registry = app.state::<Arc<PtyRegistry>>();
    let Some(op) = message.get("op").and_then(Value::as_str) else { return };
    let id = message.get("id").and_then(Value::as_str).map(str::to_string);
    let session = id.as_deref().and_then(|id| registry.get(id));
    let reject = |op: &str| send(tx, json!({ "op": "error", "message": format!("bad or unknown request: {op}") }));
    // A restored Command session that hasn't been run yet: listed, not spawned.
    let waiting = session.is_none()
        && id.as_deref().is_some_and(|id| {
            app.state::<ControlState>().meta.lock().unwrap().sessions.get(id).and_then(|m| m.get("notStarted")).and_then(Value::as_bool) == Some(true)
        });
    if waiting {
        match op {
            "attach" => send(
                tx,
                json!({
                    "op": "screen", "id": id, "cols": 80, "rows": 24, "cursor": [0, 1], "cursorVisible": true,
                    "alt": false, "reset": true, "appended": [],
                    "lines": [[["Not run since E.V restarted — press Return to run it.", 8, -1, 0]]],
                }),
            ),
            "run" | "input" => {
                let _ = app.emit("control-start", json!({ "id": id }));
            }
            "detach" | "release" | "resize" | "focus" | "close" => {}
            _ => return reject(op),
        }
        if !matches!(op, "focus" | "close") {
            return;
        }
    }

    match op {
        "hello" => {
            viewer.lock().unwrap().greeted = true;
            send(tx, json!({ "op": "hello", "version": PROTOCOL_VERSION }));
            viewer.lock().unwrap().last_state.clear();
        }
        "attach" => {
            let Some(session) = session else { return reject(op) };
            let depth = message.get("scrollback").and_then(Value::as_u64).unwrap_or(MAX_INITIAL_SCROLLBACK).min(MAX_INITIAL_SCROLLBACK);
            let mut v = viewer.lock().unwrap();
            v.attached.insert(session.id.clone());
            v.sent_generation.remove(&session.id);
            v.sent_base.remove(&session.id);
            let (payload, base) = screen_payload(&session, None, depth);
            v.sent_base.insert(session.id.clone(), base);
            v.sent_generation.insert(session.id.clone(), session.generation.load(Ordering::Relaxed));
            drop(v);
            send(tx, payload);
        }
        "detach" => {
            if let Some(id) = id {
                let mut v = viewer.lock().unwrap();
                v.attached.remove(&id);
                v.sent_generation.remove(&id);
                v.sent_base.remove(&id);
            }
        }
        "input" => {
            let (Some(session), Some(text)) = (session, message.get("text").and_then(Value::as_str)) else { return reject(op) };
            let _ = session.write(text.as_bytes());
        }
        "run" => {
            let (Some(session), Some(text)) = (session, message.get("text").and_then(Value::as_str)) else { return reject(op) };
            let enter = message.get("enter").and_then(Value::as_bool).unwrap_or(true);
            let _ = session.write(text.as_bytes());
            if enter {
                let _ = session.write(b"\r");
            }
        }
        "resize" => {
            let cols = message.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
            let rows = message.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
            let Some(session) = session.filter(|_| (20..=400).contains(&cols) && (5..=200).contains(&rows)) else { return reject(op) };
            viewer.lock().unwrap().resized.insert(session.id.clone());
            let _ = session.resize(cols, rows);
        }
        "release" => {
            if let Some(session) = session {
                viewer.lock().unwrap().resized.remove(&session.id);
                let (cols, rows) = *session.window_grid.lock().unwrap();
                let _ = session.resize(cols, rows);
            }
        }
        "new" => {
            let kind = match message.get("kind").and_then(Value::as_str) {
                Some("shell") => "shell",
                Some("command") => "command",
                _ => "claude",
            };
            if kind == "command" && message.get("command").and_then(Value::as_str).is_none() {
                return reject(op);
            }
            // The frontend owns the workspace: it creates the session and reports its id back.
            let reference = uuid_like();
            let (created_tx, mut created_rx) = mpsc::unbounded_channel();
            app.state::<ControlState>().meta.lock().unwrap().pending_created.insert(reference.clone(), created_tx);
            let _ = app.emit(
                "control-new",
                json!({
                    "ref": reference,
                    "kind": kind,
                    "cwd": message.get("cwd"),
                    "command": message.get("command"),
                }),
            );
            if let Ok(Some(created)) = tokio::time::timeout(Duration::from_secs(10), created_rx.recv()).await {
                let mut reply = json!({ "op": "created", "id": created });
                if let Some(r) = message.get("ref") {
                    reply["ref"] = r.clone();
                }
                send(tx, reply);
            } else {
                reject(op);
            }
            app.state::<ControlState>().meta.lock().unwrap().pending_created.remove(&reference);
        }
        "close" => {
            let Some(id) = id else { return reject(op) };
            let _ = app.emit("control-close", json!({ "id": id }));
        }
        "interrupt" => {
            let Some(session) = session else { return reject(op) };
            let _ = session.write(b"\x03");
        }
        "signal" => {
            let Some(session) = session else { return reject(op) };
            let sig = match message.get("sig").and_then(Value::as_str) {
                Some("INT") => libc::SIGINT,
                Some("TERM") => libc::SIGTERM,
                Some("KILL") => libc::SIGKILL,
                _ => return reject(op),
            };
            session.signal_foreground(sig);
        }
        "focus" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("control-focus", json!({ "id": id }));
        }
        _ => reject(op),
    }
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("ref-{nanos:x}")
}

fn push(app: &AppHandle, viewer: &Arc<Mutex<Viewer>>, tx: &mpsc::UnboundedSender<String>, force: bool) {
    let registry = app.state::<Arc<PtyRegistry>>();
    let state = state_payload(app, &registry);
    let mut v = viewer.lock().unwrap();
    if v.greeted {
        let text = state.to_string();
        if force || text != v.last_state {
            v.last_state = text.clone();
            let _ = tx.send(text);
        }
    }
    let attached: Vec<String> = v.attached.iter().cloned().collect();
    for id in attached {
        let Some(session) = registry.get(&id) else {
            v.attached.remove(&id);
            continue;
        };
        let generation = session.generation.load(Ordering::Relaxed);
        if v.sent_generation.get(&id) != Some(&generation) {
            v.sent_generation.insert(id.clone(), generation);
            let (payload, base) = screen_payload(&session, v.sent_base.get(&id).copied(), 0);
            v.sent_base.insert(id.clone(), base);
            let _ = tx.send(payload.to_string());
        }
    }
}

fn kind_name(kind: PtyKind) -> &'static str {
    match kind {
        PtyKind::Claude => "claude",
        PtyKind::Shell => "shell",
        PtyKind::Command => "command",
    }
}

fn state_payload(app: &AppHandle, registry: &PtyRegistry) -> Value {
    let control = app.state::<ControlState>();
    let meta = control.meta.lock().unwrap();
    let mut sessions: Vec<(f64, Value)> = registry
        .all()
        .into_iter()
        .map(|s| {
            let parser = s.parser.lock().unwrap();
            let (rows, cols) = parser.screen().size();
            let extra = meta.sessions.get(&s.id).cloned().unwrap_or(Value::Null);
            let field = |key: &str| extra.get(key).cloned();
            let mut info = json!({
                "id": s.id,
                "kind": kind_name(s.kind),
                "title": field("title").unwrap_or_else(|| json!(s.cwd.rsplit('/').next().unwrap_or(""))),
                "appTitle": parser.screen().title(),
                "cwd": s.cwd,
                "running": s.is_running(),
                "foreground": field("foreground").unwrap_or(json!("")),
                "unread": field("unread").unwrap_or(json!(false)),
                "attention": field("attention").unwrap_or(json!(false)),
                "selected": field("selected").unwrap_or(json!(false)),
                "claudeSession": field("claudeSession").unwrap_or(json!("")),
                "started": s.started,
                "cols": cols,
                "rows": rows,
            });
            if let Some(code) = *s.exit_code.lock().unwrap() {
                info["exitCode"] = json!(code);
            }
            (s.started, info)
        })
        .collect();
    for (id, extra) in meta.sessions.iter() {
        if extra.get("notStarted").and_then(Value::as_bool) != Some(true) || registry.get(id).is_some() {
            continue;
        }
        let started = extra.get("created").and_then(Value::as_f64).unwrap_or(0.0);
        sessions.push((
            started,
            json!({
                "id": id,
                "kind": extra.get("kind").and_then(Value::as_str).unwrap_or("command"),
                "title": extra.get("title").cloned().unwrap_or(json!("")),
                "appTitle": "",
                "cwd": extra.get("cwd").cloned().unwrap_or(json!("~")),
                "running": false,
                "foreground": "",
                "unread": false,
                "attention": false,
                "selected": extra.get("selected").cloned().unwrap_or(json!(false)),
                "started": started,
                "cols": 80,
                "rows": 24,
            }),
        ));
    }
    sessions.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    json!({
        "op": "state",
        "sessions": sessions.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "presets": meta.presets,
        "recent": meta.recent,
        "windowVisible": meta.window_visible,
    })
}

fn color_code(color: vt100::Color) -> i64 {
    match color {
        vt100::Color::Default => -1,
        vt100::Color::Idx(i) => i as i64,
        vt100::Color::Rgb(r, g, b) => 0x1000000 | (r as i64) << 16 | (g as i64) << 8 | b as i64,
    }
}

/// A screen row as runs of [text, fg, bg, attrs]; attrs bits: bold 1, italic 4, underline 8, inverse 16.
fn encode_row(screen: &vt100::Screen, row: u16, cols: u16) -> Vec<Value> {
    let mut runs: Vec<(String, i64, i64, i64)> = Vec::new();
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else { continue };
        if cell.is_wide_continuation() {
            continue;
        }
        let attrs = (cell.bold() as i64) | (cell.italic() as i64) << 2 | (cell.underline() as i64) << 3 | (cell.inverse() as i64) << 4;
        let style = (color_code(cell.fgcolor()), color_code(cell.bgcolor()), attrs);
        let text = if cell.has_contents() { cell.contents() } else { " ".to_string() };
        match runs.last_mut() {
            Some(last) if (last.1, last.2, last.3) == style => last.0.push_str(&text),
            _ => runs.push((text, style.0, style.1, style.2)),
        }
    }
    while runs.last().is_some_and(|r| r.2 == -1 && r.3 == 0 && r.0.chars().all(|c| c == ' ')) {
        runs.pop();
    }
    if let Some(last) = runs.last_mut() {
        if last.2 == -1 {
            last.0 = last.0.trim_end_matches(' ').to_string();
        }
    }
    runs.into_iter().map(|(t, f, b, a)| json!([t, f, b, a])).collect()
}

/// The visible screen, plus every line that scrolled off since this viewer's last frame (or, on
/// the first frame, up to `initial` lines of history), so the notch keeps its own scrollback.
/// Returns the frame and the absolute index of its top line.
fn screen_payload(session: &PtySession, sent: Option<u64>, initial: u64) -> (Value, u64) {
    let mut parser = session.parser.lock().unwrap();
    let base = session.scrolled.load(Ordering::Relaxed);
    let held = crate::pty::scrollback_len(&mut parser) as u64;
    let oldest = base.saturating_sub(held);
    let from = match sent {
        Some(sent) => sent.max(base.saturating_sub(MAX_APPENDED_PER_FRAME)).max(oldest),
        None => oldest.max(base.saturating_sub(initial)),
    };
    let mut appended = Vec::new();
    for line in from..base {
        parser.set_scrollback((base - line) as usize);
        let cols = parser.screen().size().1;
        appended.push(Value::Array(encode_row(parser.screen(), 0, cols)));
    }
    parser.set_scrollback(0);
    let reset = sent.is_none();
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let (cy, cx) = screen.cursor_position();
    let lines: Vec<Value> = (0..rows).map(|r| Value::Array(encode_row(screen, r, cols))).collect();
    let payload = json!({
        "op": "screen",
        "id": session.id,
        "cols": cols,
        "rows": rows,
        "cursor": [cx, cy],
        "cursorVisible": !screen.hide_cursor(),
        "alt": screen.alternate_screen(),
        "reset": reset,
        "appended": appended,
        "lines": lines,
    });
    (payload, base)
}

/// Frontend → server: titles, badges, presets and recent folders for the notch.
#[tauri::command]
pub fn control_meta(
    sessions: HashMap<String, Value>,
    presets: Vec<Value>,
    recent: Vec<String>,
    window_visible: bool,
    state: tauri::State<'_, ControlState>,
) {
    let mut meta = state.meta.lock().unwrap();
    meta.sessions = sessions;
    meta.presets = presets;
    meta.recent = recent;
    meta.window_visible = window_visible;
}

/// Frontend → server: the session created for a notch `new` request.
#[tauri::command]
pub fn control_created(reference: String, id: String, state: tauri::State<'_, ControlState>) {
    if let Some(tx) = state.meta.lock().unwrap().pending_created.remove(&reference) {
        let _ = tx.send(id);
    }
}
