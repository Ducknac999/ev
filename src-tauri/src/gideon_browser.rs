//! The E.V Browser: a separate copy of Vivaldi with its own data folder (its own logins, history
//! and cookies — never the user's Vivaldi), started hidden and driven over a private pipe
//! (`--remote-debugging-pipe`: no network port, only E.V can talk to it). Pages are read as text
//! and controlled from inside — real clicks and typing delivered to the page, so the user's mouse,
//! keyboard and screen are never touched.
//!
//! Hard limits that no AI can change: money (payment, banking, checkout pages and buttons) and
//! passwords / security codes / card fields are refused here, file uploads are blocked and
//! downloads are off. Only http(s) pages can be opened.

use crate::mac_control::{has_any, money_blocked, MONEY_WORDS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const VIVALDI_PATHS: &[&str] = &["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"];
const MAX_TEXT: usize = 3500;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn vivaldi() -> Option<PathBuf> {
    let home = crate::shell_env::home_dir().join("Applications/Vivaldi.app/Contents/MacOS/Vivaldi");
    VIVALDI_PATHS.iter().map(PathBuf::from).chain([home]).find(|p| p.exists())
}

/// The E.V Browser's own profile. `GIDEON_BROWSER_PROFILE` points tests at a throwaway one, so
/// they never share (or clean up) the profile the running app is using.
pub fn profile_dir() -> PathBuf {
    match std::env::var("GIDEON_BROWSER_PROFILE") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => crate::shell_env::home_dir().join("Library/Application Support/com.ducknac.ev/gideon-browser"),
    }
}

/// The app the user is using right now (process id), so starting the hidden browser can't take it away.
fn frontmost_pid() -> Option<i32> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let class = AnyClass::get(c"NSWorkspace")?;
    let ws: *mut AnyObject = unsafe { msg_send![class, sharedWorkspace] };
    let app: *mut AnyObject = unsafe { msg_send![ws, frontmostApplication] };
    (!app.is_null()).then(|| unsafe { msg_send![app, processIdentifier] })
}

/// If starting the hidden browser made it the front app, give the front back to `previous`.
fn keep_front(previous: Option<i32>) {
    let Some(previous) = previous else { return };
    let now = frontmost_pid();
    if now.is_some() && now != Some(previous) {
        // Only when the new front app is one of the hidden browser's own processes.
        let ours = now.is_some_and(|pid| {
            Command::new("/bin/ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok().is_some_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("--user-data-dir={}", profile_dir().display())))
        });
        if ours {
            use objc2::msg_send;
            use objc2::runtime::{AnyClass, AnyObject};
            if let Some(class) = AnyClass::get(c"NSRunningApplication") {
                let app: *mut AnyObject = unsafe { msg_send![class, runningApplicationWithProcessIdentifier: previous] };
                if !app.is_null() {
                    let _: bool = unsafe { msg_send![app, activateWithOptions: 0usize] };
                }
            }
        }
    }
}

// ── The pipe ──────────────────────────────────────────────────────────────────

type Reply = Result<Value, String>;

struct Cdp {
    writer: Mutex<File>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    next: AtomicU64,
    alive: AtomicBool,
}

impl Cdp {
    fn post(&self, method: &str, params: Value, session: Option<&str>) -> Result<u64, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("the E.V Browser closed".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        bytes.push(0);
        lock(&self.writer).write_all(&bytes).map_err(|e| format!("the E.V Browser closed ({e})"))?;
        Ok(id)
    }

    fn call_for(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Reply {
        let (tx, rx) = mpsc::channel();
        // Registered before the reply can be read, so a fast reply can't be missed.
        let id = {
            let mut pending = lock(&self.pending);
            let id = self.post(method, params, session)?;
            pending.insert(id, tx);
            id
        };
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(format!("the page didn't answer ({method})"))
            }
        }
    }

    fn call(&self, method: &str, params: Value, session: Option<&str>) -> Reply {
        self.call_for(method, params, session, Duration::from_secs(30))
    }
}

#[derive(Clone)]
struct Tab {
    target: String,
    session: String,
}

struct Browser {
    cdp: Arc<Cdp>,
    child: Mutex<Child>,
    pid: i32,
    /// A normal window the user can watch; otherwise headless (no window, no Dock icon).
    visible: bool,
    /// The browser's own user agent minus "Headless", so sites treat it like normal Vivaldi.
    agent: String,
    tabs: Arc<Mutex<HashMap<String, Tab>>>,
    /// Sessions of tabs that haven't opened a page yet (they can't answer anything until they do).
    blank: Mutex<std::collections::HashSet<String>>,
}

static BROWSER: Mutex<Option<Arc<Browser>>> = Mutex::new(None);
/// The tab shown in E.V's Browser panel right now.
struct View {
    tab: String,
    session: String,
}
static VIEW: Mutex<Option<View>> = Mutex::new(None);
/// The user's own tabs ("user-…") they shared with the AI. All other user tabs are off limits to it.
static SHARED: Mutex<std::collections::BTreeSet<String>> = Mutex::new(std::collections::BTreeSet::new());
/// Address and title of every page, by target id (kept up to date by the browser's own events).
static INFO: std::sync::LazyLock<Mutex<HashMap<String, (String, String)>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static TAB_SEQ: AtomicU64 = AtomicU64::new(1);
static ADOPTED: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> = std::sync::LazyLock::new(|| Mutex::new(Default::default()));
/// Frames sent to the panel so far (for tests).
static FRAMES: AtomicU64 = AtomicU64::new(0);
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn set_app(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn emit(event: &str, payload: Value) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

fn panel_open() -> bool {
    lock(&VIEW).is_some()
}

fn has_user_tabs() -> bool {
    running().is_some_and(|b| lock(&b.tabs).keys().any(|n| n.starts_with("user-")))
}

/// The AI may use its own tabs, and the user's tabs only when the user shared them.
fn ai_may_use(tab: &str) -> Result<(), String> {
    if tab.starts_with("user-") && !lock(&SHARED).contains(tab) {
        return Err("NEVER:private".into());
    }
    Ok(())
}

/// When the E.V Browser was last used (seconds); it closes itself after a few idle minutes.
static LAST_USED: AtomicU64 = AtomicU64::new(0);
const IDLE_CLOSE_SECS: u64 = 180;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Closes the hidden browser once nobody has used it for a while (it starts again in a second).
fn watch_idle() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
        let Some(b) = running() else { return };
        if panel_open() || has_user_tabs() {
            continue;
        }
        if !b.visible && now_secs().saturating_sub(LAST_USED.load(Ordering::SeqCst)) > IDLE_CLOSE_SECS {
            stop();
            return;
        }
    });
}

/// The E.V Browser is also a "Vivaldi" to macOS: while it runs, asking for "Vivaldi" by name is
/// ambiguous. Before E.V touches the user's own Vivaldi, the hidden one gets out of the way.
pub fn step_aside() {
    // While the user is browsing in the panel, lookups skip it by process instead (see mac_control::pid_of).
    if panel_open() || has_user_tabs() {
        return;
    }
    if running().is_some_and(|b| !b.visible) {
        stop();
    }
}

/// The E.V Browser's process, so lookups for the user's Vivaldi can skip it.
pub fn own_pid() -> Option<i32> {
    running().map(|b| b.pid)
}
/// The browser opened normally (no pipe) so the user can sign in by hand.
static SIGNIN: Mutex<Option<Child>> = Mutex::new(None);

fn signin_open() -> bool {
    let mut guard = lock(&SIGNIN);
    match guard.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        _ => {
            *guard = None;
            false
        }
    }
}

/// Closes E.V Browser processes left over from an earlier run (they would hold the profile).
fn kill_strays() {
    let dir = profile_dir();
    let marker = format!("--user-data-dir={}", dir.display());
    let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,command="]).output() else { return };
    let me = std::process::id() as i32;
    let pids: Vec<i32> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(&marker))
        .filter_map(|l| l.trim().split_whitespace().next()?.parse().ok())
        .filter(|p| *p != me)
        .collect();
    for pid in &pids {
        unsafe { libc::kill(*pid, libc::SIGTERM) };
    }
    if !pids.is_empty() {
        std::thread::sleep(Duration::from_millis(800));
        for pid in &pids {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_file(dir.join("SingletonLock"));
    }
}

fn base_args() -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile_dir().display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        // Keep pages running normally while the window is hidden.
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-background-timer-throttling".into(),
        "--window-size=1366,900".into(),
    ]
}

