use crate::shell_env::{expand_tilde, which};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::{InvokeBody, Request, Response};
use tokio::process::Command;

/// Removes the wrapped temp file when dropped, regardless of which path returns.
struct TempFile(PathBuf);

impl TempFile {
    fn new(extension: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        Self(std::env::temp_dir().join(format!("gideon-{}-{nanos}-{n}.{extension}", std::process::id())))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Synthesizes speech with the macOS system voice engine and returns 16-bit PCM WAV bytes,
/// which the frontend plays through Web Audio so the orb can analyse the output level.
#[tauri::command]
pub async fn tts_synthesize(text: String, voice: Option<String>, rate: Option<u32>) -> Result<Response, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to speak".into());
    }
    if let Some(id) = voice.as_deref().filter(|v| crate::voice_engine::is_gideon_voice(v)) {
        if crate::voice_engine::kokoro_ready() {
            let (text, id) = (text.to_string(), id.to_string());
            let wav = tauri::async_runtime::spawn_blocking(move || crate::voice_engine::synthesize(&text, &id, rate))
                .await
                .map_err(|e| e.to_string())??;
            return Ok(Response::new(wav));
        }
    }
    // A E.V voice that isn't downloaded yet falls back to the system voice.
    let voice = voice.filter(|v| !crate::voice_engine::is_gideon_voice(v));
    let out = TempFile::new("wav");
    let mut cmd = Command::new("/usr/bin/say");
    cmd.args(["--file-format=WAVE", "--data-format=LEI16@22050", "-o"]).arg(&out.0);
    if let Some(v) = voice.as_deref().filter(|v| !v.is_empty()) {
        cmd.args(["-v", v]);
    }
    if let Some(r) = rate.filter(|r| *r > 0) {
        cmd.args(["-r", &r.to_string()]);
    }
    cmd.arg("--").arg(text);

    let output = cmd.output().await.map_err(|e| format!("failed to run say: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let bytes = tokio::fs::read(&out.0).await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[derive(Serialize)]
pub struct Voice {
    pub name: String,
    pub locale: String,
}

#[tauri::command]
pub async fn tts_voices() -> Result<Vec<Voice>, String> {
    let output = Command::new("/usr/bin/say").args(["-v", "?"]).output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let voices = text
        .lines()
        .filter_map(|line| {
            let (head, _) = line.split_once('#')?;
            let head = head.trim_end();
            let split = head.rfind(char::is_whitespace)?;
            let name = head[..split].trim().to_string();
            let locale = head[split..].trim().to_string();
            (!name.is_empty()).then_some(Voice { name, locale })
        })
        .collect();
    Ok(voices)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    /// "parakeet" (on-device engine, kept loaded) or "whisper-cli".
    pub engine: &'static str,
    pub binary: Option<String>,
    pub model_exists: bool,
    pub model_path: String,
}

fn resolve_model(model_path: &str) -> PathBuf {
    expand_tilde(model_path.trim())
}

#[tauri::command]
pub fn stt_status(model_path: String) -> SttStatus {
    let model = resolve_model(&model_path);
    SttStatus {
        engine: if crate::voice_engine::parakeet_ready() { "parakeet" } else { "whisper-cli" },
        binary: which("whisper-cli").map(|p| p.display().to_string()),
        model_exists: model.is_file(),
        model_path: model.display().to_string(),
    }
}

/// Transcribes a 16 kHz mono WAV (sent as the raw IPC body) with whisper.cpp. Homebrew's
/// whisper-cpp build on Apple Silicon runs on Metal by default.
#[tauri::command]
pub async fn stt_transcribe(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(audio) = request.body() else {
        return Err("expected raw WAV body".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
    };
    let model = resolve_model(&header("x-model-path").ok_or("missing model path")?);
    let language = header("x-language").unwrap_or_else(|| "auto".into());

    // Parakeet is English-only; other languages keep using whisper.cpp.
    if crate::voice_engine::parakeet_ready() && matches!(language.as_str(), "auto" | "en") {
        let (samples, rate) = crate::voice_engine::decode_wav(audio)?;
        return tauri::async_runtime::spawn_blocking(move || crate::voice_engine::transcribe(&samples, rate))
            .await
            .map_err(|e| e.to_string())?;
    }

    if !model.is_file() {
        return Err(format!("whisper model not found at {}", model.display()));
    }
    let binary = which("whisper-cli").ok_or("`whisper-cli` not found on PATH (brew install whisper-cpp)")?;

    let input = TempFile::new("wav");
    tokio::fs::write(&input.0, audio).await.map_err(|e| e.to_string())?;

    let threads = std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4);
    let output = Command::new(binary)
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&input.0)
        .args(["-nt", "-np", "-l", &language, "-t", &threads.to_string()])
        .output()
        .await
        .map_err(|e| format!("failed to run whisper-cli: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let transcript = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_non_speech_marker(l))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(transcript)
}

/// whisper emits bracketed markers such as "[BLANK_AUDIO]" or "(music)" for non-speech input.
fn is_non_speech_marker(line: &str) -> bool {
    (line.starts_with('[') && line.ends_with(']')) || (line.starts_with('(') && line.ends_with(')'))
}

/// Header values arrive URI-encoded so non-ASCII paths survive transport.
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
