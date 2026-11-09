//! E.V's ears and voice, native (Core Audio through cpal) instead of inside the web page.
//! macOS's web engine won't really start the microphone or play sound until the page has been
//! clicked once, so Talk mode turned on from another app (double-tap ⌘, the notch) half-worked
//! until you'd visited E.V's window — and not at all with chat panels off. Native audio has no
//! such rule: Talk mode works the first time, from anywhere, window shown or not.
//!
//! - Mic: mono, resampled to 16 kHz, sent to the page in ~64 ms frames (with the current levels).
//! - Voice: WAV from the speech engine played on the current output device (headphones, USB,
//!   AirPods: whatever is default when it starts), with an instant "duck" when you talk over it.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, InvokeBody, Request};

const MIC_RATE: u32 = 16_000;
const FRAME: usize = 1024;

/// Levels for the orb and for "is the user louder than E.V's own voice" (f32 bits).
static MIC_LEVEL: AtomicU32 = AtomicU32::new(0);
static OUT_LEVEL: AtomicU32 = AtomicU32::new(0);
/// Where E.V's voice volume is heading: 1.0 normally, lower while you talk over it on speakers
/// (f32 bits). The speaker fades to it over ~120 ms, never jumps.
static GAIN: AtomicU32 = AtomicU32::new(0x3f80_0000);
const FADE_SECONDS: f32 = 0.12;
/// Every sentence is played at this loudness (RMS of its spoken parts), so none is louder or
/// quieter than the one before.
const VOICE_RMS: f32 = 0.09;
/// Bumped by every play and stop: a playback whose number is old stops at once.
static PLAY_GENERATION: AtomicU64 = AtomicU64::new(0);
static MIC_ON: AtomicBool = AtomicBool::new(false);

fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    ((samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt() * 4.0).min(1.0)
}

fn store(slot: &AtomicU32, value: f32) {
    slot.store(value.to_bits(), Ordering::Relaxed);
}

fn load(slot: &AtomicU32) -> f32 {
    f32::from_bits(slot.load(Ordering::Relaxed))
}

// ── Microphone ────────────────────────────────────────────────────────────────

enum MicCommand {
    Start(Channel<tauri::ipc::Response>),
    Stop,
}

struct Resampler {
    ratio: f64,
    pos: f64,
    last: f32,
    out: Vec<f32>,
}

impl Resampler {
    /// Linear resampling to 16 kHz; plenty for speech.
    fn push(&mut self, input: &[f32]) {
        for &s in input {
            while self.pos <= 1.0 {
                self.out.push(self.last + (s - self.last) * self.pos as f32);
                self.pos += self.ratio;
            }
            self.pos -= 1.0;
            self.last = s;
        }
    }
}

fn open_mic(channel: Channel<tauri::ipc::Response>) -> Option<cpal::Stream> {
    let device = cpal::default_host().default_input_device()?;
    let config = device.default_input_config().ok()?;
    let channels = config.channels() as usize;
    let rate = config.sample_rate().0;
    let state = Arc::new(Mutex::new(Resampler { ratio: rate as f64 / MIC_RATE as f64, pos: 0.0, last: 0.0, out: Vec::with_capacity(FRAME * 2) }));
    let feed = move |mono: Vec<f32>| {
        let mut r = state.lock().unwrap();
        r.push(&mono);
        while r.out.len() >= FRAME {
            let frame: Vec<f32> = r.out.drain(..FRAME).collect();
            store(&MIC_LEVEL, level(&frame));
            // [out level, f32 samples…] as little-endian bytes: no JSON for audio.
            let mut bytes = Vec::with_capacity((FRAME + 1) * 4);
            bytes.extend_from_slice(&load(&OUT_LEVEL).to_le_bytes());
            for s in frame {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let _ = channel.send(tauri::ipc::Response::new(bytes));
        }
    };
    let failed = |e| eprintln!("talk mode: microphone error: {e}");
    let down = move |data: &[f32]| data.chunks(channels.max(1)).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect::<Vec<f32>>();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| feed(down(d)), failed, None),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |d: &[i16], _: &_| feed(down(&d.iter().map(|s| *s as f32 / i16::MAX as f32).collect::<Vec<_>>())),
            failed,
            None,
        ),
        _ => return None,
    }
    .ok()?;
    stream.play().ok()?;
    Some(stream)
}

