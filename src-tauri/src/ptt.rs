//! Hold to talk: a shortcut held down anywhere on the Mac. The microphone starts natively the
//! instant the key goes down, the words heard so far show in the Vorssaint notch, and letting go
//! transcribes on the Mac and hands the text to the frontend to send. The shortcut is a key combo
//! (⌃⌥Space) or one key on its own (fn, Right Option…). A keyboard event tap watches for it —
//! Accessibility, which E.V already has, allows that — and a combo's own key presses are kept from
//! the front app. The same tap answers approvals with the user's three approval shortcuts.

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CGEventRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events: u64,
        callback: extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef,
        info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: CFRunLoopSourceRef, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
const FIELD_KEYCODE: u32 = 9;
const FIELD_AUTOREPEAT: u32 = 8;
const ESCAPE: i64 = 53;

const SHIFT: u64 = 0x0002_0000;
const CONTROL: u64 = 0x0004_0000;
const OPTION: u64 = 0x0008_0000;
const COMMAND: u64 = 0x0010_0000;
const FN: u64 = 0x0080_0000;
const MODIFIERS: u64 = SHIFT | CONTROL | OPTION | COMMAND;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Spec {
    /// A key with exactly these modifiers held.
    Combo { code: i64, flags: u64 },
    /// One modifier key on its own (its own key code, so Right Option isn't Left Option).
    Alone { code: i64, flag: u64 },
}

fn parse(shortcut: &str) -> Result<Spec, String> {
    let s = shortcut.trim().to_lowercase().replace(' ', "");
    let alone = |code, flag| Ok(Spec::Alone { code, flag });
    match s.as_str() {
        "fn" | "globe" => return alone(63, FN),
        "rightoption" | "rightalt" => return alone(61, OPTION),
        "rightcommand" | "rightcmd" => return alone(54, COMMAND),
        "rightcontrol" | "rightctrl" => return alone(62, CONTROL),
        "rightshift" => return alone(60, SHIFT),
        _ => {}
    }
    let parts: Vec<&str> = s.split('+').filter(|p| !p.is_empty()).collect();
    let (key, mods) = parts.split_last().ok_or("no shortcut set")?;
    let mut flags = 0;
    for m in mods {
        flags |= match *m {
            "control" | "ctrl" => CONTROL,
            "option" | "alt" => OPTION,
            "command" | "cmd" => COMMAND,
            "shift" => SHIFT,
            other => return Err(format!("unknown modifier \"{other}\"")),
        };
    }
    let code = crate::mac_control::key_code(key).ok_or_else(|| format!("unknown key \"{key}\""))? as i64;
    // A bare letter would fire while typing; F-keys alone are fine.
    if flags == 0 && !key.starts_with('f') {
        return Err("add at least one modifier (⌃ ⌥ ⌘ ⇧), or use an F-key or a single key like fn".into());
    }
    Ok(Spec::Combo { code, flags })
}

struct State {
    spec: Option<Spec>,
    held: bool,
    tap: usize,
}

static STATE: Mutex<State> = Mutex::new(State { spec: None, held: false, tap: 0 });
/// Dictation's own key: held, the words are typed into whatever app is in front (not sent to E.V).
static DICTATE: Mutex<State> = Mutex::new(State { spec: None, held: false, tap: 0 });
/// Which key the current recording belongs to.
static DICTATING: AtomicBool = AtomicBool::new(false);
/// Double-tap ⌘ turns hands-free (Talk mode) on or off.
static DOUBLE_COMMAND: AtomicBool = AtomicBool::new(false);
/// ⌘ pressed alone: when it went down, and when the last lone tap ended.
static COMMAND_TAP: Mutex<(Option<std::time::Instant>, Option<std::time::Instant>)> = Mutex::new((None, None));
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The approval shortcuts work only while an approval is waiting.
static APPROVAL_KEYS: AtomicBool = AtomicBool::new(false);
/// Approve, approve always, cancel: (key code, modifiers).
static APPROVAL_COMBOS: Mutex<[Option<(i64, u64)>; 3]> = Mutex::new([None, None, None]);
/// The quick panel's shortcut (key code, modifiers): opens or closes the panel from any app.
static PANEL_COMBO: Mutex<Option<(i64, u64)>> = Mutex::new(None);
/// The notch clipboard's shortcut (⌘⇧C by default): opens its history from any app.
static CLIP_COMBO: Mutex<Option<(i64, u64)>> = Mutex::new(None);
/// While the key is held: the notch keeps showing the words heard so far.
static HOLDING: AtomicBool = AtomicBool::new(false);