fn launch(visible: bool) -> Result<Arc<Browser>, String> {
    let exe = vivaldi().ok_or("Vivaldi isn't installed (the E.V Browser is a separate copy of Vivaldi)")?;
    if signin_open() {
        return Err("The E.V Browser is open for signing in. Quit it (⌘Q in that Vivaldi window) and try again.".into());
    }
    std::fs::create_dir_all(profile_dir()).map_err(|e| e.to_string())?;
    for attempt in 0..2 {
        if attempt == 1 {
            kill_strays();
        }
        let mut to_browser = [0i32; 2];
        let mut from_browser = [0i32; 2];
        unsafe {
            if libc::pipe(to_browser.as_mut_ptr()) != 0 || libc::pipe(from_browser.as_mut_ptr()) != 0 {
                return Err("couldn't create the browser pipe".into());
            }
            for fd in [to_browser[0], to_browser[1], from_browser[0], from_browser[1]] {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
        }
        let (child_in, child_out) = (to_browser[0], from_browser[1]);
        let mut command = Command::new(&exe);
        command.args(base_args()).args(if visible { vec![] } else { vec!["--headless=new"] }).arg("--remote-debugging-pipe").arg("about:blank").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(move || {
                // Move both ends out of the way first, so dup2 onto 3/4 never collides.
                let a = libc::fcntl(child_in, libc::F_DUPFD, 10);
                let b = libc::fcntl(child_out, libc::F_DUPFD, 10);
                if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(a);
                libc::close(b);
                Ok(())
            });
        }
        let front_before = if visible { None } else { frontmost_pid() };
        let child = command.spawn().map_err(|e| format!("couldn't start the E.V Browser: {e}"))?;
        unsafe {
            libc::close(child_in);
            libc::close(child_out);
        }
        let writer = unsafe { File::from_raw_fd(to_browser[1]) };
        let reader = unsafe { File::from_raw_fd(from_browser[0]) };
        let cdp = Arc::new(Cdp { writer: Mutex::new(writer), pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1), alive: AtomicBool::new(true) });
        let tabs: Arc<Mutex<HashMap<String, Tab>>> = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(reader, cdp.clone(), tabs.clone());
        let pid = child.id() as i32;
        let mut browser = Browser { cdp, child: Mutex::new(child), pid, visible, agent: String::new(), tabs, blank: Mutex::new(Default::default()) };
        let started = Instant::now();
        let mut ready = false;
        while started.elapsed() < Duration::from_secs(25) {
            if let Ok(v) = browser.cdp.call_for("Browser.getVersion", json!({}), None, Duration::from_secs(2)) {
                browser.agent = v.get("userAgent").and_then(Value::as_str).unwrap_or("").replace("HeadlessChrome", "Chrome");
                ready = true;
                keep_front(front_before);
                break;
            }
            if !browser.cdp.alive.load(Ordering::SeqCst) || matches!(lock(&browser.child).try_wait(), Ok(Some(_))) {
                break;
            }
        }
        if !ready {
            let _ = lock(&browser.child).kill();
            continue;
        }
        let _ = browser.cdp.call("Browser.setDownloadBehavior", json!({ "behavior": "deny" }), None);
        // Titles, addresses and pages opened by links, for the panel's tab strip.
        let _ = browser.cdp.call("Target.setDiscoverTargets", json!({ "discover": true }), None);
        return Ok(Arc::new(browser));
    }
    Err("The E.V Browser didn't start. If a Vivaldi window titled with the E.V profile is open, quit it and try again.".into())
}

fn spawn_reader(reader: File, cdp: Arc<Cdp>, tabs: Arc<Mutex<HashMap<String, Tab>>>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(0, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if buf.last() == Some(&0) {
                buf.pop();
            }
            let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
            if std::env::var_os("GIDEON_GB_DEBUG").is_some() {
                eprintln!("{:?} << {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() % 1000000, String::from_utf8_lossy(&buf).chars().take(300).collect::<String>());
            }
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                if let Some(tx) = lock(&cdp.pending).remove(&id) {
                    let reply = match msg.get("error") {
                        Some(err) => Err(err.get("message").and_then(Value::as_str).unwrap_or("browser error").to_string()),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(reply);
                }
                continue;
            }
            let session = msg.get("sessionId").and_then(Value::as_str);
            match msg.get("method").and_then(Value::as_str).unwrap_or("") {
                // Alerts would freeze the page: close them (confirm boxes answer "no").
                "Page.javascriptDialogOpening" => {
                    let kind = msg.pointer("/params/type").and_then(Value::as_str).unwrap_or("");
                    let _ = cdp.post("Page.handleJavaScriptDialog", json!({ "accept": kind == "alert" || kind == "beforeunload" }), session);
                }
                "Page.screencastFrame" => {
                    if let Some(frame) = msg.pointer("/params/sessionId").and_then(Value::as_u64) {
                        let _ = cdp.post("Page.screencastFrameAck", json!({ "sessionId": frame }), session);
                    }
                    let viewing = lock(&VIEW).as_ref().is_some_and(|v| Some(v.session.as_str()) == session);
                    if viewing {
                        FRAMES.fetch_add(1, Ordering::SeqCst);
                        emit("gb-frame", json!({ "data": msg.pointer("/params/data"), "width": msg.pointer("/params/metadata/deviceWidth"), "height": msg.pointer("/params/metadata/deviceHeight") }));
                    }
                }
                "Target.targetCreated" | "Target.targetInfoChanged" => {
                    let info = msg.pointer("/params/targetInfo").cloned().unwrap_or(Value::Null);
                    let id = info.get("targetId").and_then(Value::as_str).unwrap_or("").to_string();
                    if info.get("type").and_then(Value::as_str) == Some("page") && !id.is_empty() {
                        let url = info.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                        let title = info.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                        lock(&INFO).insert(id.clone(), (url, title));
                        emit("gb-tabs", json!({}));
                        // The opener shows up on the first or a later event: adopt each page only once.
                        let first = info.get("openerId").is_some() && ADOPTED.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone());
                        if let Some(opener) = info.get("openerId").and_then(Value::as_str).filter(|_| first).map(String::from) {
                            std::thread::spawn(move || {
                                if let Some(b) = running() {
                                    b.adopt(&id, &opener);
                                }
                            });
                        }
                    }
                }
                "Target.targetDestroyed" => {
                    if let Some(id) = msg.pointer("/params/targetId").and_then(Value::as_str) {
                        lock(&INFO).remove(id);
                        lock(&tabs).retain(|_, t| t.target != id);
                        emit("gb-tabs", json!({}));
                    }
                }
                "Target.detachedFromTarget" => {
                    if let Some(gone) = msg.pointer("/params/sessionId").and_then(Value::as_str) {
                        lock(&tabs).retain(|_, t| t.session != gone);
                    }
                }
                _ => {}
            }
        }
        cdp.alive.store(false, Ordering::SeqCst);
        for (_, tx) in lock(&cdp.pending).drain() {
            let _ = tx.send(Err("the E.V Browser closed".into()));
        }
    });
}

fn debug(what: &str) {
    if std::env::var_os("GIDEON_GB_DEBUG").is_some() {
        eprintln!("[gideon browser] {what}");
    }
}

fn running() -> Option<Arc<Browser>> {
    lock(&BROWSER).clone().filter(|b| b.cdp.alive.load(Ordering::SeqCst) && matches!(lock(&b.child).try_wait(), Ok(None)))
}

/// The running E.V Browser, or a new headless one.
fn browser() -> Result<Arc<Browser>, String> {
    LAST_USED.store(now_secs(), Ordering::SeqCst);
    if let Some(b) = running() {
        return Ok(b);
    }
    let b = launch(false)?;
    *lock(&BROWSER) = Some(b.clone());
    watch_idle();
    Ok(b)
}

/// Switches between headless and a visible window, reopening the same tabs on the same pages.
fn browser_in(visible: bool) -> Result<Arc<Browser>, String> {
    LAST_USED.store(now_secs(), Ordering::SeqCst);
    let Some(current) = running() else {
        let b = launch(visible)?;
        *lock(&BROWSER) = Some(b.clone());
        watch_idle();
        return Ok(b);
    };
    if current.visible == visible {
        return Ok(current);
    }
    let pages: Vec<(String, String)> = lock(&current.tabs).clone().into_iter().map(|(name, tab)| (name, current.url(&tab))).collect();
    stop();
    let next = launch(visible)?;
    *lock(&BROWSER) = Some(next.clone());
    watch_idle();
    for (name, url) in pages {
        if let Ok(tab) = next.tab(&name) {
            if url.starts_with("http") {
                let _ = next.navigate(&tab, &url);
            }
        }
    }
    Ok(next)
}

