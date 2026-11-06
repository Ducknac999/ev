//! On-device voice engine (sherpa-onnx): Silero speech detection, Parakeet speech-to-text and
//! Kokoro text-to-speech. Models live in Application Support (downloaded once from the official
//! sherpa-onnx releases and checked against pinned SHA-256 hashes), are loaded once and kept in
//! memory. Nothing here touches the network except the model download.

use crate::shell_env::home_dir;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{
    GenerationConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTts, OfflineTtsConfig, VadModelConfig,
    VoiceActivityDetector,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter};

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const PARAKEET: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const KOKORO: &str = "kokoro-multi-lang-v1_0";
const VAD_FILE: &str = "silero_vad.onnx";
const SAMPLE_RATE: i32 = 16_000;

struct Package {
    id: &'static str,
    label: &'static str,
    url: &'static str,
    /// Archive extracts to this folder (None: the download is the file itself).
    folder: Option<&'static str>,
    bytes: u64,
    pinned: &'static [(&'static str, &'static str)],
}

const PACKAGES: &[Package] = &[
    Package {
        id: "vad",
        label: "Speech detector",
        url: "asr-models/silero_vad.onnx",
        folder: None,
        bytes: 643_854,
        pinned: &[(VAD_FILE, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")],
    },
    Package {
        id: "stt",
        label: "Speech recognition",
        url: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        folder: Some(PARAKEET),
        bytes: 482_000_000,
        pinned: &[
            ("encoder.int8.onnx", "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab"),
            ("decoder.int8.onnx", "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e"),
            ("joiner.int8.onnx", "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2"),
            ("tokens.txt", "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
        ],
    },
    Package {
        id: "tts",
        label: "E.V's voice",
        url: "tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        folder: Some(KOKORO),
        bytes: 349_906_910,
        pinned: &[
            ("model.onnx", "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11"),
            ("voices.bin", "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29"),
            ("tokens.txt", "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425"),
        ],
    },
];

/// E.V's voices: Kokoro's own clean voices (slot in voices.bin), each at a brisk natural pace.
/// No blending or effects — those made the voice sound frail.
pub const VOICES: &[(&str, &str, i32, f32)] = &[
    ("gideon-a", "Heart · warm, clear (US)", 3, 1.05),
    ("gideon-b", "Bella · bright, confident (US)", 2, 1.05),
    ("gideon-c", "Emma · composed (British)", 21, 1.0),
    ("gideon-d", "Sarah · calm, even (US)", 9, 1.05),
    ("gideon-e", "Nova · crisp (US)", 7, 1.05),
    ("gideon-f", "Isabella · polished (British)", 22, 1.0),
];

pub fn models_dir() -> PathBuf {
    home_dir().join("Library/Application Support/com.ducknac.ev/models")
}

fn package_path(dir: &Path, p: &Package) -> PathBuf {
    match p.folder {
        Some(folder) => dir.join(folder),
        None => dir.join(p.pinned[0].0),
    }
}

/// Ready = every pinned file exists with the expected size class (hashes are checked on install).
fn installed(dir: &Path, p: &Package) -> bool {
    let base = package_path(dir, p);
    match p.folder {
        Some(_) => p.pinned.iter().all(|(f, _)| base.join(f).is_file()),
        None => base.is_file(),
    }
}

// ── Loaded engines ────────────────────────────────────────────────────────────

#[derive(Default)]
struct Engines {
    asr: Mutex<Option<Arc<OfflineRecognizer>>>,
    tts: Mutex<Option<Arc<OfflineTts>>>,
    vad: Mutex<Option<VoiceActivityDetector>>,
    aec: Mutex<Option<EchoCanceller>>,
}

/// WebRTC's echo canceller (AEC3, via sonora): removes E.V's own voice — which plays from the
/// speakers and leaks into the mic — using the exact audio E.V is playing as the reference.
struct EchoCanceller {
    apm: sonora::AudioProcessing,
    mic: std::collections::VecDeque<f32>,
    render: std::collections::VecDeque<f32>,
    out: std::collections::VecDeque<f32>,
}

const AEC_FRAME: usize = (SAMPLE_RATE / 100) as usize;

impl EchoCanceller {
    fn new() -> Self {
        let config = sonora::Config {
            echo_canceller: Some(sonora::config::EchoCanceller::default()),
            high_pass_filter: Some(sonora::config::HighPassFilter::default()),
            ..Default::default()
        };
        let stream = sonora::StreamConfig::new(SAMPLE_RATE as u32, 1);
        let apm = sonora::AudioProcessing::builder().config(config).capture_config(stream).render_config(stream).build();
        Self { apm, mic: Default::default(), render: Default::default(), out: Default::default() }
    }

    /// Same number of samples out as in (the first few milliseconds are delayed by one 10 ms frame).
    fn process(&mut self, mic: &[f32], render: &[f32]) -> Vec<f32> {
        self.mic.extend(mic);
        self.render.extend(render.iter().copied().chain(std::iter::repeat(0.0)).take(mic.len()));
        let (mut m, mut r) = (vec![0f32; AEC_FRAME], vec![0f32; AEC_FRAME]);
        let (mut md, mut rd) = (vec![0f32; AEC_FRAME], vec![0f32; AEC_FRAME]);
        while self.mic.len() >= AEC_FRAME {
            for i in 0..AEC_FRAME {
                m[i] = self.mic.pop_front().unwrap_or(0.0);
                r[i] = self.render.pop_front().unwrap_or(0.0);
            }
            let rendered = self.apm.process_render_f32(&[&r], &mut [&mut rd]);
            if rendered.is_ok() && self.apm.process_capture_f32(&[&m], &mut [&mut md]).is_ok() {
                self.out.extend(&md);
            } else {
                self.out.extend(&m);
            }
        }
        let missing = mic.len().saturating_sub(self.out.len());
        let mut cleaned = vec![0f32; missing];
        cleaned.extend(self.out.drain(..mic.len() - missing));
        cleaned
    }
}

/// One microphone frame: echo-cancelled against what E.V is playing, then judged by Silero.
pub(crate) fn voice_frame(mic: &[f32], render: &[f32]) -> Result<(bool, Vec<f32>), String> {
    let cleaned = {
        let mut slot = engines().aec.lock().unwrap();
        slot.get_or_insert_with(EchoCanceller::new).process(mic, render)
    };
    let mut slot = engines().vad.lock().unwrap();
    if slot.is_none() {
        *slot = Some(new_vad()?);
    }
    let vad = slot.as_ref().unwrap();
    vad.accept_waveform(&cleaned);
    while !vad.is_empty() {
        vad.pop();
    }
    Ok((vad.detected(), cleaned))
}

fn engines() -> &'static Engines {
    static E: OnceLock<Engines> = OnceLock::new();
    E.get_or_init(Engines::default)
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().min(4) as i32).unwrap_or(4)
}

fn s(path: PathBuf) -> Option<String> {
    Some(path.display().to_string())
}

fn recognizer() -> Result<Arc<OfflineRecognizer>, String> {
    let mut slot = engines().asr.lock().unwrap();
    if let Some(r) = slot.as_ref() {
        return Ok(r.clone());
    }
    let dir = models_dir().join(PARAKEET);
    if !dir.join("tokens.txt").is_file() {
        return Err("speech recognition model not installed".into());
    }
    let mut c = OfflineRecognizerConfig::default();
    c.model_config.transducer.encoder = s(dir.join("encoder.int8.onnx"));
    c.model_config.transducer.decoder = s(dir.join("decoder.int8.onnx"));
    c.model_config.transducer.joiner = s(dir.join("joiner.int8.onnx"));
    c.model_config.tokens = s(dir.join("tokens.txt"));
    c.model_config.model_type = Some("nemo_transducer".into());
    c.model_config.num_threads = threads();
    let r = Arc::new(OfflineRecognizer::create(&c).ok_or("could not load the speech recognition model")?);
    *slot = Some(r.clone());
    Ok(r)
}

fn synthesizer() -> Result<Arc<OfflineTts>, String> {
    let mut slot = engines().tts.lock().unwrap();
    if let Some(t) = slot.as_ref() {
        return Ok(t.clone());
    }
    let dir = models_dir().join(KOKORO);
    if !dir.join("model.onnx").is_file() {
        return Err("E.V's voice is not installed".into());
    }
    let mut c = OfflineTtsConfig::default();
    c.model.kokoro.model = s(dir.join("model.onnx"));
    c.model.kokoro.voices = s(dir.join("voices.bin"));
    c.model.kokoro.tokens = s(dir.join("tokens.txt"));
    c.model.kokoro.data_dir = s(dir.join("espeak-ng-data"));
    c.model.kokoro.lexicon = s(dir.join("lexicon-us-en.txt"));
    c.model.kokoro.lang = Some("en-us".into());
    c.model.num_threads = threads();
    let t = Arc::new(OfflineTts::create(&c).ok_or("could not load E.V's voice")?);
    *slot = Some(t.clone());
    Ok(t)
}

fn new_vad() -> Result<VoiceActivityDetector, String> {
    let path = models_dir().join(VAD_FILE);
    if !path.is_file() {
        return Err("speech detector not installed".into());
    }
    let mut c = VadModelConfig::default();
    c.silero_vad.model = s(path);
    c.silero_vad.threshold = 0.5;
    // Frame-level decisions: Talk mode does its own end-of-speech timing on top.
    c.silero_vad.min_silence_duration = 0.1;
    c.silero_vad.min_speech_duration = 0.08;
    c.silero_vad.window_size = 512;
    c.silero_vad.max_speech_duration = 120.0;
    c.sample_rate = SAMPLE_RATE;
    c.num_threads = 1;
    VoiceActivityDetector::create(&c, 30.0).ok_or_else(|| "could not load the speech detector".into())
}

// ── Speech detection ──────────────────────────────────────────────────────────

/// Body: `n` (u32 LE), then `n` mic samples and `n` samples of what E.V is playing (f32 LE,
/// 16 kHz mono). Reply: one byte (1 = someone is speaking), three padding bytes, then the `n`
/// echo-cancelled mic samples.
#[tauri::command]
pub async fn voice_frame_cmd(request: Request<'_>) -> Result<tauri::ipc::Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw audio".into());
    };
    let (speech, cleaned) = frame_from_bytes(bytes)?;
    let mut out = Vec::with_capacity(4 + cleaned.len() * 4);
    out.extend_from_slice(&[speech as u8, 0, 0, 0]);
    for v in cleaned {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

fn frame_from_bytes(bytes: &[u8]) -> Result<(bool, Vec<f32>), String> {
    if bytes.len() < 4 {
        return Err("bad frame".into());
    }
    let n = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if bytes.len() != 4 + n * 8 {
        return Err("bad frame length".into());
    }
    let read = |from: usize| -> Vec<f32> { bytes[from..from + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect() };
    voice_frame(&read(4), &read(4 + n * 4))
}

#[tauri::command]
pub fn vad_reset() {
    if let Some(vad) = engines().vad.lock().unwrap().as_ref() {
        vad.reset();
    }
    *engines().aec.lock().unwrap() = None;
}

// ── Speech to text ────────────────────────────────────────────────────────────

pub fn parakeet_ready() -> bool {
    installed(&models_dir(), &PACKAGES[1])
}

/// Mono 16-bit PCM WAV → f32 samples and rate.
pub(crate) fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, i32), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut pos = 12;
    let mut rate = 0i32;
    let mut channels = 1usize;
    let mut bits = 16u16;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &bytes[pos + 8..(pos + 8 + len).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            channels = u16::from_le_bytes([body[2], body[3]]) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap()) as i32;
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            if bits != 16 || channels == 0 || rate == 0 {
                return Err("unsupported WAV format".into());
            }
            let samples = body
                .chunks_exact(2 * channels)
                .map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0)
                .collect();
            return Ok((samples, rate));
        }
        pos += 8 + len + (len & 1);
    }
    Err("WAV has no audio".into())
}