/// The key went down, came up, or was used for something else. Work happens off the tap's thread,
/// which must answer macOS at once.
fn emit(what: &str) {
    match what {
        "down" => {
            mic::start();
            HOLDING.store(true, Ordering::SeqCst);
            let session = live::begin();
            // While the key is held: each finished stretch of speech (cut at a pause) is turned
            // into text in the background, so letting go only leaves the last bit to do.
            std::thread::spawn(move || {
                crate::notch::send_ev("listening", "", None);
                while HOLDING.load(Ordering::SeqCst) && live::current(session) {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    if !crate::voice_engine::parakeet_ready() {
                        continue;
                    }
                    let (samples, rate) = mic::snapshot();
                    if let Some(text) = live::step(session, &samples, rate) {
                        if HOLDING.load(Ordering::SeqCst) {
                            crate::notch::send_ev("listening", &text, None);
                        }
                    }
                }
            });
        }
        "up" => {
            HOLDING.store(false, Ordering::SeqCst);
            std::thread::spawn(|| {
                let (samples, rate) = mic::stop();
                if samples.len() < (rate as usize * 3) / 10 {
                    crate::notch::send_ev("clear", "", None);
                    return;
                }
                if !crate::voice_engine::parakeet_ready() {
                    crate::notch::send_ev("say", "Hold to talk needs E.V's speech engine: E.V Settings → Voice.", Some(5.0));
                    return;
                }
                let text = live::finish(&samples, rate);
                if text.is_empty() {
                    crate::notch::send_ev("heard", "Didn't catch that", None);
                    DICTATING.store(false, Ordering::SeqCst);
                    return;
                }
                let dictating = DICTATING.swap(false, Ordering::SeqCst);
                if !dictating {
                    crate::notch::send_ev("heard", &text, None);
                }
                if let Some(app) = APP.get() {
                    let _ = app.emit_to("main", if dictating { "dictate-text" } else { "ptt-text" }, text);
                }
            });
        }
        _ => {
            HOLDING.store(false, Ordering::SeqCst);
            DICTATING.store(false, Ordering::SeqCst);
            mic::cancel();
            live::begin();
            std::thread::spawn(|| crate::notch::send_ev("clear", "", None));
        }
    }
}

/// Transcribing while you talk: the recording is cut at pauses and each finished piece becomes
/// text in the background; silence before and after speech is left out.
mod live {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    struct Live {
        session: u64,
        /// Samples up to here are already text.
        done: usize,
        text: String,
        /// How long the pause was where the last piece ended (it decides how the next one joins).
        gap_ms: usize,
    }

    static LIVE: Mutex<Live> = Mutex::new(Live { session: 0, done: 0, text: String::new(), gap_ms: 0 });
    static SESSION: AtomicU64 = AtomicU64::new(0);
    /// One decode at a time: letting go waits for a piece that's being decoded.
    static DECODING: Mutex<()> = Mutex::new(());

    const FRAME_MS: usize = 20;
    /// Only a real pause ends a piece (a breath mid-sentence must not: Parakeet treats every
    /// piece as a sentence of its own).
    const PAUSE_MS: usize = 600;
    /// A pause this long is a new sentence (and is cut at even before speech starts again).
    const LONG_PAUSE_MS: usize = 900;
    /// Pieces are at least this long (shorter ones lose too much context).
    const MIN_PIECE_MS: usize = 4000;
    /// Talking this long without a real pause: cut at the quietest moment anyway.
    const MAX_PIECE_MS: usize = 12_000;
    /// Silence kept around speech, so first and last sounds aren't clipped.
    const MARGIN_MS: usize = 300;