fn mic() -> Sender<MicCommand> {
    static TX: OnceLock<Mutex<Sender<MicCommand>>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx): (Sender<MicCommand>, Receiver<MicCommand>) = channel();
        // A cpal stream can't move between threads: it lives on this one.
        std::thread::Builder::new()
            .name("talk-mic".into())
            .spawn(move || {
                let mut stream: Option<cpal::Stream> = None;
                while let Ok(command) = rx.recv() {
                    match command {
                        MicCommand::Start(channel) => {
                            stream = open_mic(channel);
                            MIC_ON.store(stream.is_some(), Ordering::Relaxed);
                        }
                        MicCommand::Stop => {
                            stream = None;
                            MIC_ON.store(false, Ordering::Relaxed);
                            store(&MIC_LEVEL, 0.0);
                        }
                    }
                }
                drop(stream);
            })
            .expect("talk mic thread");
        Mutex::new(tx)
    })
    .lock()
    .unwrap()
    .clone()
}

/// Starts the microphone; frames arrive on `channel` (see `open_mic`). False when there's no mic.
#[tauri::command]
pub async fn native_mic_start(channel: Channel<tauri::ipc::Response>) -> bool {
    let _ = mic().send(MicCommand::Start(channel));
    tokio::task::spawn_blocking(|| {
        for _ in 0..40 {
            if MIC_ON.load(Ordering::Relaxed) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        MIC_ON.load(Ordering::Relaxed)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub fn native_mic_stop() {
    let _ = mic().send(MicCommand::Stop);
}

/// [mic level, voice level], 0..1, for the orb.
#[tauri::command]
pub fn native_levels() -> [f32; 2] {
    [load(&MIC_LEVEL), load(&OUT_LEVEL)]
}

// ── E.V's voice ───────────────────────────────────────────────────────────────

/// Plays a WAV (E.V's voice from the speech engine); resolves when it has finished or was stopped.
#[tauri::command]
pub async fn native_play(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected WAV bytes".into()) };
    let (mut samples, rate) = crate::voice_engine::decode_wav(bytes)?;
    even_loudness(&mut samples, rate as u32);
    let generation = PLAY_GENERATION.load(Ordering::SeqCst);
    tokio::task::spawn_blocking(move || play_blocking(samples, rate as u32, generation)).await.map_err(|e| e.to_string())?
}

/// One answer (or sentence) waiting to be heard, already at the device's rate.
struct Clip {
    samples: Vec<f32>,
    pos: usize,
    generation: u64,
    done: Sender<()>,
}

struct Speaker {
    queue: Arc<Mutex<std::collections::VecDeque<Clip>>>,
    rate: u32,
    device: String,
}

/// The output stays open while E.V talks (sentences follow each other without a gap) and closes
/// a few seconds after it goes quiet (an open output would keep the Mac from idling).
fn speaker() -> Sender<Clip> {
    static TX: OnceLock<Mutex<Sender<Clip>>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx): (Sender<Clip>, Receiver<Clip>) = channel();
        std::thread::Builder::new()
            .name("ev-voice".into())
            .spawn(move || {
                let mut open: Option<(cpal::Stream, Speaker)> = None;
                loop {
                    let idle = open.as_ref().is_some_and(|(_, s)| s.queue.lock().unwrap().is_empty());
                    let next = if open.is_none() {
                        rx.recv().ok()
                    } else {
                        match rx.recv_timeout(std::time::Duration::from_millis(if idle { 3000 } else { 200 })) {
                            Ok(clip) => Some(clip),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if open.as_ref().is_some_and(|(_, s)| s.queue.lock().unwrap().is_empty()) && idle {
                                    open = None;
                                    store(&OUT_LEVEL, 0.0);
                                }
                                continue;
                            }
                            Err(_) => return,
                        }
                    };
                    let Some(clip) = next else { return };
                    // The default output may have changed (headphones, AirPods): follow it.
                    let device = cpal::default_host().default_output_device();
                    let name = device.as_ref().and_then(|d| d.name().ok()).unwrap_or_default();
                    if open.as_ref().is_some_and(|(_, s)| s.device != name) {
                        open = None;
                    }
                    if open.is_none() {
                        open = device.and_then(|d| open_speaker(d, name));
                    }
                    match &open {
                        Some((_, s)) => {
                            let samples = resample(&clip.samples, clip.pos as u32, s.rate);
                            s.queue.lock().unwrap().push_back(Clip { samples, pos: 0, ..clip });
                        }
                        None => {
                            let _ = clip.done.send(());
                        }
                    }
                }
            })
            .expect("voice thread");
        Mutex::new(tx)
    })
    .lock()
    .unwrap()
    .clone()
}