pub fn stop() {
    if let Some(b) = lock(&BROWSER).take() {
        let _ = b.cdp.call_for("Browser.close", json!({}), None, Duration::from_secs(3));
        let mut child = lock(&b.child);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
    }
}

// ── Showing (AppKit) ──────────────────────────────────────────────────────────

/// Brings the visible E.V Browser to the front, when the user asked to see it.
fn bring_forward(pid: i32) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let Some(class) = AnyClass::get(c"NSRunningApplication") else { return };
    for _ in 0..30 {
        let app: *mut AnyObject = unsafe { msg_send![class, runningApplicationWithProcessIdentifier: pid] };
        if !app.is_null() {
            // NSApplicationActivateAllWindows
            let _: bool = unsafe { msg_send![app, activateWithOptions: 1usize] };
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ── Tabs and pages ────────────────────────────────────────────────────────────

impl Browser {
    fn tab(&self, name: &str) -> Result<Tab, String> {
        if let Some(t) = lock(&self.tabs).get(name) {
            return Ok(t.clone());
        }
        let created = self.cdp.call("Target.createTarget", json!({ "url": "about:blank", "background": true }), None)?;
        let target = created.get("targetId").and_then(Value::as_str).ok_or("couldn't open a tab")?.to_string();
        let tab = self.attach(&target, true)?;
        lock(&self.tabs).insert(name.to_string(), tab.clone());
        Ok(tab)
    }

    /// Attaches to a page and sets it up (uploads blocked, focus kept, normal user agent).
    fn attach(&self, target: &str, blank: bool) -> Result<Tab, String> {
        let target = target.to_string();
        let attached = self.cdp.call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None)?;
        let session = attached.get("sessionId").and_then(Value::as_str).ok_or("couldn't reach the tab")?.to_string();
        let s = Some(session.as_str());
        // A blank background tab has no page process until it opens something, so these are sent
        // without waiting; they're applied in order before the first page loads.
        let _ = self.cdp.post("Runtime.runIfWaitingForDebugger", json!({}), s);
        let _ = self.cdp.post("Page.enable", json!({}), s);
        // File pickers never open: nothing can be uploaded from this Mac.
        let _ = self.cdp.post("Page.setInterceptFileChooserDialog", json!({ "enabled": true }), s);
        let _ = self.cdp.post("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), s);
        if !self.agent.is_empty() {
            let _ = self.cdp.post("Emulation.setUserAgentOverride", json!({ "userAgent": self.agent }), s);
        }
        if blank {
            lock(&self.blank).insert(session.clone());
        }
        Ok(Tab { target, session })
    }

    /// A page a tab opened by itself (a link with target=_blank): it becomes a tab of the same owner.
    fn adopt(&self, target: &str, opener: &str) {
        let owner = lock(&self.tabs).iter().find(|(_, t)| t.target == opener).map(|(n, _)| n.clone());
        let Some(owner) = owner else { return };
        if lock(&self.tabs).values().any(|t| t.target == target) {
            return;
        }
        let user = owner.starts_with("user-");
        let name = format!("{}-{}", if user { "user" } else { "ai" }, TAB_SEQ.fetch_add(1, Ordering::SeqCst));
        if let Ok(tab) = self.attach(target, false) {
            lock(&self.tabs).insert(name.clone(), tab);
            if user && lock(&SHARED).contains(&owner) {
                lock(&SHARED).insert(name.clone());
            }
            emit("gb-tabs", json!({ "focus": if user { Some(name) } else { None } }));
        }
    }

    fn close_tab(&self, name: &str) {
        if let Some(t) = lock(&self.tabs).remove(name) {
            let _ = self.cdp.call_for("Target.closeTarget", json!({ "targetId": t.target }), None, Duration::from_secs(3));
        }
    }

    fn eval(&self, tab: &Tab, expression: &str) -> Reply {
        let out = self.cdp.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }), Some(&tab.session))?;
        if let Some(ex) = out.get("exceptionDetails") {
            let text = ex.pointer("/exception/description").or_else(|| ex.get("text")).and_then(Value::as_str).unwrap_or("script error");
            return Err(text.lines().next().unwrap_or("script error").to_string());
        }
        Ok(out.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }

    fn wait_loaded(&self, tab: &Tab, max: Duration) {
        let started = Instant::now();
        while started.elapsed() < max {
            if self.eval(tab, "document.readyState").ok().and_then(|v| v.as_str().map(String::from)).as_deref() == Some("complete") {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    fn is_blank(&self, tab: &Tab) -> bool {
        lock(&self.blank).contains(&tab.session)
    }

    fn url(&self, tab: &Tab) -> String {
        if self.is_blank(tab) {
            return String::new();
        }
        self.eval(tab, "location.href").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
    }

    fn navigate(&self, tab: &Tab, url: &str) -> Result<(), String> {
        let url = normalize_url(url)?;
        let out = self.cdp.call("Page.navigate", json!({ "url": url }), Some(&tab.session))?;
        lock(&self.blank).remove(&tab.session);
        if let Some(err) = out.get("errorText").and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Err(format!("couldn't open {url}: {err}"));
        }
        self.wait_loaded(tab, Duration::from_secs(15));
        self.guard_money(tab)
    }

    /// A page that turned out to be a payment or checkout page (e.g. after a redirect) is closed.
    fn guard_money(&self, tab: &Tab) -> Result<(), String> {
        let now = self.url(tab);
        if money_blocked(&now) {
            let _ = self.cdp.call("Page.navigate", json!({ "url": "about:blank" }), Some(&tab.session));
            return Err("NEVER:money".into());
        }
        Ok(())
    }

    fn snapshot(&self, tab: &Tab) -> Result<Value, String> {
        let raw = self.eval(tab, SNAPSHOT_JS)?;
        serde_json::from_str(raw.as_str().unwrap_or("{}")).map_err(|e| e.to_string())
    }

    fn screenshot(&self, tab: &Tab) -> String {
        self.cdp
            .call_for("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 60, "optimizeForSpeed": true }), Some(&tab.session), Duration::from_secs(8))
            .ok()
            .and_then(|v| v.get("data").and_then(Value::as_str).map(String::from))
            .unwrap_or_default()
    }

    fn describe(&self, tab: &Tab, id: usize) -> Result<Target, String> {
        let raw = self.eval(tab, &format!("{DESCRIBE_JS}({id})"))?;
        let target: Target = serde_json::from_str(raw.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if target.missing {
            return Err(format!("there's no control #{id} on the page now — look again"));
        }
        Ok(target)
    }

    fn mouse_click(&self, tab: &Tab, t: &Target, id: usize) -> Result<(), String> {
        if !t.clear {
            // Something covers it (a banner or overlay): press it directly instead.
            self.eval(tab, &format!("(() => {{ const el = window.__gideonEls[{id} - 1]; el.focus(); el.click(); }})()"))?;
            return Ok(());
        }
        let s = Some(tab.session.as_str());
        let at = |kind: &str, extra: Value| {
            let mut p = json!({ "type": kind, "x": t.x, "y": t.y, "button": "left", "clickCount": 1 });
            if let (Some(o), Some(e)) = (p.as_object_mut(), extra.as_object()) {
                o.extend(e.clone());
            }
            self.cdp.call("Input.dispatchMouseEvent", p, s)
        };
        at("mouseMoved", json!({ "button": "none", "clickCount": 0 }))?;
        at("mousePressed", json!({ "buttons": 1 }))?;
        at("mouseReleased", json!({}))?;
        Ok(())
    }

    fn key(&self, tab: &Tab, key: &str, modifiers: &[String]) -> Result<(), String> {
        let (name, code, vk, text) = key_info(key).ok_or_else(|| format!("unknown key \"{key}\""))?;
        let mask = modifiers.iter().fold(0, |m, k| {
            m | match k.to_lowercase().as_str() {
                "option" | "alt" => 1,
                "control" | "ctrl" => 2,
                "command" | "cmd" | "meta" => 4,
                "shift" => 8,
                _ => 0,
            }
        });
        let text = if mask & (1 | 2 | 4) != 0 { String::new() } else { text };
        let s = Some(tab.session.as_str());
        let mut down = json!({ "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" }, "key": name, "code": code, "windowsVirtualKeyCode": vk, "modifiers": mask });
        if !text.is_empty() {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        self.cdp.call("Input.dispatchKeyEvent", down, s)?;
        self.cdp.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": name, "code": code, "windowsVirtualKeyCode": vk, "modifiers": mask }), s)?;
        Ok(())
    }
}

fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let full = if url.starts_with("http://") || url.starts_with("https://") || url == "about:blank" {
        url.to_string()
    } else if url.contains("://") || url.starts_with("file:") || url.starts_with("javascript:") || url.starts_with("data:") {
        return Err("The E.V Browser only opens web pages (http/https).".into());
    } else {
        format!("https://{url}")
    };
    if money_blocked(&full) {
        return Err("NEVER:money".into());
    }
    Ok(full)
}

fn key_info(key: &str) -> Option<(String, String, i64, String)> {
    let k = key.trim().to_lowercase();
    let named = |n: &str, code: &str, vk: i64, text: &str| Some((n.to_string(), code.to_string(), vk, text.to_string()));
    match k.as_str() {
        "enter" | "return" => named("Enter", "Enter", 13, "\r"),
        "tab" => named("Tab", "Tab", 9, ""),
        "escape" | "esc" => named("Escape", "Escape", 27, ""),
        "backspace" => named("Backspace", "Backspace", 8, ""),
        "delete" => named("Delete", "Delete", 46, ""),
        "space" => named(" ", "Space", 32, " "),
        "up" | "arrowup" => named("ArrowUp", "ArrowUp", 38, ""),
        "down" | "arrowdown" => named("ArrowDown", "ArrowDown", 40, ""),
        "left" | "arrowleft" => named("ArrowLeft", "ArrowLeft", 37, ""),
        "right" | "arrowright" => named("ArrowRight", "ArrowRight", 39, ""),
        "home" => named("Home", "Home", 36, ""),
        "end" => named("End", "End", 35, ""),
        "pageup" => named("PageUp", "PageUp", 33, ""),
        "pagedown" => named("PageDown", "PageDown", 34, ""),
        _ => {
            let mut chars = k.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            if c.is_ascii_lowercase() {
                Some((c.to_string(), format!("Key{}", c.to_ascii_uppercase()), c.to_ascii_uppercase() as i64, c.to_string()))
            } else if c.is_ascii_digit() {
                Some((c.to_string(), format!("Digit{c}"), c as i64, c.to_string()))
            } else {
                None
            }
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Target {
    missing: bool,
    x: f64,
    y: f64,
    clear: bool,
    role: String,
    label: String,
    kind: String,
    auto: String,
    name: String,
    href: String,
}

impl Target {
    fn money(&self) -> bool {
        has_any(&self.label, MONEY_WORDS) || (!self.href.is_empty() && money_blocked(&self.href))
    }

    fn secret(&self) -> bool {
        let field = format!("{} {} {}", self.label, self.name, self.auto).to_lowercase();
        self.kind == "password"
            || self.auto.contains("one-time-code")
            || self.auto.contains("current-password")
            || self.auto.contains("new-password")
            || self.auto.starts_with("cc-")
            || ["password", "passcode", "verification code", "security code", "one time code", "2fa", "otp", "card number", "cvv", "cvc"].iter().any(|w| field.contains(w))
    }
}

fn card_like(text: &str) -> bool {
    let digits = text.chars().filter(char::is_ascii_digit).count();
    text.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') && (13..=19).contains(&digits)
}

// ── What the AI sees ──────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    pub url: String,
    pub title: String,
    /// Controls (numbered) and the page's text, ready for the model.
    pub text: String,
    pub controls: usize,
    /// JPEG (base64), only when asked for.
    pub image: String,
}

fn page_view(snapshot: &Value, image: String) -> PageView {
    let s = |k: &str| snapshot.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let items = snapshot.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = format!("Page: {}\nURL: {}\n", s("title"), s("url"));
    out.push_str(&format!("Controls ({}{}):\n", items.len(), if snapshot.get("more").and_then(Value::as_bool) == Some(true) { "+, first ones shown" } else { "" }));
    for it in &items {
        let g = |k: &str| it.get(k).and_then(Value::as_str).unwrap_or("");
        let mut line = format!("#{} {}", it.get("id").and_then(Value::as_u64).unwrap_or(0), g("role"));
        if !g("label").is_empty() {
            line.push_str(&format!(" \"{}\"", g("label")));
        }
        if !g("value").is_empty() {
            line.push_str(&format!(" = \"{}\"", g("value")));
        }
        for (flag, word) in [("checked", "checked"), ("disabled", "disabled"), ("focused", "focused"), ("offscreen", "off-screen")] {
            if it.get(flag).and_then(Value::as_bool) == Some(true) {
                line.push_str(&format!(" ({word})"));
            }
        }
        if it.get("checked").and_then(Value::as_bool) == Some(false) {
            line.push_str(" (not checked)");
        }
        out.push_str(&line);
        out.push('\n');
    }
    let text = s("text");
    let clipped: String = text.chars().take(MAX_TEXT).collect();
    out.push_str("Page text:\n");
    out.push_str(&clipped);
    if text.chars().count() > MAX_TEXT {
        out.push_str("\n…(more below — scroll, or use web_fetch for the full text)");
    }
    PageView { url: s("url"), title: s("title"), text: out, controls: items.len(), image }
}

fn look(b: &Browser, tab: &Tab, picture: bool) -> Result<PageView, String> {
    if b.is_blank(tab) {
        return Ok(PageView { text: "This tab is empty — open a page first (browser_go).".into(), ..Default::default() });
    }
    let snapshot = b.snapshot(tab)?;
    let image = if picture { b.screenshot(tab) } else { String::new() };
    Ok(page_view(&snapshot, image))
}

// ── One action ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Step {
    #[serde(rename = "do")]
    pub action: String,
    pub id: Option<usize>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub modifiers: Option<Vec<String>>,
    pub value: Option<String>,
    pub url: Option<String>,
    pub clear: Option<bool>,
    pub submit: Option<bool>,
    pub ms: Option<u64>,
    pub dy: Option<i64>,
}

fn need_id(step: &Step) -> Result<usize, String> {
    step.id.ok_or_else(|| format!("\"{}\" needs the control's id", step.action))
}

fn run_step(b: &Browser, tab: &Tab, step: &Step) -> Result<String, String> {
    match step.action.as_str() {
        "go" | "open" => {
            let url = step.url.clone().unwrap_or_default();
            b.navigate(tab, &url)?;
            Ok(format!("opened {}", b.url(tab)))
        }
        "click" => {
            let id = need_id(step)?;
            let t = b.describe(tab, id)?;
            if t.money() {
                return Err("NEVER:money".into());
            }
            b.mouse_click(tab, &t, id)?;
            Ok(format!("clicked #{id} {} \"{}\"", t.role, t.label))
        }
        "type" => {
            let id = need_id(step)?;
            let text = step.text.clone().unwrap_or_default();
            let t = b.describe(tab, id)?;
            if t.secret() || card_like(&text) {
                return Err("NEVER:password".into());
            }
            if t.money() {
                return Err("NEVER:money".into());
            }
            b.mouse_click(tab, &t, id)?;
            let clear = step.clear.unwrap_or(true);
            b.eval(tab, &format!("{CARET_JS}({id}, {clear})"))?;
            b.cdp.call("Input.insertText", json!({ "text": text }), Some(&tab.session))?;
            if step.submit == Some(true) {
                b.key(tab, "enter", &[])?;
            }
            Ok(format!("typed into #{id} \"{}\"{}", t.label, if step.submit == Some(true) { " and pressed Enter" } else { "" }))
        }
        "key" => {
            let key = step.key.clone().unwrap_or_default();
            let mods = step.modifiers.clone().unwrap_or_default();
            b.key(tab, &key, &mods)?;
            Ok(format!("pressed {}", mods.iter().cloned().chain([key]).collect::<Vec<_>>().join("+")))
        }
        "select" => {
            let id = need_id(step)?;
            let value = step.value.clone().unwrap_or_default();
            let t = b.describe(tab, id)?;
            if t.money() || has_any(&value, MONEY_WORDS) {
                return Err("NEVER:money".into());
            }
            let ok = b.eval(tab, &format!("{SELECT_JS}({id}, {})", json!(value)))?;
            if ok.as_bool() == Some(true) {
                Ok(format!("chose \"{value}\" in #{id}"))
            } else {
                Err(format!("#{id} has no option \"{value}\""))
            }
        }
        "scroll" => {
            let dy = step.dy.unwrap_or(5);
            b.eval(tab, &format!("window.scrollBy(0, {} * 120)", dy))?;
            std::thread::sleep(Duration::from_millis(250));
            Ok(format!("scrolled {}", if dy >= 0 { "down" } else { "up" }))
        }
        "wait" => {
            std::thread::sleep(Duration::from_millis(step.ms.unwrap_or(1000).min(8000)));
            Ok("waited".into())
        }
        "back" => {
            b.eval(tab, "history.back()")?;
            b.wait_loaded(tab, Duration::from_secs(10));
            Ok("went back".into())
        }
        other => Err(format!("unknown step \"{other}\" (use go, click, type, key, select, scroll, wait, back)")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoResult {
    pub done: Vec<String>,
    /// Why it stopped early, if it did ("NEVER:money", "NEVER:password" or an error).
    pub stopped: Option<String>,
    pub page: PageView,
}

pub fn run_steps(tab_name: &str, steps: &[Step], picture: bool) -> Result<DoResult, String> {
    ai_may_use(tab_name)?;
    let b = browser()?;
    let tab = b.tab(tab_name)?;
    let mut done = Vec::new();
    let mut stopped = None;
    for (i, step) in steps.iter().enumerate() {
        match run_step(&b, &tab, step) {
            Ok(msg) => done.push(msg),
            Err(e) => {
                stopped = Some(if e.starts_with("NEVER:") { e } else { format!("step {}: {e}", i + 1) });
                break;
            }
        }
        // Clicks, keys and submitting may start loading a new page.
        if matches!(step.action.as_str(), "click" | "key") || step.submit == Some(true) {
            std::thread::sleep(Duration::from_millis(150));
            b.wait_loaded(&tab, Duration::from_secs(8));
            if let Err(e) = b.guard_money(&tab) {
                stopped = Some(e);
                break;
            }
        }
    }
    let page = look(&b, &tab, picture)?;
    Ok(DoResult { done, stopped, page })
}

/// Prints a local HTML file to a PDF (for documents the AI makes) in a tab of its own. The HTML
/// must already carry `doc::OFFLINE_POLICY`, which keeps it from reaching the network.
pub fn print_pdf(html_path: &std::path::Path, out: &std::path::Path, landscape: bool, paper: &str) -> Result<PrintedPdf, String> {
    let b = browser()?;
    let tab = b.tab("doc-render")?;
    let s = Some(tab.session.as_str());
    let result = (|| {
        let url = format!("file://{}", html_path.display().to_string().split('/').map(percent_encode_segment).collect::<Vec<_>>().join("/"));
        let nav = b.cdp.call("Page.navigate", json!({ "url": url }), s)?;
        lock(&b.blank).remove(&tab.session);
        if let Some(err) = nav.get("errorText").and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Err(format!("couldn't open the document: {err}"));
        }
        b.wait_loaded(&tab, Duration::from_secs(15));
        // Web fonts and images settle after "complete" on some pages.
        let _ = b.eval(&tab, "document.fonts ? document.fonts.ready.then(() => true) : true");
        // How much of the text is too small to read on paper (under 7pt), measured as printed.
        let _ = b.cdp.call("Emulation.setEmulatedMedia", json!({ "media": "print" }), s);
        let small_text = b.eval(&tab, SMALL_TEXT_JS).ok().and_then(|v| v.as_f64()).unwrap_or(0.0);
        let overflow = b.eval(&tab, OVERFLOW_JS).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>();
        let (w, h) = match paper.to_ascii_lowercase().as_str() {
            "a4" => (8.27, 11.69),
            "legal" => (8.5, 14.0),
            "tabloid" => (11.0, 17.0),
            _ => (8.5, 11.0),
        };
        let printed = b.cdp.call_for(
            "Page.printToPDF",
            json!({
                "landscape": landscape,
                "printBackground": true,
                "preferCSSPageSize": true,
                "paperWidth": w,
                "paperHeight": h,
                "marginTop": 0.4, "marginBottom": 0.4, "marginLeft": 0.4, "marginRight": 0.4,
            }),
            s,
            Duration::from_secs(60),
        )?;
        let data = printed.get("data").and_then(Value::as_str).ok_or("the browser returned no PDF")?;
        let bytes = crate::agent_tools::base64_decode(data).ok_or("the browser returned a damaged PDF")?;
        std::fs::write(out, &bytes).map_err(|e| format!("couldn't save {}: {e}", out.display()))?;
        Ok(PrintedPdf { small_text, overflow })
    })();
    b.close_tab("doc-render");
    result
}

pub struct PrintedPdf {
    /// Text that spills out of its table cell or box (start of each), as printed.
    pub overflow: Vec<String>,
    /// Share of the document's characters set below 7pt (0–1).
    pub small_text: f64,
}

/// Share of visible text characters whose printed size is under 7pt, counting the page's CSS zoom.
const SMALL_TEXT_JS: &str = r#"(() => {
  let total = 0, small = 0;
  // CSS zoom on the page (used to fit a page count) shrinks the printed type too.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent.replace(/\s+/g, '');
    if (!text) continue;
    const el = n.parentElement;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const pt = (parseFloat(st.fontSize) || 16) * 0.75 * zoom;
    total += text.length;
    if (pt < 7) small += text.length;
  }
  return total ? small / total : 0;
})()"#;

/// Table cells, list items and paragraphs whose content is wider than the box (it prints over the
/// next column) — up to 8, each as the start of its text. Formulas and other inline pieces can
/// spill out without widening the box itself, so where each piece inside actually ends counts too.
const OVERFLOW_JS: &str = r#"(() => {
  const out = [];
  for (const el of document.querySelectorAll("td, th, li, p, h1, h2, h3, pre, code")) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.overflowX === "hidden" || st.overflowX === "scroll" || st.overflowX === "auto") continue;
    if (el.clientWidth <= 0) continue;
    let spills = el.scrollWidth > el.clientWidth + 2;
    if (!spills) {
      const box = el.getBoundingClientRect();
      const inner = el.querySelectorAll("math, img, svg, span, code, b, i, strong, em, sub, sup");
      for (let i = 0; i < inner.length && i < 400 && !spills; i++) {
        const r = inner[i].getBoundingClientRect();
        if (r.width > 0 && (r.right > box.right + 2 || r.left < box.left - 2)) spills = true;
      }
    }
    if (spills) {
      out.push(el.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
      if (out.length >= 8) break;
    }
  }
  return out;
})()"#;