    pub fn begin() -> u64 {
        let session = SESSION.fetch_add(1, Ordering::SeqCst) + 1;
        *LIVE.lock().unwrap() = Live { session, done: 0, text: String::new(), gap_ms: 0 };
        session
    }

    pub fn current(session: u64) -> bool {
        SESSION.load(Ordering::SeqCst) == session
    }

    fn levels(samples: &[f32], rate: u32) -> (Vec<f32>, usize) {
        let frame = (rate as usize * FRAME_MS / 1000).max(1);
        (samples.chunks(frame).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect(), frame)
    }

    /// Speech louder than this counts (the room's own noise, measured, times three).
    fn threshold(levels: &[f32]) -> f32 {
        let mut sorted = levels.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let floor = sorted.get(sorted.len() * 15 / 100).copied().unwrap_or(0.0);
        (floor * 2.5).max(0.004)
    }

    /// Where speech starts and ends in `samples` (with a margin), or None when silent: Silero,
    /// or loudness when the detector isn't installed.
    pub fn speech(samples: &[f32], rate: u32) -> Option<(usize, usize)> {
        if let Some(bounds) = crate::voice_engine::speech_bounds(samples, rate as i32, MARGIN_MS) {
            return Some(bounds);
        }
        speech_by_level(samples, rate)
    }

    fn speech_by_level(samples: &[f32], rate: u32) -> Option<(usize, usize)> {
        let (levels, frame) = levels(samples, rate);
        let t = threshold(&levels);
        let first = levels.iter().position(|l| *l > t)?;
        let last = levels.iter().rposition(|l| *l > t)?;
        let margin = MARGIN_MS / FRAME_MS;
        Some((first.saturating_sub(margin) * frame, ((last + 1 + margin) * frame).min(samples.len())))
    }

    /// A pause to cut at, after `from`, with enough speech before it, and how long that pause
    /// was. A pause is only used once it's over (speech started again) or clearly long, so its
    /// length is known.
    fn cut(samples: &[f32], rate: u32, from: usize) -> Option<(usize, usize)> {
        let (all, frame) = levels(samples, rate);
        let t = threshold(&all);
        let start = from / frame;
        let need = PAUSE_MS / FRAME_MS;
        let long = LONG_PAUSE_MS / FRAME_MS;
        let min_frames = MIN_PIECE_MS / FRAME_MS;
        // The newest frame may still be filling: leave it out.
        let usable = all.len().saturating_sub(1);
        let mut quiet = 0;
        let mut spoke = false;
        for i in start..usable {
            if all[i] > t {
                if spoke && quiet >= need && i - quiet - start >= min_frames {
                    return Some(((i - quiet / 2) * frame, quiet * FRAME_MS));
                }
                spoke = true;
                quiet = 0;
            } else {
                quiet += 1;
            }
        }
        if spoke && quiet >= long && usable - quiet - start >= min_frames {
            return Some(((usable - quiet / 2) * frame, quiet * FRAME_MS));
        }
        // No pause for a long stretch: the quietest 100 ms in its second half.
        if usable.saturating_sub(start) >= MAX_PIECE_MS / FRAME_MS {
            let window = 5;
            let from = start + (usable - start) / 2;
            let best = (from..usable.saturating_sub(window)).min_by(|a, b| {
                let sa: f32 = all[*a..*a + window].iter().sum();
                let sb: f32 = all[*b..*b + window].iter().sum();
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            })?;
            return Some(((best + window / 2) * frame, 0));
        }
        None
    }

    /// Words that carry on a sentence: a piece starting with one continues the last piece.
    const CARRY_ON: &[&str] = &[
        "and", "but", "or", "so", "then", "because", "which", "that", "who", "to", "with", "if", "when", "before", "after", "while", "until", "unless", "of",
        "for", "in", "on", "at", "from", "about", "like", "than", "as", "the", "a", "an", "we", "it", "you", "they", "he", "she", "my", "your", "our",
        "this", "these", "those", "is", "are", "was", "were", "be", "not", "just", "also", "still", "even", "too",
    ];

