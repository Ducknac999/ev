//! Turbo replies (optional): Gemini Live answers conversational requests with streamed speech.
//! E.V sends it *text* it has already heard and checked on this Mac — never microphone audio —
//! so the wake phrase, the passphrase and anything not meant for E.V stay local. Anything that
//! needs a tool (the Mac, files, the web, live data, memory) is handed back to the normal path,
//! where every approval rule applies. Each turn uses a fresh session; the next one is opened ahead
//! of time so it's ready instantly.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const ENDPOINT: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/** A prepared session is used within this long, or replaced. */
const PARK_MS: u128 = 5 * 60 * 1000;

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    key: String,
    model: String,
    voice: String,
    system: String,
}

#[derive(Deserialize)]
pub struct Turn {
    role: String,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveEvent {
    /// 16-bit little-endian PCM, 24 kHz mono, base64.
    Audio { data: String },
    Text { text: String },
    /// The request needs tools: answer it the normal way.
    Handoff,
    Done,
}

struct Parked {
    config: LiveConfig,
    ws: Ws,
    at: Instant,
}

static PARKED: Mutex<Option<Parked>> = Mutex::const_new(None);
static CANCEL: Notify = Notify::const_new();

fn setup_message(c: &LiveConfig) -> Value {
    json!({
        "setup": {
            "model": format!("models/{}", c.model),
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": c.voice } } }
            },
            "systemInstruction": { "parts": [{ "text": c.system }] },
            "tools": [{ "functionDeclarations": [{
                "name": "hand_off",
                "description": "Call this instead of answering whenever the request needs any action or fresh information: controlling or looking at the Mac or an app, files, commands, web search or web pages, weather, sports, news, prices, dates beyond what you were told, calculations, memory, reminders or the schedule. Say nothing else."
            }] }],
            "outputAudioTranscription": {}
        }
    })
}

fn close_reason(msg: &Message) -> Option<String> {
    if let Message::Close(Some(frame)) = msg {
        return Some(format!("Gemini Live closed ({}): {}", u16::from(frame.code), frame.reason));
    }
    None
}

/// TCP to Google, IPv4 first with a short timeout per address: on some networks IPv6 routes
/// stall for seconds, and unlike browsers a plain socket doesn't fall back by itself.
async fn tcp(host: &str) -> Result<tokio::net::TcpStream, String> {
    let mut addrs: Vec<_> = tokio::net::lookup_host((host, 443)).await.map_err(|e| format!("Can't reach {host}: {e}"))?.collect();
    addrs.sort_by_key(|a| !a.is_ipv4());
    let mut last = format!("Can't reach {host}");
    for addr in addrs {
        match tokio::time::timeout(Duration::from_millis(2500), tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = format!("{addr} timed out"),
        }
    }
    Err(last)
}

async fn connect(c: &LiveConfig) -> Result<Ws, String> {
    let url = format!("{ENDPOINT}?key={}", c.key);
    let stream = tcp("generativelanguage.googleapis.com").await?;
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(8), tokio_tungstenite::client_async_tls(url, stream))
        .await
        .map_err(|_| "Gemini Live didn't answer in time".to_string())?
        .map_err(|e| format!("Gemini Live unavailable: {e}"))?;
    ws.send(Message::Text(setup_message(c).to_string().into())).await.map_err(|e| e.to_string())?;
    loop {
        let next = tokio::time::timeout(Duration::from_secs(8), ws.next())
            .await
            .map_err(|_| "Gemini Live setup timed out".to_string())?;
        let msg = next.ok_or("Gemini Live closed during setup")?.map_err(|e| e.to_string())?;
        if let Some(reason) = close_reason(&msg) {
            return Err(reason);
        }
        if let Some(value) = parse(&msg) {
            if value.get("setupComplete").is_some() {
                return Ok(ws);
            }
        }
    }
}

fn parse(msg: &Message) -> Option<Value> {
    match msg {
        Message::Text(t) => serde_json::from_str(t.as_str()).ok(),
        Message::Binary(b) => serde_json::from_slice(b).ok(),
        _ => None,
    }
}

/// Opens a session ahead of time ("Hey E.V" was heard), so the reply starts sooner.
#[tauri::command]
pub async fn live_prepare(config: LiveConfig) -> Result<(), String> {
    {
        let parked = PARKED.lock().await;
        if parked.as_ref().is_some_and(|p| p.config == config && p.at.elapsed().as_millis() < PARK_MS) {
            return Ok(());
        }
    }
    let ws = connect(&config).await?;
    let old = PARKED.lock().await.replace(Parked { config, ws, at: Instant::now() });
    if let Some(mut old) = old {
        let _ = old.ws.close(None).await;
    }
    Ok(())
}

#[tauri::command]
pub fn live_cancel() {
    CANCEL.notify_waiters();
}

/// One spoken reply. Streams audio and its transcript; ends with Done, or Handoff when the
/// request needs E.V's tools.
#[tauri::command]
pub async fn live_turn(config: LiveConfig, history: Vec<Turn>, text: String, on_event: Channel<LiveEvent>) -> Result<(), String> {
    turn(config, history, text, move |event| {
        let _ = on_event.send(event);
    })
    .await
}