fn percent_encode_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

pub fn open(tab_name: &str, url: &str, picture: bool) -> Result<PageView, String> {
    ai_may_use(tab_name)?;
    let b = browser()?;
    let tab = b.tab(tab_name)?;
    b.navigate(&tab, url)?;
    look(&b, &tab, picture)
}

pub fn read(tab_name: &str, picture: bool) -> Result<PageView, String> {
    ai_may_use(tab_name)?;
    let b = browser()?;
    let tab = b.tab(tab_name)?;
    look(&b, &tab, picture)
}

pub fn show(visible: bool, tab_name: Option<&str>) -> Result<(), String> {
    let b = browser_in(visible)?;
    if let Some(name) = tab_name {
        if let Some(t) = lock(&b.tabs).get(name).cloned() {
            let _ = b.cdp.call("Target.activateTarget", json!({ "targetId": t.target }), None);
        }
    }
    if visible {
        bring_forward(b.pid);
    }
    Ok(())
}

/// Opens Desmos in its own tab, puts the expressions in (LaTeX) and shows it.
pub fn desmos(expressions: &[String], bounds: Option<[f64; 4]>) -> Result<(), String> {
    let t0 = Instant::now();
    let b = browser()?;
    debug(&format!("visible browser in {:?}", t0.elapsed()));
    let tab = b.tab("desmos")?;
    if !b.url(&tab).starts_with("https://www.desmos.com/calculator") {
        b.navigate(&tab, "https://www.desmos.com/calculator")?;
    }
    debug(&format!("desmos page loaded at {:?}", t0.elapsed()));
    let started = Instant::now();
    while b.eval(&tab, "typeof Calc !== 'undefined' && typeof Calc.setExpression === 'function'").ok().and_then(|v| v.as_bool()) != Some(true) {
        if started.elapsed() > Duration::from_secs(20) {
            return Err("Desmos didn't finish loading".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let bounds_js = bounds.map(|[l, r, bo, t]| format!("Calc.setMathBounds({{left:{l},right:{r},bottom:{bo},top:{t}}});")).unwrap_or_default();
    b.eval(
        &tab,
        &format!("(() => {{ Calc.setBlank(); {}.forEach((latex, i) => Calc.setExpression({{ id: 'g' + i, latex }})); {bounds_js} return true; }})()", json!(expressions)),
    )?;
    Ok(())
}

// ── Page scripts ──────────────────────────────────────────────────────────────

/// Numbers every visible control (through shadow DOM) and returns them with the page's text.
const SNAPSHOT_JS: &str = r##"(() => {
  const MAX = 220;
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable="true"],[onclick]';
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const roleOf = (el) => {
    const given = el.getAttribute('role');
    if (given) return given;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'menu';
    if (t === 'textarea') return 'text box';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'password') return 'password field';
      if (ty === 'file') return 'file upload (blocked)';
      return ty === 'text' ? 'text field' : ty + ' field';
    }
    if (el.isContentEditable) return 'text box';
    return 'clickable';
  };
  const labelOf = (el) => {
    let l = el.getAttribute('aria-label') || '';
    if (!l && el.getAttribute('aria-labelledby')) l = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
    if (!l && el.labels && el.labels.length) l = el.labels[0].innerText;
    if (!l && el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) l = el.value;
    if (!l && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) l = el.innerText;
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || ((el.querySelector && el.querySelector('img[alt]')) || {}).alt || el.getAttribute('name') || '';
    return clean(l).slice(0, 90);
  };
  window.__gideonRole = roleOf;
  window.__gideonLabel = labelOf;
  const els = [];
  const items = [];
  let more = false;
  const consider = (el) => {
    if (!el.matches || !el.matches(SEL) || !visible(el)) return;
    if (items.length >= MAX) { more = true; return; }
    // A link or button inside one already listed adds nothing.
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && els.slice(-6).some((p) => p.contains(el))) return;
    const role = roleOf(el);
    const item = { id: els.length + 1, role, label: labelOf(el) };
    if (/field|text box|menu|textbox|combobox|searchbox/.test(role) && role !== 'password field') {
      const v = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).text : el.isContentEditable && !('value' in el) ? el.innerText : el.value;
      if (v) item.value = clean(v).slice(0, 120);
    }
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && el.checked !== undefined) item.checked = !!el.checked;
    else if (el.getAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (document.activeElement === el) item.focused = true;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) item.offscreen = true;
    if (role === 'link' && !item.label && el.href) item.label = el.href.slice(0, 90);
    els.push(el);
    items.push(item);
  };
  const walk = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = tw.currentNode.nodeType === 1 ? tw.currentNode : tw.nextNode();
    while (n) {
      consider(n);
      if (n.shadowRoot) walk(n.shadowRoot);
      n = tw.nextNode();
    }
  };
  if (document.body) walk(document.body);
  window.__gideonEls = els;
  const lines = [];
  for (const line of String((document.body && document.body.innerText) || '').split('\n')) {
    const t = clean(line);
    if (t && t !== lines[lines.length - 1]) lines.push(t);
  }
  return JSON.stringify({ url: location.href, title: document.title, items, more, text: lines.join('\n').slice(0, 8000) });
})()"##;

