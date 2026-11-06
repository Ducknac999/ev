use crate::shell_env::{expand_tilde, home_dir};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::State;

/// Lines of history kept for the notch's live view.
pub const SCROLLBACK: usize = 2000;
/** How far back to look for the previous newest lines once the scrollback is full. */
const SCROLL_SEARCH: usize = 600;

/// Text of the scrollback line `offset` back from the screen (1 = newest). Leaves the view at 0.
pub fn scrollback_row_text(parser: &mut vt100::Parser, offset: usize) -> String {
    parser.set_scrollback(offset);
    let cols = parser.screen().size().1;
    let text = parser.screen().rows(0, cols).next().unwrap_or_default();
    parser.set_scrollback(0);
    text
}

/// Lines held in the parser's scrollback.
pub fn scrollback_len(parser: &mut vt100::Parser) -> usize {
    parser.set_scrollback(usize::MAX);
    let len = parser.screen().scrollback();
    parser.set_scrollback(0);
    len
}

/// How many lines scrolled off since `before` (length, newest lines), and the new probe. vt100
/// doesn't count scrolled lines, so once its scrollback is full the old newest lines are found again.
fn scrolled_since(parser: &mut vt100::Parser, before: &(usize, Vec<String>)) -> (usize, (usize, Vec<String>)) {
    let len = scrollback_len(parser);
    let newest = |parser: &mut vt100::Parser, from: usize, count: usize| -> Vec<String> {
        (from..from + count).filter(|o| *o <= len).map(|o| scrollback_row_text(parser, o)).collect()
    };
    let added = if before.0 == 0 {
        len
    } else if len > before.0 && len < SCROLLBACK {
        len - before.0
    } else if len < before.0 {
        0 // cleared
    } else {
        let wanted = before.1.len();
        (0..=SCROLL_SEARCH.min(len.saturating_sub(wanted)))
            .find(|d| newest(parser, d + 1, wanted) == before.1)
            .unwrap_or(SCROLL_SEARCH.min(len))
    };
    let probe = (len, newest(parser, 1, 3.min(len)));
    (added, probe)
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PtyKind {
    Claude,
    Shell,
    Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub id: String,
    pub kind: PtyKind,
    pub cwd: String,
    /// Shell command for `command` sessions; ignored otherwise.
    pub command: Option<String>,
    /// Extra arguments for `claude` (e.g. `--resume <id>` or `--session-id <uuid>`).
    pub claude_args: Option<Vec<String>>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Output { data: String },
    Exit { code: i32 },
}

pub struct PtySession {
    pub id: String,
    pub kind: PtyKind,
    pub cwd: String,
    pub started: f64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    /// Separate from the child itself: the exit watcher holds the child while it waits.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub pid: Option<u32>,
    pub parser: Mutex<vt100::Parser>,
    /// Bumped on every output chunk so viewers know when to redraw.
    pub generation: AtomicU64,
    /// Lines that have ever scrolled off the top of the screen: the absolute index of the top
    /// visible line, so the notch can be sent exactly the lines it hasn't seen.
    pub scrolled: AtomicU64,
    pub exit_code: Mutex<Option<i32>>,
    /// Grid the E.V window wants; the notch may temporarily claim another size.
    pub window_grid: Mutex<(u16, u16)>,
    /// Runs inside a tmux session (named by `id`), so it survives E.V quitting or updating;
    /// the process E.V holds is only the tmux client showing it.
    pub tmux: bool,
}

impl PtySession {
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(data).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.clamp(10, 1000);
        let rows = rows.clamp(3, 500);
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        self.parser.lock().unwrap().set_size(rows, cols);
        self.generation.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Process group currently in the terminal's foreground (the running program). Inside tmux
    /// that is the pane's foreground group, not the tmux client's.
    pub fn foreground_pgid(&self) -> Option<i32> {
        if self.tmux {
            let pane = tmux::pane_pid(&self.id)?;
            let out = std::process::Command::new("/bin/ps").args(["-o", "tpgid=", "-p", &pane.to_string()]).output().ok()?;
            return String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|p: &i32| *p > 0);
        }
        self.master.lock().unwrap().process_group_leader()
    }

    /// The process whose tree is this session's work: the pane's shell inside tmux, else the shell.
    fn root_pid(&self) -> Option<i32> {
        if self.tmux {
            return tmux::pane_pid(&self.id);
        }
        self.pid.map(|p| p as i32)
    }

    pub fn signal_foreground(&self, signal: i32) -> bool {
        match self.foreground_pgid() {
            Some(pgid) if pgid > 0 => unsafe { libc::kill(-pgid, signal) == 0 },
            _ => false,
        }
    }

    pub fn is_running(&self) -> bool {
        self.exit_code.lock().unwrap().is_none()
    }

    /// Every process in this session's tree, the shell first.
    fn process_tree(&self) -> Vec<(i32, String)> {
        let Some(root) = self.pid.map(|p| p as i32) else { return Vec::new() };
        Self::tree_of(root)
    }

    fn tree_of(root: i32) -> Vec<(i32, String)> {
        let table = process_table();
        let mut tree: Vec<(i32, String)> = table.iter().filter(|r| r.pid == root).map(|r| (r.pid, r.comm.clone())).collect();
        let mut i = 0;
        while i < tree.len() {
            let parent = tree[i].0;
            tree.extend(table.iter().filter(|r| r.ppid == parent).map(|r| (r.pid, r.comm.clone())));
            i += 1;
        }
        tree
    }

    /// Hangs up the whole tree like closing a Terminal tab. Interactive shells give each job its
    /// own process group, so every process is signalled, not just the shell's group. Returns the
    /// processes to force-kill if they ignore the hang-up.
    fn hang_up(&self) -> Vec<(i32, String)> {
        let tree = self.process_tree();
        for &(pid, _) in &tree {
            unsafe {
                libc::kill(pid, libc::SIGHUP);
                libc::kill(pid, libc::SIGCONT);
            }
        }
        let _ = self.killer.lock().unwrap().kill();
        tree
    }

    /// Ends the session for good: inside tmux the session itself is closed, not just its viewer.
    fn end(&self) {
        if self.tmux {
            tmux::kill_session(&self.id);
        }
        self.kill();
    }

    fn kill(&self) {
        let tree = self.hang_up();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            force_kill(&tree);
        });
    }
}