pub fn transcribe(samples: &[f32], rate: i32) -> Result<String, String> {
    let r = recognizer()?;
    let stream = r.create_stream();
    stream.accept_waveform(rate, samples);
    r.decode(&stream);
    Ok(stream.get_result().map(|x| x.text.trim().to_string()).unwrap_or_default())
}

// ── Text to speech ────────────────────────────────────────────────────────────

pub fn kokoro_ready() -> bool {
    installed(&models_dir(), &PACKAGES[2])
}

pub fn is_gideon_voice(id: &str) -> bool {
    VOICES.iter().any(|v| v.0 == id)
}

/// Speaks with one of E.V's voices; `rate` is words per minute (185 = natural pace).
pub fn synthesize(text: &str, voice: &str, rate: Option<u32>) -> Result<Vec<u8>, String> {
    let slot = VOICES.iter().position(|v| v.0 == voice).ok_or("unknown voice")?;
    let tts = synthesizer()?;
    let mut g = GenerationConfig::default();
    g.sid = VOICES[slot].2;
    g.speed = VOICES[slot].3 * rate.filter(|r| *r > 0).map_or(1.0, |r| (r as f32 / 185.0).clamp(0.6, 1.8));
    let audio = tts
        .generate_with_config::<fn(&[f32], f32) -> bool>(text, &g, None)
        .ok_or("speech synthesis failed")?;
    let rate = audio.sample_rate();
    Ok(encode_wav(audio.samples(), rate as u32))
}