/// Scrolls a numbered control into view and says where it is and what it is.
const DESCRIBE_JS: &str = r##"((id) => {
  const el = (window.__gideonEls || [])[id - 1];
  if (!el || !el.isConnected) return JSON.stringify({ missing: true });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const root = el.getRootNode();
  const host = root !== document && root.host;
  const clear = !!hit && (hit === el || el.contains(hit) || hit.contains(el) || (host && (hit === host || hit.contains(host))));
  return JSON.stringify({
    x, y, clear,
    role: window.__gideonRole(el), label: window.__gideonLabel(el),
    kind: String(el.type || '').toLowerCase(),
    auto: String(el.getAttribute('autocomplete') || '').toLowerCase(),
    name: String(el.getAttribute('name') || '') + ' ' + String(el.id || ''),
    href: el.href ? String(el.href) : '',
  });
})"##;

/// Puts the caret in a field: everything selected (to replace it) or at the end.
const CARET_JS: &str = r##"((id, clear) => {
  const el = window.__gideonEls[id - 1];
  if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
  if ('value' in el && el.tagName !== 'SELECT') {
    try { const n = String(el.value || '').length; el.setSelectionRange(clear ? 0 : n, n); } catch (e) { if (clear && el.select) el.select(); }
  } else {
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
})"##;