    /// Common words that start a sentence or carry one on — lowercased when a piece only follows
    /// a short pause. (Names aren't on it, so "Maya" keeps its capital.)
    const COMMON: &[&str] = &[
        "talk", "tell", "can", "could", "would", "will", "should", "do", "does", "did", "let", "let's", "please", "what", "how", "why", "where", "go", "make",
        "get", "take", "give", "see", "look", "open", "send", "put", "add", "remove", "maybe", "now", "here", "there", "yes", "no", "okay", "ok", "well",
        "anyway", "actually", "really", "right", "thanks", "sure", "all", "some", "every", "each", "one", "two", "three",
    ];

    /// Pieces read as one text. After a long pause the next piece is a new sentence; after a short
    /// one it carries on: no period and capital from Parakeet (which treats every piece as a
    /// sentence) — "…about this" + "And then…" → "…about this and then…".
    pub fn join(text: &mut String, piece: &str, gap_ms: usize) {
        let piece = piece.trim();
        if piece.is_empty() {
            return;
        }
        if text.is_empty() {
            text.push_str(piece);
            return;
        }
        let first = piece.split(|c: char| !c.is_alphanumeric() && c != '\'').next().unwrap_or("");
        let lower = first.to_lowercase();
        let carries = CARRY_ON.contains(&lower.as_str());
        // After a long pause only these keep the sentence going; everything else starts a new one.
        let strong = ["and", "but", "or", "because", "which", "that", "to", "with", "of", "for", "than"].contains(&lower.as_str());
        if gap_ms >= LONG_PAUSE_MS && !strong {
            text.push(' ');
            text.push_str(piece);
            return;
        }
        if text.ends_with('.') {
            text.pop();
            // A short pause is a comma — unless the next word itself carries the sentence on.
            if !carries {
                text.push(',');
            }
        }
        text.push(' ');
        let keep_capital = !(carries || COMMON.contains(&lower.as_str())) || first == "I" || first.starts_with("I'");
        if keep_capital {
            text.push_str(piece);
        } else {
            let mut chars = piece.chars();
            if let Some(c) = chars.next() {
                text.extend(c.to_lowercase());
                text.push_str(chars.as_str());
            }
        }
    }

    fn decode(piece: &[f32], rate: u32) -> String {
        let Some((a, b)) = speech(piece, rate) else { return String::new() };
        crate::voice_engine::transcribe(&piece[a..b], rate as i32).unwrap_or_default()
    }

    /// While held: turns the next finished piece into text. Returns the words so far when it did.
    pub fn step(session: u64, samples: &[f32], rate: u32) -> Option<String> {
        let from = {
            let live = LIVE.lock().unwrap();
            if live.session != session {
                return None;
            }
            live.done
        };
        let (end, gap) = cut(samples, rate, from)?;
        let _busy = DECODING.lock().unwrap();
        let text = decode(&samples[from..end], rate);
        let mut live = LIVE.lock().unwrap();
        if live.session != session || live.done != from {
            return None;
        }
        live.done = end;
        let before = live.gap_ms;
        join(&mut live.text, &text, before);
        live.gap_ms = gap;
        Some(live.text.clone())
    }