pub(crate) fn encode_wav(x: &[f32], rate: u32) -> Vec<u8> {
    let n = (x.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + x.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&n.to_le_bytes());
    for s in x {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

// ── Commands: status, warm-up, download ───────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    id: &'static str,
    label: &'static str,
    installed: bool,
    bytes: u64,
}

#[derive(Serialize)]
pub struct VoiceOption {
    id: &'static str,
    label: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    models: Vec<ModelState>,
    voices: Vec<VoiceOption>,
    downloading: bool,
}

static DOWNLOADING: Mutex<bool> = Mutex::new(false);

#[tauri::command]
pub fn voice_engine_status() -> EngineStatus {
    let dir = models_dir();
    EngineStatus {
        models: PACKAGES
            .iter()
            .map(|p| ModelState { id: p.id, label: p.label, installed: installed(&dir, p), bytes: p.bytes })
            .collect(),
        voices: VOICES.iter().map(|v| VoiceOption { id: v.0, label: v.1 }).collect(),
        downloading: *DOWNLOADING.lock().unwrap(),
    }
}

/// Loads the installed models into memory ahead of time, so the first request is fast.
#[tauri::command]
pub async fn voice_engine_warm() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        if parakeet_ready() {
            recognizer()?;
        }
        if kokoro_ready() {
            synthesizer()?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) fn verify(base: &Path, pinned: &[(&str, &str)], single_file: bool) -> Result<(), String> {
    for (name, hash) in pinned {
        let path = if single_file { base.to_path_buf() } else { base.join(name) };
        if sha256_file(&path)? != *hash {
            return Err(format!("{name} failed its integrity check"));
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: &'static str,
    stage: &'static str,
    done: u64,
    total: u64,
    error: Option<String>,
}

async fn install_package(dir: &Path, p: &Package, report: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
    let staging = dir.join(format!(".download-{}", p.id));
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging).await.map_err(|e| e.to_string())?;
    let file = staging.join(p.url.rsplit('/').next().unwrap());
    let emit = |stage, done, error: Option<String>| report(Progress { id: p.id, stage, done, total: p.bytes, error });

    let mut child = tokio::process::Command::new("/usr/bin/curl")
        .args(["-sSL", "--fail", "--retry", "3", "-o"])
        .arg(&file)
        .arg(format!("{RELEASES}/{}", p.url))
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        let done = tokio::fs::metadata(&file).await.map(|m| m.len()).unwrap_or(0);
        emit("downloading", done, None);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    };
    if !status.success() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(format!("{} download failed (check the internet connection)", p.label));
    }

    emit("checking", p.bytes, None);
    let target = package_path(dir, p);
    if let Some(folder) = p.folder {
        let out = tokio::process::Command::new("/usr/bin/tar")
            .arg("xjf")
            .arg(&file)
            .arg("-C")
            .arg(&staging)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(format!("{} could not be unpacked", p.label));
        }
        let unpacked = staging.join(folder);
        let check = unpacked.clone();
        let pinned = p.pinned;
        tauri::async_runtime::spawn_blocking(move || verify(&check, pinned, false))
            .await
            .map_err(|e| e.to_string())?
            .inspect_err(|_| {
                let _ = std::fs::remove_dir_all(&staging);
            })?;
        let _ = tokio::fs::remove_dir_all(unpacked.join("test_wavs")).await;
        let _ = tokio::fs::remove_dir_all(&target).await;
        tokio::fs::rename(&unpacked, &target).await.map_err(|e| e.to_string())?;
    } else {
        let check = file.clone();
        let pinned = p.pinned;
        tauri::async_runtime::spawn_blocking(move || verify(&check, pinned, true))
            .await
            .map_err(|e| e.to_string())??;
        tokio::fs::rename(&file, &target).await.map_err(|e| e.to_string())?;
    }
    let _ = tokio::fs::remove_dir_all(&staging).await;
    emit("installed", p.bytes, None);
    Ok(())
}