/// `rate` → `to`, linear.
fn resample(samples: &[f32], rate: u32, to: u32) -> Vec<f32> {
    if rate == to {
        return samples.to_vec();
    }
    let step = rate as f64 / to as f64;
    let length = (samples.len() as f64 / step) as usize;
    (0..length)
        .map(|i| {
            let x = i as f64 * step;
            let j = x as usize;
            let t = (x - j as f64) as f32;
            let a = samples.get(j).copied().unwrap_or(0.0);
            let b = samples.get(j + 1).copied().unwrap_or(a);
            a + (b - a) * t
        })
        .collect()
}

fn open_speaker(device: cpal::Device, name: String) -> Option<(cpal::Stream, Speaker)> {
    let config = device.default_output_config().ok()?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let queue: Arc<Mutex<std::collections::VecDeque<Clip>>> = Arc::new(Mutex::new(std::collections::VecDeque::new()));
    let q = queue.clone();
    let mut gain = load(&GAIN);
    let step = 1.0 / (FADE_SECONDS * rate.max(1) as f32);
    let mut write = move |out: &mut [f32]| {
        let target = load(&GAIN);
        let current = PLAY_GENERATION.load(Ordering::SeqCst);
        let mut queue = q.lock().unwrap();
        let mut heard = Vec::with_capacity(out.len() / channels.max(1));
        for frame in out.chunks_mut(channels.max(1)) {
            // Stopped clips are dropped; finished ones say so.
            while let Some(front) = queue.front() {
                if front.generation != current || front.pos >= front.samples.len() {
                    let done = queue.pop_front().unwrap();
                    let _ = done.done.send(());
                } else {
                    break;
                }
            }
            gain += (target - gain).clamp(-step, step);
            let raw = match queue.front_mut() {
                Some(clip) => {
                    let v = clip.samples[clip.pos];
                    clip.pos += 1;
                    v
                }
                None => 0.0,
            };
            // The level is E.V's voice before any turning down, so "louder than E.V" never gets easier.
            heard.push(raw);
            let s = raw * gain;
            for c in frame.iter_mut() {
                *c = s;
            }
        }
        store(&OUT_LEVEL, level(&heard));
    };
    let failed = |e| eprintln!("E.V's voice: output error: {e}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(&config.into(), move |d: &mut [f32], _: &_| write(d), failed, None),
        cpal::SampleFormat::I16 => {
            let mut buffer = Vec::new();
            device.build_output_stream(
                &config.into(),
                move |d: &mut [i16], _: &_| {
                    buffer.resize(d.len(), 0.0);
                    write(&mut buffer);
                    for (o, s) in d.iter_mut().zip(&buffer) {
                        *o = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    }
                },
                failed,
                None,
            )
        }
        _ => return None,
    }
    .ok()?;
    stream.play().ok()?;
    Some((stream, Speaker { queue, rate, device: name }))
}

fn play_blocking(samples: Vec<f32>, rate: u32, generation: u64) -> Result<(), String> {
    let seconds = samples.len() as f64 / rate.max(1) as f64;
    let (done, wait) = channel();
    // `pos` carries the source rate to the voice thread, which resamples for the device.
    speaker().send(Clip { samples, pos: rate as usize, generation, done }).map_err(|e| e.to_string())?;
    // Ends when it's been heard, or stopped, or (a stalled device) a little after it should have.
    let _ = wait.recv_timeout(std::time::Duration::from_secs_f64(seconds + 3.0));
    Ok(())
}

/// Stops E.V's voice at once.
#[tauri::command]
pub fn native_stop() {
    PLAY_GENERATION.fetch_add(1, Ordering::SeqCst);
    store(&OUT_LEVEL, 0.0);
}

/// Turns E.V's voice down (you're talking over it on speakers; `level`, default 0.35) or back up.
/// The speaker fades either way.
#[tauri::command]
pub fn native_duck(on: bool, level: Option<f32>) {
    store(&GAIN, if on { level.unwrap_or(0.35).clamp(0.05, 1.0) } else { 1.0 });
}