    /// Let go: the pieces already done, plus the rest.
    pub fn finish(samples: &[f32], rate: u32) -> String {
        let _busy = DECODING.lock().unwrap();
        let (done, mut text, gap) = {
            let mut live = LIVE.lock().unwrap();
            let out = (live.done.min(samples.len()), std::mem::take(&mut live.text), live.gap_ms);
            live.done = 0;
            out
        };
        let rest = decode(&samples[done..], rate);
        join(&mut text, &rest, gap);
        text.trim().to_string()
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn cuts_at_pauses_and_finds_speech() {
            let rate = 16_000;
            let tone = |ms: usize| (0..rate as usize * ms / 1000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect::<Vec<f32>>();
            let quiet = |ms: usize| vec![0.0005f32; rate as usize * ms / 1000];
            let mut audio = quiet(300);
            audio.extend(tone(4200));
            audio.extend(quiet(900));
            audio.extend(tone(800));
            audio.extend(quiet(100));
            // A breath (300 ms) is no place to cut.
            let mut breath = quiet(300);
            breath.extend(tone(4200));
            breath.extend(quiet(300));
            breath.extend(tone(1000));
            breath.extend(quiet(100));
            assert!(super::cut(&breath, rate, 0).is_none());
            let (at, gap) = super::cut(&audio, rate, 0).expect("a pause after the first stretch");
            assert!(gap >= 880, "pause {gap} ms");
            let seconds = at as f32 / rate as f32;
            assert!(seconds > 4.6 && seconds < 5.2, "cut at {seconds}s");
            // The second stretch is too short to cut on its own: it waits for the release.
            assert!(super::cut(&audio, rate, at).is_none());
            let (a, b) = super::speech_by_level(&audio, rate).unwrap();
            assert!(a as f32 / rate as f32 >= 0.0 && (b as f32 / rate as f32) <= 6.4);
            assert!(super::speech_by_level(&quiet(500), rate).is_none());
            let mut text = String::from("Talk to me first about this.");
            super::join(&mut text, "And then we will go ahead.", 650);
            super::join(&mut text, "No, before we go ahead.", 1100);
            super::join(&mut text, "Talk to me about the dictation.", 700);
            super::join(&mut text, "Then we can fix it with Maya.", 1200);
            super::join(&mut text, "Maya said yes.", 700);
            assert_eq!(text, "Talk to me first about this and then we will go ahead. No, before we go ahead, talk to me about the dictation. Then we can fix it with Maya, Maya said yes.");
        }
 
        #[test]
        #[ignore]
        fn faster_on_real_speech() {
            let dir = std::env::var("EV_WAVS").unwrap();
            let bytes = std::fs::read(format!("{dir}/{}", std::env::var("EV_WAV").unwrap_or("q3.wav".into()))).unwrap();
            let (samples, rate) = crate::voice_engine::decode_wav(&bytes).unwrap();
            let rate = rate as u32;
            let _ = crate::voice_engine::transcribe(&samples[..rate as usize], rate as i32);
            let t = std::time::Instant::now();
            let (a, b) = super::speech(&samples, rate).unwrap();
            let whole = crate::voice_engine::transcribe(&samples[a..b], rate as i32).unwrap();
            println!("one pass on release (Handy's way): {:?} → {whole:?}", t.elapsed());
            // As if held: pieces decoded as the audio arrives, every 250 ms.
            let session = super::begin();
            let step = rate as usize / 4;
            let mut end = step;
            while end < samples.len() {
                super::step(session, &samples[..end], rate);
                end += step;
            }
            let t = std::time::Instant::now();
            let text = super::finish(&samples, rate);
            println!("piece by piece, left on release: {:?} → {text:?}", t.elapsed());
        }
    }
}

/// The microphone, captured natively (Core Audio through cpal) on its own thread, since an input
/// stream can't move between threads.
mod mic {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    enum Command {
        Start,
        Stop(Sender<()>),
        Cancel,
    }

    /// Mono samples so far and their rate.
    static AUDIO: Mutex<(Vec<f32>, u32)> = Mutex::new((Vec::new(), 48_000));
    static COMMANDS: OnceLock<Mutex<Sender<Command>>> = OnceLock::new();

    fn push(data: &[f32], channels: usize) {
        let mut audio = AUDIO.lock().unwrap();
        audio.0.extend(data.chunks(channels.max(1)).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32));
    }