async fn turn(config: LiveConfig, history: Vec<Turn>, text: String, mut emit: impl FnMut(LiveEvent) + Send) -> Result<(), String> {
    let parked = {
        let mut slot = PARKED.lock().await;
        match slot.take() {
            Some(p) if p.config == config && p.at.elapsed().as_millis() < PARK_MS => Some(p.ws),
            Some(mut p) => {
                let _ = p.ws.close(None).await;
                None
            }
            None => None,
        }
    };
    let mut ws = match parked {
        Some(ws) => ws,
        None => connect(&config).await?,
    };

    let mut turns: Vec<Value> = history
        .iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| json!({ "role": if t.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": t.text }] }))
        .collect();
    turns.push(json!({ "role": "user", "parts": [{ "text": text }] }));
    ws.send(Message::Text(json!({ "clientContent": { "turns": turns, "turnComplete": true } }).to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    let result = async {
        loop {
            let next = tokio::select! {
                _ = CANCEL.notified() => return Ok(()),
                next = tokio::time::timeout(Duration::from_secs(15), ws.next()) => next,
            };
            let msg = next.map_err(|_| "Gemini Live stopped responding".to_string())?.ok_or("Gemini Live closed")?.map_err(|e| e.to_string())?;
            if let Some(reason) = close_reason(&msg) {
                return Err(reason);
            }
            let Some(value) = parse(&msg) else { continue };
            if value.get("toolCall").is_some() {
                emit(LiveEvent::Handoff);
                return Ok(());
            }
            let Some(content) = value.get("serverContent") else { continue };
            if let Some(parts) = content.pointer("/modelTurn/parts").and_then(Value::as_array) {
                for part in parts {
                    if let Some(data) = part.pointer("/inlineData/data").and_then(Value::as_str) {
                        emit(LiveEvent::Audio { data: data.to_string() });
                    }
                }
            }
            if let Some(t) = content.pointer("/outputTranscription/text").and_then(Value::as_str) {
                emit(LiveEvent::Text { text: t.to_string() });
            }
            if content.get("turnComplete").and_then(Value::as_bool) == Some(true) {
                emit(LiveEvent::Done);
                return Ok(());
            }
        }
    }
    .await;
    let _ = ws.close(None).await;
    // Ready for the next turn of the conversation.
    tauri::async_runtime::spawn(async move {
        let _ = live_prepare(config).await;
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LiveConfig {
        let path = crate::shell_env::home_dir().join("Library/Application Support/com.ducknac.ev/settings.json");
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let key = settings.pointer("/providers/gemini/keys/0/key").and_then(Value::as_str).unwrap().to_string();
        LiveConfig {
            key,
            model: "gemini-3.1-flash-live-preview".into(),
            voice: "Despina".into(),
            system: "You are Gideon, a calm, brief voice assistant. Today is Saturday, October 10, 2026.".into(),
        }
    }

    /// Real Gemini Live (network, your key): chat is spoken; a task is handed back.
    #[tokio::test]
    #[ignore]
    async fn live_speaks_and_hands_off() {
        let start = Instant::now();
        let mut first_audio = None;
        let mut said = String::new();
        let mut events = Vec::new();
        turn(config(), vec![], "Hello Gideon, how are you?".into(), |e| {
            if matches!(e, LiveEvent::Audio { .. }) && first_audio.is_none() {
                first_audio = Some(start.elapsed());
            }
            if let LiveEvent::Text { text } = &e {
                said.push_str(text);
            }
            events.push(match e { LiveEvent::Audio { .. } => "audio", LiveEvent::Text { .. } => "text", LiveEvent::Handoff => "handoff", LiveEvent::Done => "done" });
        })
        .await
        .unwrap();
        println!("hello: first audio {:?}, said “{}”", first_audio, said.trim());
        assert!(events.contains(&"audio") && events.last() == Some(&"done"));

        tokio::time::sleep(Duration::from_millis(800)).await;
        let start = Instant::now();
        let mut handed = false;
        turn(config(), vec![], "What's the weather in Paris right now?".into(), |e| handed |= matches!(e, LiveEvent::Handoff)).await.unwrap();
        println!("weather: handed off {handed} after {:?}", start.elapsed());
        assert!(handed);
    }

    #[test]
    fn setup_offers_only_the_hand_off_tool() {
        let c = LiveConfig { key: "k".into(), model: "gemini-x".into(), voice: "Despina".into(), system: "Be brief.".into() };
        let setup = setup_message(&c);
        assert_eq!(setup.pointer("/setup/model").unwrap(), "models/gemini-x");
        let tools = setup.pointer("/setup/tools/0/functionDeclarations").unwrap().as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "hand_off");
        assert_eq!(setup.pointer("/setup/generationConfig/speechConfig/voiceConfig/prebuiltVoiceConfig/voiceName").unwrap(), "Despina");
    }
}
