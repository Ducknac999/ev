//! E.V ↔ the notch: E.V's own (notch_window.rs) when it's on, else the Vorssaint notch, over the same local socket Claude Code's hooks use
//! (~/.claude/vorssaint-claude.sock). An approval is sent as a permission request and its
//! connection stays open until the notch answers; closing it takes the request off the notch,
//! which is how an approval answered elsewhere disappears. "ev" lines are one-way: what
//! hold-to-talk hears, and answers shown instead of spoken.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::oneshot;

fn socket_path() -> PathBuf {
    std::env::var_os("VORSSAINT_CLAUDE_SOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude/vorssaint-claude.sock"))
}

/// Approvals on the notch right now: withdrawing one closes its connection.
static WAITING: Mutex<Option<HashMap<String, oneshot::Sender<()>>>> = Mutex::new(None);

/// Sends an approval to the notch and waits for the answer: "allow", "always", "deny",
/// "defer" (the notch can't show it), "withdrawn" (answered elsewhere) or "closed".
/// Err("offline") when Vorssaint isn't listening.
#[tauri::command]
pub async fn notch_request(id: String, request: serde_json::Value) -> Result<String, String> {
    if crate::notch_window::active() {
        return ev_request(id, request).await;
    }
    let stream = UnixStream::connect(socket_path()).await.map_err(|_| "offline".to_string())?;
    let (read, mut write) = stream.into_split();
    let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    line.push('\n');
    write.write_all(line.as_bytes()).await.map_err(|_| "offline".to_string())?;
    let (tx, rx) = oneshot::channel();
    WAITING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    let mut reader = BufReader::new(read);
    let mut reply = String::new();
    // The write half stays open while waiting: shutting it down reads as "gone" to the notch.
    let outcome = tokio::select! {
        read = reader.read_line(&mut reply) => match read {
            Ok(n) if n > 0 => {
                let value: serde_json::Value = serde_json::from_str(reply.trim()).unwrap_or_default();
                match value.get("decision").and_then(|d| d.as_str()) {
                    Some("allow") if value.get("always").and_then(|a| a.as_bool()) == Some(true) => "always",
                    Some("allow") => "allow",
                    Some("deny") => "deny",
                    _ => "defer",
                }
            }
            _ => "closed",
        },
        _ = rx => "withdrawn",
    };
    drop(write);
    if let Some(map) = WAITING.lock().unwrap().as_mut() {
        map.remove(&id);
    }
    Ok(outcome.into())
}

/// Approvals on the E.V notch, waiting for Approve / Always / Skip.
static EV_WAITING: Mutex<Option<HashMap<String, oneshot::Sender<String>>>> = Mutex::new(None);

async fn ev_request(id: String, request: serde_json::Value) -> Result<String, String> {
    use tauri::Emitter;
    let app = crate::notch_window::app().ok_or("offline")?;
    let (tx, rx) = oneshot::channel();
    EV_WAITING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    app.emit_to("notch", "notch-approval", serde_json::json!({ "id": id, "request": request })).map_err(|_| "offline".to_string())?;
    Ok(rx.await.unwrap_or_else(|_| "closed".into()))
}

/// The E.V notch's answer to an approval: "allow", "always" or "deny".
#[tauri::command]
pub fn notch_answer(id: String, decision: String) {
    if let Some(tx) = EV_WAITING.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send(decision);
    }
}

/// Takes an approval off the notch (it was answered in E.V, by voice or by shortcut).
#[tauri::command]
pub fn notch_withdraw(id: String) {
    if let Some(tx) = EV_WAITING.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send("withdrawn".into());
        if let Some(app) = crate::notch_window::app() {
            use tauri::Emitter;
            let _ = app.emit_to("notch", "notch-withdraw", id.clone());
        }
    }
    if let Some(tx) = WAITING.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send(());
    }
}

/// One-way message to the notch: `{"type": "ev", "event": …, "text": …}`. False when Vorssaint
/// isn't listening.
pub(crate) fn send_ev(event: &str, text: &str, seconds: Option<f64>) -> bool {
    if crate::notch_window::active() {
        use tauri::Emitter;
        return crate::notch_window::app()
            .map(|app| app.emit_to("notch", "notch-ev", serde_json::json!({ "event": event, "text": text, "seconds": seconds })).is_ok())
            .unwrap_or(false);
    }
    let Ok(mut stream) = std::os::unix::net::UnixStream::connect(socket_path()) else { return false };
    let mut line = serde_json::json!({ "type": "ev", "event": event, "text": text, "seconds": seconds }).to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).is_ok()
}

#[tauri::command]
pub fn notch_message(event: String, text: String, seconds: Option<f64>) -> bool {
    send_ev(&event, &text, seconds)
}