    fn open() -> Option<cpal::Stream> {
        let device = cpal::default_host().default_input_device()?;
        let config = device.default_input_config().ok()?;
        let channels = config.channels() as usize;
        {
            let mut audio = AUDIO.lock().unwrap();
            audio.0.clear();
            audio.1 = config.sample_rate().0;
        }
        let failed = |e| eprintln!("hold to talk: microphone error: {e}");
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |d: &[f32], _: &_| push(d, channels), failed, None),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |d: &[i16], _: &_| push(&d.iter().map(|s| *s as f32 / i16::MAX as f32).collect::<Vec<_>>(), channels),
                failed,
                None,
            ),
            _ => return None,
        }
        .ok()?;
        stream.play().ok()?;
        Some(stream)
    }

    fn sender() -> Sender<Command> {
        COMMANDS
            .get_or_init(|| {
                let (tx, rx) = channel::<Command>();
                std::thread::Builder::new()
                    .name("hold-to-talk-mic".into())
                    .spawn(move || {
                        let mut stream: Option<cpal::Stream> = None;
                        while let Ok(command) = rx.recv() {
                            match command {
                                Command::Start => {
                                    if stream.is_none() {
                                        stream = open();
                                    }
                                }
                                Command::Stop(done) => {
                                    stream = None;
                                    let _ = done.send(());
                                }
                                Command::Cancel => {
                                    stream = None;
                                    AUDIO.lock().unwrap().0.clear();
                                }
                            }
                        }
                    })
                    .expect("hold-to-talk mic thread");
                Mutex::new(tx)
            })
            .lock()
            .unwrap()
            .clone()
    }

    pub fn start() {
        let _ = sender().send(Command::Start);
    }

    /// Stops recording and hands over everything heard.
    pub fn stop() -> (Vec<f32>, u32) {
        let (done, wait) = channel();
        if sender().send(Command::Stop(done)).is_ok() {
            let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
        }
        let mut audio = AUDIO.lock().unwrap();
        (std::mem::take(&mut audio.0), audio.1)
    }

    pub fn snapshot() -> (Vec<f32>, u32) {
        let audio = AUDIO.lock().unwrap();
        (audio.0.clone(), audio.1)
    }

    pub fn cancel() {
        let _ = sender().send(Command::Cancel);
    }
}

extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: CGEventRef, _info: *mut c_void) -> CGEventRef {
    if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER {
        let tap = STATE.lock().map(|s| s.tap).unwrap_or(0);
        if tap != 0 {
            unsafe { CGEventTapEnable(tap as CFMachPortRef, true) };
        }
        return event;
    }
    let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
    let flags = unsafe { CGEventGetFlags(event) };
    if kind == KEY_DOWN && APPROVAL_KEYS.load(Ordering::Relaxed) && unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } == 0 {
        let combos = *APPROVAL_COMBOS.lock().unwrap();
        if let Some(index) = combos.iter().position(|c| *c == Some((code, flags & MODIFIERS))) {
            if let Some(app) = APP.get() {
                let _ = app.emit_to("main", "approval-key", ["approve", "always", "deny"][index]);
            }
            return std::ptr::null_mut();
        }
    }
    if kind == KEY_DOWN && unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } == 0 && *PANEL_COMBO.lock().unwrap() == Some((code, flags & MODIFIERS)) {
        if let Some(app) = APP.get() {
            crate::panel::toggle(app);
        }
        return std::ptr::null_mut();
    }
    if kind == KEY_DOWN && unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } == 0 && *CLIP_COMBO.lock().unwrap() == Some((code, flags & MODIFIERS)) {
        if let Some(app) = APP.get() {
            crate::clipboard::shortcut(app);
        }
        return std::ptr::null_mut();
    }
    // ⌘ tapped twice on its own (no other key): hands-free on or off.
    if DOUBLE_COMMAND.load(Ordering::Relaxed) {
        let mut tap = COMMAND_TAP.lock().unwrap();
        if kind == FLAGS_CHANGED && (code == 55 || code == 54) {
            let alone = flags & MODIFIERS == COMMAND;
            if alone {
                tap.0 = Some(std::time::Instant::now());
            } else if flags & MODIFIERS == 0 {
                if let Some(down) = tap.0.take() {
                    let now = std::time::Instant::now();
                    if now.duration_since(down).as_millis() < 300 {
                        if tap.1.is_some_and(|last| now.duration_since(last).as_millis() < 450) {
                            tap.1 = None;
                            if let Some(app) = APP.get() {
                                let _ = app.emit_to("main", "handsfree-toggle", ());
                            }
                        } else {
                            tap.1 = Some(now);
                        }
                    }
                }
            }
        } else if kind == KEY_DOWN || kind == FLAGS_CHANGED {
            // ⌘ used with another key (⌘C…): not a tap.
            *tap = (None, None);
        }
    }
    if let Some(out) = key(&DICTATE, true, kind, code, flags, event) {
        return out;
    }
    key(&STATE, false, kind, code, flags, event).unwrap_or(event)
}