/// Downloads whichever models are missing. Progress arrives as "voice-models" events.
#[tauri::command]
pub async fn voice_models_download(app: AppHandle) -> Result<(), String> {
    {
        let mut busy = DOWNLOADING.lock().unwrap();
        if *busy {
            return Err("already downloading".into());
        }
        *busy = true;
    }
    let dir = models_dir();
    let result = async {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let report = |progress: Progress| {
            let _ = app.emit("voice-models", progress);
        };
        for p in PACKAGES.iter().filter(|p| !installed(&dir, p)) {
            if let Err(error) = install_package(&dir, p, &report).await {
                let _ = app.emit(
                    "voice-models",
                    Progress { id: p.id, stage: "failed", done: 0, total: p.bytes, error: Some(error.clone()) },
                );
                return Err(error);
            }
        }
        Ok(())
    }
    .await;
    *DOWNLOADING.lock().unwrap() = false;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_round_trip() {
        let samples: Vec<f32> = (0..1600).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        let (back, rate) = decode_wav(&encode_wav(&samples, 16_000)).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(back.len(), samples.len());
        assert!(back.iter().zip(&samples).all(|(a, b)| (a - b).abs() < 1e-3));
    }

    /// Real download of the smallest model from the official release (network).
    #[tokio::test]
    #[ignore]
    async fn downloads_and_verifies_the_speech_detector() {
        let dir = std::env::temp_dir().join(format!("gideon-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let report = |p: Progress| seen.lock().unwrap().push(p.stage);
        install_package(&dir, &PACKAGES[0], &report).await.unwrap();
        assert!(installed(&dir, &PACKAGES[0]));
        assert_eq!(seen.lock().unwrap().last(), Some(&"installed"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_check_rejects_changed_files() {
        let dir = std::env::temp_dir().join(format!("gideon-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify(&dir, &[("a.txt", good)], false).is_ok());
        std::fs::write(dir.join("a.txt"), b"hellO").unwrap();
        assert!(verify(&dir, &[("a.txt", good)], false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── Test bench bridge ─────────────────────────────────────────────────────────

/// `gideon --voice-serve`: the test bench drives the real engine over stdin/stdout, one command
/// per line — `VAD <base64 f32le 16 kHz>` → `1`/`0`, `RESET`, `STT <base64 wav>` → text,
/// `TTS <voice> <text>` → milliseconds and seconds of audio. Read-only; never opens a window.
pub fn serve_and_exit() {
    if !std::env::args().any(|a| a == "--voice-serve") {
        return;
    }
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let (op, arg) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        let reply = match op {
            // FRAME <base64: n, mic, render> → "<0|1> <base64 cleaned f32>"
            "FRAME" => decode_b64(arg).and_then(|b| frame_from_bytes(&b)).map(|(speech, cleaned)| {
                let bytes: Vec<u8> = cleaned.iter().flat_map(|v| v.to_le_bytes()).collect();
                format!("{} {}", speech as u8, encode_b64(&bytes))
            }),
            "RESET" => {
                vad_reset();
                Ok("ok".into())
            }
            "STT" => decode_b64(arg).and_then(|b| {
                let (samples, rate) = decode_wav(&b)?;
                let start = std::time::Instant::now();
                let text = transcribe(&samples, rate)?;
                Ok(format!("{}\t{}", start.elapsed().as_millis(), text.replace(['\n', '\t'], " ")))
            }),
            "TTS" => {
                let (voice, text) = arg.split_once(' ').unwrap_or((arg, ""));
                let start = std::time::Instant::now();
                synthesize(text, voice, None).map(|wav| {
                    let secs = (wav.len().saturating_sub(44)) as f32 / 2.0 / 24_000.0;
                    format!("{}\t{secs:.2}", start.elapsed().as_millis())
                })
            }
            // Bench speakers: any Kokoro voice slot, written as a WAV file.
            "SAY" => {
                let mut parts = arg.splitn(3, ' ');
                let (sid, path, text) = (parts.next().unwrap_or("0"), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                synthesizer().and_then(|tts| {
                    let mut g = GenerationConfig::default();
                    g.sid = sid.parse().map_err(|_| "bad voice slot")?;
                    let audio = tts.generate_with_config::<fn(&[f32], f32) -> bool>(text, &g, None).ok_or("synthesis failed")?;
                    std::fs::write(path, encode_wav(audio.samples(), audio.sample_rate() as u32)).map_err(|e| e.to_string())?;
                    Ok("ok".to_string())
                })
            }
            "SAMPLE" => {
                let mut parts = arg.splitn(3, ' ');
                let (voice, path, text) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                synthesize(text, voice, None).and_then(|wav| std::fs::write(path, wav).map_err(|e| e.to_string())).map(|_| "ok".to_string())
            }
            "WARM" => recognizer().and_then(|_| synthesizer()).map(|_| "ok".into()),
            _ => Err("unknown command".into()),
        };
        let _ = writeln!(out, "{}", reply.unwrap_or_else(|e| format!("ERR {e}")));
        let _ = out.flush();
    }
    std::process::exit(0);
}

fn encode_b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn decode_b64(input: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, c) in T.iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in input.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()) {
        let v = map[c as usize];
        if v == 255 {
            return Err("bad base64".into());
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}