const SELECT_JS: &str = r##"((id, value) => {
  const el = window.__gideonEls[id - 1];
  if (!el || el.tagName !== 'SELECT') return false;
  const want = String(value).toLowerCase();
  const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want));
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})"##;

// ── E.V's Browser panel ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub name: String,
    pub url: String,
    pub title: String,
    /// Opened by the user in the panel (private unless shared).
    pub mine: bool,
    pub shared: bool,
}

fn tab_infos(b: &Browser) -> Vec<TabInfo> {
    let info = lock(&INFO);
    let shared = lock(&SHARED);
    let mut tabs: Vec<TabInfo> = lock(&b.tabs)
        .iter()
        .map(|(name, t)| {
            let (url, title) = info.get(&t.target).cloned().unwrap_or_default();
            TabInfo { name: name.clone(), url, title, mine: name.starts_with("user-"), shared: shared.contains(name) }
        })
        .collect();
    tabs.sort_by(|a, b| (!a.mine, &a.name).cmp(&(!b.mine, &b.name)));
    tabs
}

/// The tab the panel shows, as (browser, tab).
fn viewed() -> Result<(Arc<Browser>, Tab), String> {
    let b = running().ok_or("the E.V Browser isn't running")?;
    let name = lock(&VIEW).as_ref().map(|v| v.tab.clone()).ok_or("no tab is shown")?;
    let tab = lock(&b.tabs).get(&name).cloned().ok_or("that tab closed")?;
    Ok((b, tab))
}

/// Starts streaming a tab into the panel at the panel's size (CSS pixels × scale).
pub fn view(tab_name: &str, width: u32, height: u32, scale: f64) -> Result<(), String> {
    let b = browser()?;
    let tab = b.tab(tab_name)?;
    let previous = lock(&VIEW).take();
    if let Some(prev) = previous.filter(|p| p.session != tab.session) {
        let _ = b.cdp.post("Page.stopScreencast", json!({}), Some(&prev.session));
    }
    if b.is_blank(&tab) {
        // A page process is needed before anything can be drawn.
        let _ = b.cdp.call("Page.navigate", json!({ "url": "about:blank" }), Some(&tab.session));
        lock(&b.blank).remove(&tab.session);
    }
    let (w, h) = (width.clamp(200, 4000), height.clamp(150, 3000));
    let scale = scale.clamp(1.0, 2.0);
    let s = Some(tab.session.as_str());
    b.cdp.call("Emulation.setDeviceMetricsOverride", json!({ "width": w, "height": h, "deviceScaleFactor": scale, "mobile": false }), s)?;
    *lock(&VIEW) = Some(View { tab: tab_name.to_string(), session: tab.session.clone() });
    b.cdp.call(
        "Page.startScreencast",
        json!({ "format": "jpeg", "quality": 70, "maxWidth": (w as f64 * scale) as u32, "maxHeight": (h as f64 * scale) as u32, "everyNthFrame": 1 }),
        s,
    )?;
    LAST_USED.store(now_secs(), Ordering::SeqCst);
    Ok(())
}