/// The key down: recording starts, for E.V or for typing into the front app.
fn start(dictate: bool) {
    DICTATING.store(dictate, Ordering::SeqCst);
    emit("down");
}

/// One hold key's logic. Some(event or null) when it handled the event, None to keep looking.
fn key(slot: &Mutex<State>, dictate: bool, kind: u32, code: i64, flags: u64, event: CGEventRef) -> Option<CGEventRef> {
    // While the other key is recording, this one stays out of the way.
    if DICTATING.load(Ordering::SeqCst) != dictate && HOLDING.load(Ordering::SeqCst) {
        return None;
    }
    let Ok(mut state) = slot.lock() else { return None };
    let Some(spec) = state.spec else { return None };
    match spec {
        Spec::Combo { code: want, flags: want_flags } => {
            if kind == KEY_DOWN && code == ESCAPE && state.held {
                state.held = false;
                drop(state);
                emit("cancel");
                return Some(std::ptr::null_mut());
            }
            if code != want || !matches!(kind, KEY_DOWN | KEY_UP) {
                return None;
            }
            if kind == KEY_DOWN {
                if state.held {
                    return Some(std::ptr::null_mut()); // key repeat while held
                }
                let repeat = unsafe { CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) } != 0;
                if flags & MODIFIERS != want_flags || repeat {
                    return None;
                }
                state.held = true;
                drop(state);
                start(dictate);
                return Some(std::ptr::null_mut());
            }
            if state.held {
                state.held = false;
                drop(state);
                emit("up");
                return Some(std::ptr::null_mut());
            }
            None
        }
        Spec::Alone { code: want, flag } => {
            if kind == FLAGS_CHANGED && code == want {
                let down = flags & flag != 0 && flags & MODIFIERS & !flag == 0;
                if down && !state.held {
                    state.held = true;
                    drop(state);
                    start(dictate);
                } else if !down && state.held {
                    state.held = false;
                    drop(state);
                    emit("up");
                }
                return Some(event);
            }
            // Another key while it's held: it was used as a modifier (fn+Delete, ⌥+letter), not to talk.
            if kind == KEY_DOWN && state.held {
                state.held = false;
                drop(state);
                emit("cancel");
            }
            None
        }
    }
}

/// Starts the keyboard watcher once (hold to talk and the approval keys share it).
pub(crate) fn ensure_tap(app: &AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    if STATE.lock().unwrap().tap != 0 {
        return Ok(());
    }
    start_tap()
}

pub(crate) fn set_approval_keys(on: bool) {
    APPROVAL_KEYS.store(on, Ordering::Relaxed);
}

/// The user's approve / approve always / cancel shortcuts (key combos from Settings → Approvals).
#[tauri::command]
pub fn approval_keys_configure(app: AppHandle, approve: String, always: String, cancel: String) -> Result<(), String> {
    let combo = |s: &str| match parse(s) {
        Ok(Spec::Combo { code, flags }) => Ok(Some((code, flags))),
        Ok(Spec::Alone { .. }) => Err(format!("\"{s}\" is a single key; approval shortcuts need a combo")),
        Err(e) => Err(e),
    };
    let combos = [combo(&approve)?, combo(&always)?, combo(&cancel)?];
    *APPROVAL_COMBOS.lock().unwrap() = combos;
    ensure_tap(&app)
}