/// Brings a sentence to E.V's speaking loudness: measured on its spoken parts (pauses don't count),
/// within 0.5×–2.5×, and never past 0.97 at its loudest point.
fn even_loudness(samples: &mut [f32], rate: u32) {
    let window = (rate as usize / 50).max(1);
    let (mut sum, mut count) = (0.0f64, 0usize);
    for chunk in samples.chunks(window) {
        let rms = (chunk.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / chunk.len() as f64).sqrt();
        if rms > 0.01 {
            sum += rms * rms * chunk.len() as f64;
            count += chunk.len();
        }
    }
    if count == 0 {
        return;
    }
    let rms = (sum / count as f64).sqrt() as f32;
    let peak = samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let mut gain = (VOICE_RMS / rms).clamp(0.5, 2.5);
    if peak * gain > 0.97 {
        gain = 0.97 / peak;
    }
    for x in samples.iter_mut() {
        *x *= gain;
    }
}

/// Whether E.V's voice is going to speakers rather than headphones (helpers/cliplib.swift).
#[tauri::command]
pub fn native_output_speakers() -> bool {
    static F: OnceLock<usize> = OnceLock::new();
    let f = *F.get_or_init(|| {
        let Some(path) = crate::doc::lib_path() else { return 0 };
        let Ok(c_path) = std::ffi::CString::new(path.display().to_string()) else { return 0 };
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return 0;
        }
        unsafe { libc::dlsym(handle, c"ev_output_speakers".as_ptr()) as usize }
    });
    if f == 0 {
        return true;
    }
    unsafe { std::mem::transmute::<usize, extern "C" fn() -> bool>(f)() }
}

/// Dictation (and "type …"): pasted into the app in front like Handy, clipboard restored after.
#[tauri::command]
pub async fn paste_text(text: String) -> Result<(), String> {
    type PasteFn = unsafe extern "C" fn(*const std::ffi::c_char) -> bool;
    static PASTE: OnceLock<usize> = OnceLock::new();
    let f = *PASTE.get_or_init(|| {
        let Some(path) = crate::doc::lib_path() else { return 0 };
        let Ok(c_path) = std::ffi::CString::new(path.display().to_string()) else { return 0 };
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return 0;
        }
        unsafe { libc::dlsym(handle, c"ev_paste".as_ptr()) as usize }
    });
    if f == 0 {
        return Err("E.V's paste helper is missing — reinstall E.V".into());
    }
    if !crate::mac_control::accessibility_granted() {
        return Err("PERMISSION:accessibility".into());
    }
    let input = std::ffi::CString::new(text).map_err(|e| e.to_string())?;
    let ok = tokio::task::spawn_blocking(move || unsafe { std::mem::transmute::<usize, PasteFn>(f)(input.as_ptr()) }).await.map_err(|e| e.to_string())?;
    if ok { Ok(()) } else { Err("Couldn't paste".into()) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sentences_come_out_equally_loud() {
        let rms = |s: &[f32]| (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt();
        let tone = |amp: f32| (0..16_000).map(|i| amp * (i as f32 * 0.05).sin()).collect::<Vec<f32>>();
        let (mut quiet, mut loud) = (tone(0.05), tone(0.2));
        super::even_loudness(&mut quiet, 16_000);
        super::even_loudness(&mut loud, 16_000);
        assert!((rms(&quiet) - rms(&loud)).abs() < 0.005, "{} vs {}", rms(&quiet), rms(&loud));
        // Never clips.
        let mut peaky = tone(0.9);
        super::even_loudness(&mut peaky, 16_000);
        assert!(peaky.iter().all(|x| x.abs() <= 0.971));
        // Silence stays silence.
        let mut silent = vec![0.0; 1000];
        super::even_loudness(&mut silent, 16_000);
        assert!(silent.iter().all(|x| *x == 0.0));
    }

    #[test]
    #[ignore]
    fn reports_the_output_on_this_mac() {
        println!("E.V's voice goes to speakers: {}", super::native_output_speakers());
    }

    #[test]
    #[ignore]
    fn plays_on_this_mac() {
        // Silence, so nothing is heard: the first clip opens the output, the next ones follow at once.
        for round in 0..3 {
            let started = std::time::Instant::now();
            super::play_blocking(vec![0.0; 8_000], 16_000, super::PLAY_GENERATION.load(std::sync::atomic::Ordering::SeqCst)).unwrap();
            println!("played 0.5 s (round {round}) in {:?}", started.elapsed());
        }
    }
}
