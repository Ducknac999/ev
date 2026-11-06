//! Background commands for the agent: a dev server, a long build or a watcher keeps running while
//! the AI does other things; it reads new output when it wants and stops it when done. Each runs
//! in its own process group so stopping it (or quitting E.V) ends everything it started.

use crate::shell_env::expand_tilde;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Output kept per command; older output is dropped (and counted) once this fills up.
const KEEP_BYTES: usize = 400_000;
/// At most this much new output comes back per read.
const READ_CHARS: usize = 30_000;
const MAX_RUNNING: usize = 8;

struct Job {
    command: String,
    cwd: String,
    started: Instant,
    child: Mutex<Child>,
    output: Mutex<Buffer>,
}

#[derive(Default)]
struct Buffer {
    text: String,
    /// Bytes dropped from the front so far (so read positions stay valid).
    dropped: usize,
    /// Position (in the whole stream) the AI has read up to.
    read_to: usize,
}

impl Buffer {
    fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() > KEEP_BYTES {
            let mut cut = self.text.len() - KEEP_BYTES;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
            self.dropped += cut;
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn exit_code(job: &Job) -> Option<Option<i32>> {
    job.child.lock().unwrap().try_wait().ok().flatten().map(|s| s.code())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgStatus {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub seconds: u64,
    /// Output since the last read.
    pub output: String,
    /// Older output was dropped from the kept window before it was read.
    pub skipped: usize,
}

pub fn start(cwd: &str, command: &str) -> Result<String, String> {
    let running = jobs().lock().unwrap().values().filter(|j| exit_code(j).is_none()).count();
    if running >= MAX_RUNNING {
        return Err(format!("{MAX_RUNNING} background commands are already running — stop one first (command_stop)"));
    }
    let dir = expand_tilde(cwd);
    let mut cmd = Command::new("/bin/zsh");
    cmd.args(["-l", "-c", command])
        .current_dir(if dir.is_dir() { dir } else { crate::shell_env::home_dir() })
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let id = format!("bg{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let job = Arc::new(Job { command: command.to_string(), cwd: cwd.to_string(), started: Instant::now(), child: Mutex::new(child), output: Mutex::default() });
    for stream in [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
        let job = job.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut buf = [0u8; 8192];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                job.output.lock().unwrap().push(&String::from_utf8_lossy(&buf[..n]));
            }
        });
    }
    jobs().lock().unwrap().insert(id.clone(), job);
    Ok(id)
}

/// New output since the last read; waits up to `wait` for the command to finish or print more.
pub fn read(id: &str, wait: Duration) -> Result<BgStatus, String> {
    let job = jobs().lock().unwrap().get(id).cloned().ok_or_else(|| format!("no background command {id}"))?;
    let deadline = Instant::now() + wait;
    loop {
        let fresh = {
            let out = job.output.lock().unwrap();
            out.dropped + out.text.len() > out.read_to
        };
        if fresh || exit_code(&job).is_some() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    // A finished command's last output may still be on its way through the pipe.
    let code = exit_code(&job);
    if code.is_some() {
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut out = job.output.lock().unwrap();
    let total = out.dropped + out.text.len();
    let skipped = out.dropped.saturating_sub(out.read_to);
    let from = out.read_to.max(out.dropped) - out.dropped;
    let mut start = from;
    while !out.text.is_char_boundary(start) {
        start += 1;
    }
    let mut text = out.text[start..].to_string();
    let mut end = total;
    if text.chars().count() > READ_CHARS {
        text = text.chars().take(READ_CHARS).collect();
        end = out.dropped + start + text.len();
    }
    out.read_to = end;
    Ok(BgStatus {
        id: id.to_string(),
        command: job.command.clone(),
        cwd: job.cwd.clone(),
        running: code.is_none(),
        exit_code: code.flatten(),
        seconds: job.started.elapsed().as_secs(),
        output: text,
        skipped,
    })
}

fn kill_group(job: &Job, signal: i32) {
    let pid = job.child.lock().unwrap().id() as i32;
    unsafe {
        libc::killpg(pid, signal);
    }
}

pub fn stop(id: &str) -> Result<BgStatus, String> {
    let job = jobs().lock().unwrap().get(id).cloned().ok_or_else(|| format!("no background command {id}"))?;
    if exit_code(&job).is_none() {
        kill_group(&job, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(3);
        while exit_code(&job).is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if exit_code(&job).is_none() {
            kill_group(&job, libc::SIGKILL);
            let _ = job.child.lock().unwrap().wait();
        }
    }
    let status = read(id, Duration::ZERO);
    jobs().lock().unwrap().remove(id);
    status
}

/// Ends every background command (E.V is quitting).
pub fn stop_all() {
    let all: Vec<Arc<Job>> = jobs().lock().unwrap().drain().map(|(_, j)| j).collect();
    for job in &all {
        if exit_code(job).is_none() {
            kill_group(job, libc::SIGTERM);
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    for job in &all {
        if exit_code(job).is_none() {
            kill_group(job, libc::SIGKILL);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgSummary {
    pub id: String,
    pub command: String,
    pub running: bool,
    pub seconds: u64,
}

pub fn list() -> Vec<BgSummary> {
    let mut out: Vec<BgSummary> = jobs()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, j)| BgSummary { id: id.clone(), command: j.command.clone(), running: exit_code(j).is_none(), seconds: j.started.elapsed().as_secs() })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[tauri::command]
pub async fn tool_bg_start(cwd: String, command: String) -> Result<String, String> {
    start(&cwd, &command)
}

#[tauri::command]
pub async fn tool_bg_read(id: String, wait_seconds: Option<u64>) -> Result<BgStatus, String> {
    let wait = Duration::from_secs(wait_seconds.unwrap_or(0).min(120));
    tauri::async_runtime::spawn_blocking(move || read(&id, wait)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tool_bg_stop(id: String) -> Result<BgStatus, String> {
    tauri::async_runtime::spawn_blocking(move || stop(&id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tool_bg_list() -> Vec<BgSummary> {
    list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_reads_and_stops() {
        let id = start("/tmp", "echo first; sleep 0.3; echo second; sleep 30").unwrap();
        let a = read(&id, Duration::from_secs(5)).unwrap();
        assert!(a.running);
        assert!(a.output.contains("first"), "{:?}", a.output);
        let b = read(&id, Duration::from_secs(5)).unwrap();
        assert!(b.output.contains("second") && !b.output.contains("first"), "{:?}", b.output);
        let stopped = stop(&id).unwrap();
        assert!(!stopped.running);
        assert!(read(&id, Duration::ZERO).is_err());
    }

    #[test]
    fn reports_exit_codes() {
        let id = start("/tmp", "echo done; exit 3").unwrap();
        let mut status = read(&id, Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while status.running && Instant::now() < deadline {
            status = read(&id, Duration::from_secs(1)).unwrap();
        }
        assert!(!status.running);
        assert_eq!(status.exit_code, Some(3));
        stop(&id).unwrap();
    }

    #[test]
    fn keeps_a_bounded_window() {
        let mut b = Buffer::default();
        b.push(&"x".repeat(KEEP_BYTES));
        b.push("tail");
        assert_eq!(b.text.len(), KEEP_BYTES);
        assert_eq!(b.dropped, 4);
        assert!(b.text.ends_with("tail"));
    }
}