/// The quick panel's shortcut (a key combo from Settings → Voice & shortcuts), or none.
#[tauri::command]
pub fn panel_configure(app: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    let combo = match shortcut.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => match parse(s)? {
            Spec::Combo { code, flags } => Some((code, flags)),
            Spec::Alone { .. } => return Err(format!("\"{s}\" is a single key; the panel shortcut needs a combo")),
        },
    };
    *PANEL_COMBO.lock().unwrap() = combo;
    if combo.is_some() {
        ensure_tap(&app)?;
    }
    Ok(())
}

/// The clipboard history's shortcut (a key combo), or none.
pub(crate) fn clip_shortcut(app: &AppHandle, shortcut: Option<String>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    let combo = match shortcut.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => match parse(s)? {
            Spec::Combo { code, flags } => Some((code, flags)),
            Spec::Alone { .. } => return Err(format!("\"{s}\" is a single key; the clipboard shortcut needs a combo")),
        },
    };
    *CLIP_COMBO.lock().unwrap() = combo;
    if combo.is_some() {
        ensure_tap(app)?;
    }
    Ok(())
}

/// On while an approval is waiting, so the shortcuts never take keys from other apps otherwise.
#[tauri::command]
pub fn approval_keys_active(on: bool) {
    set_approval_keys(on);
}

fn start_tap() -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("hold-to-talk".into())
        .spawn(move || unsafe {
            let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
            // Session tap, head insert, active filter (so a combo's own key presses can be kept from the app in front).
            let tap = CGEventTapCreate(1, 0, 0, mask, on_event, std::ptr::null_mut());
            if tap.is_null() {
                let _ = tx.send(false);
                return;
            }
            STATE.lock().unwrap().tap = tap as usize;
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            let _ = tx.send(true);
            CFRunLoopRun();
        })
        .map_err(|e| e.to_string())?;
    match rx.recv() {
        Ok(true) => Ok(()),
        _ => Err("PERMISSION:accessibility".into()),
    }
}

// ── E.V's small windows ─────────────────────────────────────────────────────

/// Puts one of E.V's small windows in front of every app without activating E.V, or hides it.
pub(crate) fn order(app: &AppHandle, label: &str, show: bool) {
    let Some(window) = app.get_webview_window(label) else { return };
    let _ = app.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let Ok(ns) = window.ns_window() else { return };
        let ns = ns as *mut AnyObject;
        if ns.is_null() {
            return;
        }
        unsafe {
            if show {
                let _: () = msg_send![ns, orderFrontRegardless];
            } else {
                let _: () = msg_send![ns, orderOut: std::ptr::null::<AnyObject>()];
            }
        }
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Dictation's hold key (types into the front app), or none; and double-tap ⌘ for hands-free.
#[tauri::command]
pub fn dictate_configure(app: AppHandle, shortcut: Option<String>, double_command: bool) -> Result<(), String> {
    let _ = APP.set(app.clone());
    DOUBLE_COMMAND.store(double_command, Ordering::Relaxed);
    let spec = match shortcut.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(parse(s)?),
        None => None,
    };
    if spec.is_some() || double_command {
        ensure_tap(&app)?;
    }
    let mut state = DICTATE.lock().unwrap();
    state.spec = spec;
    state.held = false;
    Ok(())
}

/// Turns hold to talk on with this shortcut, or off.
#[tauri::command]
pub fn ptt_configure(app: AppHandle, enabled: bool, shortcut: String) -> Result<(), String> {
    let _ = APP.set(app.clone());
    if !enabled {
        let mut state = STATE.lock().unwrap();
        state.spec = None;
        state.held = false;
        return Ok(());
    }
    let spec = parse(&shortcut)?;
    ensure_tap(&app)?;
    let mut state = STATE.lock().unwrap();
    state.spec = Some(spec);
    state.held = false;
    Ok(())
}