pub fn view_stop() {
    if let Some(v) = lock(&VIEW).take() {
        if let Some(b) = running() {
            let _ = b.cdp.post("Page.stopScreencast", json!({}), Some(&v.session));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseInput {
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub button: Option<String>,
    pub clicks: Option<u32>,
    pub modifiers: Option<u32>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    pub kind: String,
    pub key: String,
    pub code: String,
    pub key_code: i64,
    pub text: Option<String>,
    pub modifiers: Option<u32>,
    /// Editing commands for ⌘-shortcuts (selectAll, copy, cut, paste, undo, redo).
    pub commands: Option<Vec<String>>,
}

/// The user's own mouse and keys in the panel: passed straight to the page (no AI involved).
fn mouse(input: MouseInput) -> Result<(), String> {
    let (b, tab) = viewed()?;
    let mut p = json!({ "type": input.kind, "x": input.x, "y": input.y, "modifiers": input.modifiers.unwrap_or(0) });
    if input.kind == "mouseWheel" {
        p["deltaX"] = json!(input.dx.unwrap_or(0.0));
        p["deltaY"] = json!(input.dy.unwrap_or(0.0));
    } else {
        p["button"] = json!(input.button.unwrap_or_else(|| "none".into()));
        p["clickCount"] = json!(input.clicks.unwrap_or(0));
    }
    b.cdp.post("Input.dispatchMouseEvent", p, Some(&tab.session)).map(|_| ())
}

fn key(input: KeyInput) -> Result<(), String> {
    let (b, tab) = viewed()?;
    let mut p = json!({ "type": input.kind, "key": input.key, "code": input.code, "windowsVirtualKeyCode": input.key_code, "modifiers": input.modifiers.unwrap_or(0) });
    if let Some(text) = input.text.filter(|t| !t.is_empty()) {
        p["text"] = json!(text);
        p["unmodifiedText"] = json!(text);
    }
    if let Some(commands) = input.commands.filter(|c| !c.is_empty()) {
        p["commands"] = json!(commands);
    }
    b.cdp.post("Input.dispatchKeyEvent", p, Some(&tab.session)).map(|_| ())
}

/// What the address bar typed means: an address, or a Google search.
fn address(input: &str) -> String {
    let t = input.trim();
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else if !t.contains(' ') && t.contains('.') && !t.ends_with('.') {
        format!("https://{t}")
    } else {
        format!("https://www.google.com/search?q={}", t.split_whitespace().map(|w| w.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect::<String>()).collect::<Vec<_>>().join("+"))
    }
}

fn navigate_view(action: &str, input: Option<&str>) -> Result<(), String> {
    let (b, tab) = viewed()?;
    let s = Some(tab.session.as_str());
    match action {
        "go" => {
            let url = address(input.unwrap_or(""));
            b.cdp.post("Page.navigate", json!({ "url": url }), s)?;
        }
        "back" => {
            b.cdp.post("Runtime.evaluate", json!({ "expression": "history.back()" }), s)?;
        }
        "forward" => {
            b.cdp.post("Runtime.evaluate", json!({ "expression": "history.forward()" }), s)?;
        }
        "reload" => {
            b.cdp.post("Page.reload", json!({}), s)?;
        }
        other => return Err(format!("unknown action {other}")),
    }
    lock(&b.blank).remove(&tab.session);
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub installed: bool,
    pub running: bool,
    pub visible: bool,
    pub signing_in: bool,
    pub profile: String,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gb_tabs() -> Result<Vec<TabInfo>, String> {
    blocking(|| Ok(running().map(|b| tab_infos(&b)).unwrap_or_default())).await
}

/// A new tab of the user's own (private until shared), shown in the panel.
#[tauri::command]
pub async fn gb_new_tab(url: Option<String>) -> Result<String, String> {
    blocking(move || {
        let b = browser()?;
        let name = format!("user-{}", TAB_SEQ.fetch_add(1, Ordering::SeqCst));
        let tab = b.tab(&name)?;
        let url = address(url.as_deref().filter(|u| !u.trim().is_empty()).unwrap_or("https://www.google.com"));
        b.cdp.call("Page.navigate", json!({ "url": url }), Some(&tab.session))?;
        lock(&b.blank).remove(&tab.session);
        emit("gb-tabs", json!({}));
        Ok(name)
    })
    .await
}

#[tauri::command]
pub async fn gb_view(tab: String, width: u32, height: u32, scale: f64) -> Result<(), String> {
    blocking(move || view(&tab, width, height, scale)).await
}

#[tauri::command]
pub async fn gb_view_stop() -> Result<(), String> {
    blocking(|| {
        view_stop();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn gb_mouse(input: MouseInput) -> Result<(), String> {
    blocking(move || mouse(input)).await
}

#[tauri::command]
pub async fn gb_key(input: KeyInput) -> Result<(), String> {
    blocking(move || key(input)).await
}

#[tauri::command]
pub async fn gb_insert_text(text: String) -> Result<(), String> {
    blocking(move || {
        let (b, tab) = viewed()?;
        b.cdp.post("Input.insertText", json!({ "text": text }), Some(&tab.session)).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn gb_navigate(action: String, input: Option<String>) -> Result<(), String> {
    blocking(move || navigate_view(&action, input.as_deref())).await
}

/// The text selected in the shown tab (for ⌘C: the hidden browser has no clipboard of its own).
#[tauri::command]
pub async fn gb_selection() -> Result<String, String> {
    blocking(|| {
        let (b, tab) = viewed()?;
        Ok(b.eval(&tab, "String(getSelection())")?.as_str().unwrap_or("").to_string())
    })
    .await
}

/// The user lets the AI see one of their tabs (or takes it back).
#[tauri::command]
pub fn gb_share(tab: String, shared: bool) -> Result<(), String> {
    if !tab.starts_with("user-") {
        return Err("only your own tabs can be shared".into());
    }
    if shared {
        lock(&SHARED).insert(tab);
    } else {
        lock(&SHARED).remove(&tab);
    }
    emit("gb-tabs", json!({}));
    Ok(())
}

#[tauri::command]
pub fn gb_status() -> BrowserStatus {
    let running = lock(&BROWSER).as_ref().filter(|b| b.cdp.alive.load(Ordering::SeqCst)).map(|b| b.visible);
    BrowserStatus {
        installed: vivaldi().is_some(),
        running: running.is_some(),
        visible: running == Some(true),
        signing_in: signin_open(),
        profile: profile_dir().display().to_string(),
    }
}

#[tauri::command]
pub async fn gb_open(tab: Option<String>, url: String, picture: Option<bool>) -> Result<PageView, String> {
    blocking(move || open(tab.as_deref().unwrap_or("main"), &url, picture.unwrap_or(false))).await
}

#[tauri::command]
pub async fn gb_look(tab: Option<String>, picture: Option<bool>) -> Result<PageView, String> {
    blocking(move || read(tab.as_deref().unwrap_or("main"), picture.unwrap_or(false))).await
}

#[tauri::command]
pub async fn gb_do(tab: Option<String>, steps: Vec<Step>, picture: Option<bool>) -> Result<DoResult, String> {
    blocking(move || run_steps(tab.as_deref().unwrap_or("main"), &steps, picture.unwrap_or(false))).await
}

#[tauri::command]
pub async fn gb_show(visible: bool, tab: Option<String>) -> Result<(), String> {
    blocking(move || show(visible, tab.as_deref())).await
}

#[tauri::command]
pub async fn gb_close_tab(tab: String) -> Result<(), String> {
    blocking(move || {
        if let Some(b) = lock(&BROWSER).clone() {
            b.close_tab(&tab);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn gb_desmos(expressions: Vec<String>, bounds: Option<[f64; 4]>) -> Result<(), String> {
    blocking(move || desmos(&expressions, bounds)).await
}

/// Opens the E.V Browser normally (visible, not controlled) so the user can sign in by hand.
#[tauri::command]
pub async fn gb_signin() -> Result<(), String> {
    blocking(|| {
        stop();
        if signin_open() {
            return Ok(());
        }
        kill_strays();
        let exe = vivaldi().ok_or("Vivaldi isn't installed")?;
        std::fs::create_dir_all(profile_dir()).map_err(|e| e.to_string())?;
        let child = Command::new(exe)
            .args(base_args())
            .arg("https://accounts.google.com/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn't open the E.V Browser: {e}"))?;
        *lock(&SIGNIN) = Some(child);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn gb_quit() -> Result<(), String> {
    blocking(|| {
        stop();
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_open() {
        assert_eq!(normalize_url("desmos.com/calculator").unwrap(), "https://desmos.com/calculator");
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("vivaldi://settings").is_err());
        assert_eq!(normalize_url("https://www.paypal.com/myaccount").unwrap_err(), "NEVER:money");
        assert_eq!(normalize_url("https://www.amazon.com/checkout/place").unwrap_err(), "NEVER:money");
    }

    #[test]
    fn money_and_secret_controls_are_refused() {
        let t = |label: &str, kind: &str, auto: &str| Target { label: label.into(), kind: kind.into(), auto: auto.into(), ..Default::default() };
        assert!(t("Place your order", "", "").money());
        assert!(t("Buy now", "", "").money());
        assert!(!t("Search", "", "").money());
        assert!(t("", "password", "").secret());
        assert!(t("Enter code", "text", "one-time-code").secret());
        assert!(t("Card number", "text", "").secret());
        assert!(t("Name on card", "text", "cc-name").secret());
        assert!(!t("Search", "text", "").secret());
        assert!(card_like("4111 1111 1111 1111"));
        assert!(!card_like("call mom at 5"));
    }

    #[test]
    fn address_bar_reads_addresses_and_searches() {
        assert_eq!(address("github.com/ollama"), "https://github.com/ollama");
        assert_eq!(address("https://x.com"), "https://x.com");
        assert_eq!(address("best pizza near me"), "https://www.google.com/search?q=best+pizza+near+me");
        assert_eq!(address("c++ & rust"), "https://www.google.com/search?q=c%2B%2B+%26+rust");
    }

    #[test]
    fn the_ai_cant_use_private_tabs() {
        assert_eq!(ai_may_use("user-7").unwrap_err(), "NEVER:private");
        assert!(ai_may_use("main").is_ok());
        lock(&SHARED).insert("user-7".into());
        assert!(ai_may_use("user-7").is_ok());
        lock(&SHARED).remove("user-7");
    }

    #[test]
    fn keys_map() {
        assert_eq!(key_info("Enter").unwrap().2, 13);
        assert_eq!(key_info("a").unwrap().1, "KeyA");
        assert!(key_info("f13").is_none());
    }

    /// A tiny local web page for the real test.
    fn serve(html: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
            }
        });
        format!("http://127.0.0.1:{port}/")
    }

    fn front_app_pid() -> i32 {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        unsafe {
            let ws: *mut AnyObject = msg_send![AnyClass::get(c"NSWorkspace").unwrap(), sharedWorkspace];
            let app: *mut AnyObject = msg_send![ws, frontmostApplication];
            if app.is_null() {
                return 0;
            }
            msg_send![app, processIdentifier]
        }
    }

    /// Real Vivaldi: run with `cargo test gideon_browser -- --ignored --nocapture` outside the sandbox.
    /// Closes the test browser even when an assert fails.
    struct Closes;
    impl Drop for Closes {
        fn drop(&mut self) {
            stop();
        }
    }

    #[test]
    #[ignore]
    fn drives_a_hidden_vivaldi() {
        let _closes = Closes;
        let front = front_app_pid();
        let url = serve(
            r#"<html><head><title>Bench form</title></head><body>
            <h1>Hello bench</h1>
            <input id="q" placeholder="Search here">
            <input type="password" placeholder="Password">
            <button onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('q').value">Go</button>
            <button>Place order</button>
            <p id="out">waiting</p>
            </body></html>"#,
        );
        let started = Instant::now();
        let page = open("bench", &url, false).expect("open");
        println!("opened in {:?}\n{}", started.elapsed(), page.text);
        assert!(page.text.contains("Hello bench"));
        let id_of = |label: &str| {
            page.text.lines().find(|l| l.contains(label)).and_then(|l| l.trim_start_matches('#').split_whitespace().next()?.parse::<usize>().ok()).unwrap()
        };
        let (search, password, go, order) = (id_of("Search here"), id_of("password field"), id_of("\"Go\""), id_of("Place order"));
        let steps = vec![
            Step { action: "type".into(), id: Some(search), text: Some("gideon rocks".into()), ..Default::default() },
            Step { action: "click".into(), id: Some(go), ..Default::default() },
        ];
        let started = Instant::now();
        let out = run_steps("bench", &steps, false).expect("steps");
        println!("steps in {:?}: {:?} / {:?}", started.elapsed(), out.done, out.stopped);
        assert!(out.stopped.is_none());
        assert!(out.page.text.contains("clicked:gideon rocks"), "{}", out.page.text);

        let out = run_steps("bench", &[Step { action: "type".into(), id: Some(password), text: Some("hunter2".into()), ..Default::default() }], false).unwrap();
        assert_eq!(out.stopped.as_deref(), Some("NEVER:password"));
        let out = run_steps("bench", &[Step { action: "click".into(), id: Some(order), ..Default::default() }], false).unwrap();
        assert_eq!(out.stopped.as_deref(), Some("NEVER:money"));

        // Several tabs at the same time (helpers).
        let handles: Vec<_> = ["h-a", "h-b", "h-c"].iter().map(|t| {
            let url = url.clone();
            std::thread::spawn(move || open(t, &url, false).map(|p| p.title))
        }).collect();
        for h in handles {
            assert_eq!(h.join().unwrap().unwrap(), "Bench form");
        }
        let shot = read("bench", true).unwrap();
        println!("picture: {} bytes", shot.image.len());

        assert_eq!(front_app_pid(), front, "the E.V Browser must not take the front");
        let status = gb_status();
        assert!(status.running && !status.visible, "should be running hidden");
        stop();
    }

    /// Prints what the AI would see for a page: `GB_URL=… cargo test --lib print_page -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_page() {
        let _closes = Closes;
        let url = std::env::var("GB_URL").unwrap_or_else(|_| "https://example.com".into());
        let started = Instant::now();
        let page = open("print", &url, false).expect("open");
        println!("{:?}\n{}", started.elapsed(), page.text);
    }

    /// With the user's Vivaldi open: the hidden E.V Browser must never be mistaken for it.
    #[test]
    #[ignore]
    fn users_vivaldi_is_found_beside_it() {
        let _closes = Closes;
        open("t", "https://example.com", false).expect("open");
        let theirs = crate::mac_control::pid_of("Vivaldi").expect("the user's Vivaldi should be found");
        assert_ne!(Some(theirs), own_pid());
        assert!(running().is_none(), "the hidden browser steps aside for the user's Vivaldi");
        println!("user's Vivaldi pid {theirs}");
    }

    /// The panel: frames stream, the user's clicks and typing reach the page, links opening new tabs are adopted.
    #[test]
    #[ignore]
    fn panel_streams_and_takes_input() {
        let _closes = Closes;
        let url = serve(
            r#"<html><head><title>Panel</title></head><body style="margin:0">
            <input id="q" style="position:absolute;left:20px;top:20px;width:300px;height:30px">
            <a id="pop" href="/" target="_blank" style="position:absolute;left:20px;top:80px">open</a>
            </body></html>"#,
        );
        let b = browser().unwrap();
        let name = "user-900";
        let tab = b.tab(name).unwrap();
        b.navigate(&tab, &url).unwrap();
        let before = FRAMES.load(Ordering::SeqCst);
        view(name, 800, 600, 1.0).expect("view");
        std::thread::sleep(Duration::from_millis(1500));
        let frames = FRAMES.load(Ordering::SeqCst) - before;
        println!("frames in 1.5 s: {frames}");
        assert!(frames > 0, "no frames streamed");
        for kind in ["mousePressed", "mouseReleased"] {
            mouse(MouseInput { kind: kind.into(), x: 100.0, y: 35.0, button: Some("left".into()), clicks: Some(1), modifiers: None, dx: None, dy: None }).unwrap();
        }
        for c in ['h', 'i'] {
            key(KeyInput { kind: "keyDown".into(), key: c.to_string(), code: format!("Key{}", c.to_ascii_uppercase()), key_code: c.to_ascii_uppercase() as i64, text: Some(c.to_string()), modifiers: None, commands: None }).unwrap();
            key(KeyInput { kind: "keyUp".into(), key: c.to_string(), code: format!("Key{}", c.to_ascii_uppercase()), key_code: c.to_ascii_uppercase() as i64, text: None, modifiers: None, commands: None }).unwrap();
        }
        std::thread::sleep(Duration::from_millis(300));
        let value = b.eval(&tab, "document.getElementById('q').value").unwrap();
        assert_eq!(value.as_str(), Some("hi"));
        // A target=_blank link becomes another tab of the user's.
        for kind in ["mousePressed", "mouseReleased"] {
            mouse(MouseInput { kind: kind.into(), x: 30.0, y: 88.0, button: Some("left".into()), clicks: Some(1), modifiers: None, dx: None, dy: None }).unwrap();
        }
        std::thread::sleep(Duration::from_millis(1500));
        let tabs = tab_infos(&b);
        println!("{:?}", tabs.iter().map(|t| (&t.name, &t.title, t.mine)).collect::<Vec<_>>());
        assert!(tabs.iter().filter(|t| t.mine).count() >= 2, "the new tab wasn't adopted");
        assert_eq!(open(name, &url, false).err().as_deref(), Some("NEVER:private"));
        view_stop();
    }

    #[test]
    #[ignore]
    fn desmos_graph() {
        let _closes = Closes;
        let started = Instant::now();
        desmos(&["y=x^{3}-2x-5".into()], None).expect("desmos");
        println!("desmos ready in {:?}", started.elapsed());
        let b = browser().unwrap();
        let tab = b.tab("desmos").unwrap();
        let latex = b.eval(&tab, "Calc.getExpressions().map(e => e.latex).join('|')").unwrap();
        assert_eq!(latex.as_str(), Some("y=x^{3}-2x-5"));
    }
}