/// SIGKILLs the given processes that are still alive and still the same program, so a reused
/// process id never hits something unrelated.
fn force_kill(processes: &[(i32, String)]) {
    let table = process_table();
    for (pid, comm) in processes {
        if table.iter().any(|r| r.pid == *pid && &r.comm == comm) {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyRegistry {
    pub fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn all(&self) -> Vec<Arc<PtySession>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Called when E.V quits. Sessions inside tmux keep running (only their viewers close) and
    /// are picked up again next launch; anything else is ended so no orphaned shells stay behind.
    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        let stubborn: Vec<(i32, String)> = sessions.iter().flat_map(|s| s.hang_up()).collect();
        if !stubborn.is_empty() {
            // E.V is quitting, so a background timer would never fire.
            std::thread::sleep(std::time::Duration::from_millis(400));
            force_kill(&stubborn);
        }
    }
}

fn login_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}

/// Quotes one argument for a POSIX shell command line.
fn shell_quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn command_for(request: &SpawnRequest, shell: &str) -> CommandBuilder {
    let keep_alive = format!("exec {} -l", shell_quote(shell));
    let mut cmd = CommandBuilder::new(shell);
    match request.kind {
        PtyKind::Shell => {
            cmd.arg("-l");
        }
        PtyKind::Claude => {
            let mut line = String::from("claude");
            for arg in request.claude_args.iter().flatten() {
                line.push(' ');
                line.push_str(&shell_quote(arg));
            }
            cmd.args(["-l", "-i", "-c", &format!("{line}; {keep_alive}")]);
        }
        PtyKind::Command => {
            let command = request.command.clone().unwrap_or_default();
            cmd.args(["-l", "-i", "-c", &format!("{command}; {keep_alive}")]);
        }
    }
    cmd
}

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Starts a terminal session and streams its output until the process exits.
#[tauri::command]
pub async fn pty_spawn(
    request: SpawnRequest,
    on_event: Channel<PtyEvent>,
    registry: State<'_, Arc<PtyRegistry>>,
) -> Result<(), String> {
    // Starting a session that is already open here is a restart: end the old one for real.
    if let Some(existing) = registry.get(&request.id) {
        existing.end();
    }
    let cwd = {
        let path = expand_tilde(&request.cwd);
        if path.is_dir() { path } else { home_dir() }
    };
    let shell = login_shell();
    let pair = native_pty_system()
        .openpty(PtySize { rows: request.rows.max(3), cols: request.cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not open a terminal: {e}"))?;

    let tmux_bin = tmux::binary();
    let attaching = tmux_bin.is_some() && tmux::exists(&request.id);
    // A session tmux kept while E.V was closed: show what it printed meanwhile, then reattach.
    let history = if attaching { tmux::history(&request.id) } else { String::new() };
    let mut cmd = match &tmux_bin {
        Some(bin) => tmux::command(bin, &request, &cwd, &command_for(&request, &shell)),
        None => command_for(&request, &shell),
    };
    cmd.cwd(&cwd);
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDECODE") || key.starts_with("CLAUDE_CODE_") || key == "TERM_SESSION_ID" || key == "ITERM_SESSION_ID" {
            cmd.env_remove(&key);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "E.V");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    // Lets Claude Code hooks (and so the Vorssaint notch) tie their events to this session.
    cmd.env("CLAUDEDESK_SESSION_ID", &request.id);
    cmd.env("GIDEON_SESSION_ID", &request.id);

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("could not start {shell}: {e}"))?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = Arc::new(PtySession {
        id: request.id.clone(),
        kind: request.kind,
        cwd: cwd.display().to_string(),
        started: now_secs(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        pid,
        parser: Mutex::new(vt100::Parser::new(request.rows.max(3), request.cols.max(10), SCROLLBACK)),
        generation: AtomicU64::new(0),
        scrolled: AtomicU64::new(0),
        exit_code: Mutex::new(None),
        window_grid: Mutex::new((request.cols, request.rows)),
        tmux: tmux_bin.is_some(),
    });
    registry.sessions.lock().unwrap().insert(request.id.clone(), session.clone());

    if !history.is_empty() {
        let mut parser = session.parser.lock().unwrap();
        parser.process(history.as_bytes());
        let (added, _) = scrolled_since(&mut parser, &(0, Vec::new()));
        session.scrolled.store(added as u64, Ordering::Relaxed);
        drop(parser);
        let _ = on_event.send(PtyEvent::Output { data: history });
    }
    let reading = session.clone();
    let output = on_event.clone();
    let reader_thread = std::thread::Builder::new().name(format!("pty-{}", request.id)).spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        let mut probe = (0usize, Vec::<String>::new());
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            {
                let mut parser = reading.parser.lock().unwrap();
                parser.process(&buf[..n]);
                let (added, next) = scrolled_since(&mut parser, &probe);
                probe = next;
                if added > 0 {
                    reading.scrolled.fetch_add(added as u64, Ordering::Relaxed);
                }
            }
            reading.generation.fetch_add(1, Ordering::Relaxed);
            pending.extend_from_slice(&buf[..n]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid > 0 {
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                // A closed channel (window reloaded) must not stop the parser feeding the notch.
                let _ = output.send(PtyEvent::Output { data: text });
            }
        }
    });
    reader_thread.map_err(|e| e.to_string())?;

    // Wait for exit off the async runtime.
    let waiting = session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        let status = child.wait();
        let code = status.map(|s| s.exit_code() as i32).unwrap_or(-1);
        *waiting.exit_code.lock().unwrap() = Some(code);
        waiting.generation.fetch_add(1, Ordering::Relaxed);
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(id: String, data: String, registry: State<'_, Arc<PtyRegistry>>) -> Result<(), String> {
    registry.get(&id).ok_or("session not found")?.write(data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16, registry: State<'_, Arc<PtyRegistry>>) -> Result<(), String> {
    let session = registry.get(&id).ok_or("session not found")?;
    *session.window_grid.lock().unwrap() = (cols, rows);
    session.resize(cols, rows)
}

/// Sends a signal to the program in the foreground: INT, TERM or KILL.
#[tauri::command]
pub fn pty_signal(id: String, signal: String, registry: State<'_, Arc<PtyRegistry>>) -> Result<bool, String> {
    let session = registry.get(&id).ok_or("session not found")?;
    let sig = match signal.as_str() {
        "INT" => libc::SIGINT,
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        _ => return Err("unknown signal".into()),
    };
    Ok(session.signal_foreground(sig))
}

#[tauri::command]
pub fn pty_kill(id: String, registry: State<'_, Arc<PtyRegistry>>) {
    let removed = registry.sessions.lock().unwrap().remove(&id);
    match removed {
        Some(session) => session.end(),
        // A tmux session E.V isn't showing (e.g. closed while it was starting): end it anyway.
        None => tmux::kill_session(&id),
    }
}

/// Plain text of the whole session (scrollback + screen), for "copy log" and "save log".
#[tauri::command]
pub fn pty_log(id: String, registry: State<'_, Arc<PtyRegistry>>) -> Result<String, String> {
    let session = registry.get(&id).ok_or("session not found")?;
    let mut parser = session.parser.lock().unwrap();
    let (rows, cols) = parser.screen().size();
    // Temporarily scroll through history to collect every line, then restore.
    let mut lines: Vec<String> = Vec::new();
    parser.set_scrollback(usize::MAX);
    let total_back = parser.screen().scrollback();
    for offset in (1..=total_back).rev() {
        parser.set_scrollback(offset);
        if let Some(first) = parser.screen().rows(0, cols).next() {
            lines.push(first);
        }
    }
    parser.set_scrollback(0);
    lines.extend(parser.screen().rows(0, cols).take(rows as usize));
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    Ok(lines.iter().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStats {
    pub id: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Name of the program in the foreground (e.g. `claude`, `npm`, `zsh`).
    pub foreground: String,
    pub cpu: f64,
    pub memory_mb: f64,
    pub processes: usize,
    pub title: String,
}

struct ProcRow {
    pid: i32,
    ppid: i32,
    cpu: f64,
    rss_kb: f64,
    comm: String,
}

fn process_table() -> Vec<ProcRow> {
    let Ok(output) = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid=,ppid=,%cpu=,rss=,comm="]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some(ProcRow {
                pid: parts.next()?.parse().ok()?,
                ppid: parts.next()?.parse().ok()?,
                cpu: parts.next()?.parse().ok()?,
                rss_kb: parts.next()?.parse().ok()?,
                comm: parts.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

fn base_name(comm: &str) -> String {
    comm.rsplit('/').next().unwrap_or(comm).trim_start_matches('-').to_string()
}

/// CPU, memory and foreground program for every session (summed over each process tree).
#[tauri::command]
pub fn pty_stats(registry: State<'_, Arc<PtyRegistry>>) -> Vec<PtyStats> {
    let table = process_table();
    let mut children: HashMap<i32, Vec<usize>> = HashMap::new();
    for (i, row) in table.iter().enumerate() {
        children.entry(row.ppid).or_default().push(i);
    }
    registry
        .all()
        .into_iter()
        .map(|session| {
            let (mut cpu, mut rss, mut count) = (0.0, 0.0, 0usize);
            if let Some(root) = session.root_pid() {
                let mut stack = vec![root];
                if let Some(row) = table.iter().find(|r| r.pid == root) {
                    cpu += row.cpu;
                    rss += row.rss_kb;
                    count += 1;
                }
                while let Some(pid) = stack.pop() {
                    for &i in children.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                        cpu += table[i].cpu;
                        rss += table[i].rss_kb;
                        count += 1;
                        stack.push(table[i].pid);
                    }
                }
            }
            let foreground = session
                .foreground_pgid()
                .and_then(|pgid| table.iter().find(|r| r.pid == pgid))
                .map(|r| base_name(&r.comm))
                .unwrap_or_default();
            let title = session.parser.lock().unwrap().screen().title().to_string();
            PtyStats {
                id: session.id.clone(),
                running: session.is_running(),
                exit_code: *session.exit_code.lock().unwrap(),
                foreground,
                cpu: (cpu * 10.0).round() / 10.0,
                memory_mb: (rss / 1024.0 * 10.0).round() / 10.0,
                processes: count,
                title,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_shell_arguments() {
        assert_eq!(shell_quote("--resume"), "--resume");
        assert_eq!(shell_quote("1b2c-3d"), "1b2c-3d");
        assert_eq!(shell_quote("it's here"), "'it'\\''s here'");
        assert_eq!(shell_quote(""), "''");
    }
}

#[cfg(test)]
mod scroll_tests {
    use super::*;

    fn feed(parser: &mut vt100::Parser, probe: &mut (usize, Vec<String>), text: &str) -> usize {
        parser.process(text.as_bytes());
        let (added, next) = scrolled_since(parser, probe);
        *probe = next;
        added
    }

    #[test]
    fn counts_every_line_that_scrolls_off_even_when_the_history_is_full() {
        let mut parser = vt100::Parser::new(10, 40, SCROLLBACK);
        let mut probe = (0usize, Vec::new());
        let mut total = 0;
        // 10 rows: the first 9 lines fit on screen (the cursor sits on the 10th).
        total += feed(&mut parser, &mut probe, &(1..=9).map(|n| format!("line {n}\r\n")).collect::<String>());
        assert_eq!(total, 0);
        total += feed(&mut parser, &mut probe, "line 10\r\nline 11\r\n");
        assert_eq!(total, 2);
        // Past the 2000-line history, in uneven chunks.
        for chunk in (12..=2600).collect::<Vec<_>>().chunks(137) {
            total += feed(&mut parser, &mut probe, &chunk.iter().map(|n| format!("line {n}\r\n")).collect::<String>());
        }
        assert_eq!(total, 2600 - 9);
        assert_eq!(scrollback_row_text(&mut parser, 1), "line 2591");
        // Output that doesn't scroll adds nothing.
        assert_eq!(feed(&mut parser, &mut probe, "\x1b[2;1Hupdated in place"), 0);
    }
}

/// tmux, on E.V's own server (`-L gideon`) with a config that keeps it invisible: no status bar,
/// no prefix key, E.V's scrolling and selection unchanged. Sessions are named by E.V's ids.
mod tmux {
    use super::SpawnRequest;
    use portable_pty::CommandBuilder;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// E.V's own tmux server (tests use their own, so they never touch real sessions).
    fn server() -> String {
        std::env::var("GIDEON_TMUX_SERVER").unwrap_or_else(|_| "ev".into())
    }
    const CONFIG: &str = r##"# Written by E.V: tmux only keeps sessions alive; E.V's window shows them.
set -g status off
set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
set -g mouse off
set -g history-limit 20000
set -g escape-time 0
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:RGB,xterm*:smcup@:rmcup@"
set -g set-titles on
set -g set-titles-string "#{pane_title}"
set -g focus-events on
set -g window-size latest
set -g aggressive-resize on
set -g bell-action any
set -g visual-bell off
set -g allow-passthrough on
set -g extended-keys on
set -g exit-empty on
set -g destroy-unattached off
"##;

    pub fn binary() -> Option<PathBuf> {
        crate::shell_env::which("tmux")
    }

    fn config() -> PathBuf {
        let path = crate::shell_env::home_dir().join("Library/Application Support/com.ducknac.ev/tmux.conf");
        if std::fs::read_to_string(&path).ok().as_deref() != Some(CONFIG) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, CONFIG);
        }
        path
    }

    fn run(args: &[&str]) -> Option<String> {
        let bin = binary()?;
        let out = Command::new(bin).arg("-L").arg(server()).arg("-f").arg(config()).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn target(id: &str) -> String {
        format!("={id}")
    }

    /// The session's (only) pane — pane commands need `=session:` rather than `=session`.
    fn pane(id: &str) -> String {
        format!("={id}:")
    }

    pub fn exists(id: &str) -> bool {
        run(&["has-session", "-t", &target(id)]).is_some()
    }

    /// Every session tmux is keeping for E.V.
    pub fn alive() -> Vec<String> {
        run(&["list-sessions", "-F", "#{session_name}"]).map(|out| out.lines().map(str::to_string).collect()).unwrap_or_default()
    }

    pub fn kill_session(id: &str) {
        let _ = run(&["kill-session", "-t", &target(id)]);
    }

    pub fn pane_pid(id: &str) -> Option<i32> {
        run(&["display-message", "-p", "-t", &pane(id), "#{pane_pid}"])?.trim().parse().ok()
    }

    /// What the session printed so far (colours kept), ending with enough blank lines that it
    /// all sits in the scrollback before tmux redraws the screen.
    pub fn history(id: &str) -> String {
        let Some(text) = run(&["capture-pane", "-p", "-e", "-J", "-S", "-2000", "-t", &pane(id)]) else { return String::new() };
        let trimmed = text.trim_end_matches('\n');
        if trimmed.trim().is_empty() {
            return String::new();
        }
        format!("{}\r\n{}", trimmed.replace('\n', "\r\n"), "\r\n".repeat(60))
    }

    /// `tmux new-session -A`: attaches when the session exists (the program inside keeps running
    /// whatever E.V does), otherwise starts `inner` in a new one with this session's variables.
    pub fn command(bin: &Path, request: &SpawnRequest, cwd: &Path, inner: &CommandBuilder) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(bin);
        cmd.args(["-L", &server(), "-f"]);
        cmd.arg(config());
        cmd.args(["new-session", "-A", "-s", &request.id, "-x", &request.cols.max(10).to_string(), "-y", &request.rows.max(3).to_string()]);
        cmd.arg("-c");
        cmd.arg(cwd);
        for (key, value) in [
            ("GIDEON_SESSION_ID", request.id.as_str()),
            ("CLAUDEDESK_SESSION_ID", request.id.as_str()),
            ("TERM_PROGRAM", "E.V"),
            ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION")),
            ("COLORTERM", "truecolor"),
        ] {
            cmd.arg("-e");
            cmd.arg(format!("{key}={value}"));
        }
        for arg in inner.get_argv() {
            cmd.arg(arg);
        }
        cmd
    }
}

/// Sessions tmux is still keeping from before E.V last quit (empty without tmux).
#[tauri::command]
pub fn pty_alive() -> Vec<String> {
    tmux::alive()
}

#[cfg(test)]
mod tmux_tests {
    use super::*;
    use std::time::Duration;

    fn read_until(reader: &mut Box<dyn Read + Send>, needle: &str, timeout: Duration) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut reader = std::mem::replace(reader, Box::new(std::io::empty()));
        std::thread::spawn(move || {
            let mut seen = String::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                if tx.send(seen.clone()).is_err() {
                    break;
                }
            }
        });
        let end = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < end {
            if let Ok(seen) = rx.recv_timeout(Duration::from_millis(100)) {
                if seen.contains(needle) {
                    return true;
                }
            }
        }
        false
    }

    /// A session keeps running when E.V's side closes, comes back with its history, and ✕ ends it.
    /// Needs real tmux sockets: `cargo test --release --lib tmux_tests -- --include-ignored`.
    #[test]
    #[ignore]
    fn sessions_survive_gideon_closing() {
        let Some(bin) = tmux::binary() else { return };
        std::env::set_var("GIDEON_TMUX_SERVER", format!("gideon-test-{}", std::process::id()));
        let id = "term-survive-test";
        let request = SpawnRequest { id: id.into(), kind: PtyKind::Command, cwd: "/tmp".into(), command: None, claude_args: None, cols: 80, rows: 24 };
        let mut inner = CommandBuilder::new("/bin/sh");
        inner.args(["-c", "echo started-$GIDEON_SESSION_ID; while true; do sleep 1; done"]);
        let spawn = || {
            let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut cmd = tmux::command(&bin, &request, std::path::Path::new("/tmp"), &inner);
            cmd.env("TERM", "xterm-256color");
            let child = pair.slave.spawn_command(cmd).unwrap();
            let reader = pair.master.try_clone_reader().unwrap();
            (pair, child, reader)
        };

        let (pair, mut child, mut reader) = spawn();
        assert!(read_until(&mut reader, "started-term-survive-test", Duration::from_secs(8)), "program started with its session id");
        // E.V quits: its side (the tmux client) goes away, as E.V's own quit forces it.
        unsafe { libc::kill(child.process_id().unwrap() as i32, libc::SIGKILL) };
        let _ = child.wait();
        drop(pair);
        std::thread::sleep(Duration::from_millis(400));
        assert!(tmux::exists(id), "the session kept running");
        assert!(tmux::alive().contains(&id.to_string()));
        assert!(tmux::history(id).contains("started-term-survive-test"), "its output is kept");

        // E.V opens again: it reattaches to the same running program.
        let (pair, mut child, mut reader) = spawn();
        assert!(read_until(&mut reader, "started-term-survive-test", Duration::from_secs(8)), "reattached to the same screen");
        let pane = tmux::pane_pid(id).expect("pane pid");
        assert!(pane > 0);

        // ✕ in E.V ends it for real (E.V also closes its viewer, as here).
        tmux::kill_session(id);
        drop(pair);
        unsafe { libc::kill(child.process_id().unwrap() as i32, libc::SIGKILL) };
        let _ = child.wait();
        assert!(!tmux::exists(id));
        let _ = std::process::Command::new(&bin).args(["-L", &format!("gideon-test-{}", std::process::id()), "kill-server"]).output();
    }
}
