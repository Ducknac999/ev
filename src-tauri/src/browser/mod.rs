//! Any browser, from the inside. E.V finds out what a browser is built on (Blink/Chromium, WebKit,
//! Gecko, Goanna, Ladybird, Servo…) by looking inside its app bundle, so a browser made yesterday
//! is understood the same way as Chrome. Then it reads and changes web pages through the fastest
//! route that browser allows:
//!
//! - **script**: the browser runs E.V's page agent (page_agent.js) itself — Chromium browsers'
//!   `execute … javascript` and Safari's `do JavaScript`. Needs the browser's one switch, "Allow
//!   JavaScript from Apple Events", which E.V asks before turning on.
//! - **extension**: the E.V extension (see bridge.rs) runs the same agent — Firefox and its
//!   relatives, and Chromium browsers without scripting.
//! - **accessibility**: anything else — reading and clicking the window like a person, as before.
//!
//! Only the page agent ever runs in a page, never code an AI wrote. Before a batch runs, E.V asks
//! the page what every action would touch: sends and deletes wait for the user's approval, money
//! and password fields are refused — the same rules as clicking in any app.

pub mod bridge;
pub mod video;

use crate::mac_control::{click_verdict_in, has_any, money_blocked, Verdict, MONEY_WORDS};
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

pub const PAGE_AGENT: &str = include_str!("page_agent.js");
/// Matches VERSION in page_agent.js.
pub const PAGE_AGENT_VERSION: u32 = 3;

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyAllHandlersForURLScheme(scheme: core_foundation::string::CFStringRef) -> core_foundation::array::CFArrayRef;
    fn LSCopyApplicationURLsForBundleIdentifier(bundle: core_foundation::string::CFStringRef, error: *mut *const std::ffi::c_void) -> core_foundation::array::CFArrayRef;
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub name: String,
    pub path: String,
    pub bundle_id: String,
    /// blink · webkit · gecko · goanna · libweb · servo · unknown
    pub engine: String,
    pub engine_label: String,
    /// The browser itself can run E.V's page agent (Chromium `execute`, Safari `do JavaScript`).
    pub scriptable: bool,
    /// Takes Chrome or Firefox extensions (so the E.V extension works in it).
    pub extensions: bool,
    /// script · extension · accessibility — the fastest route this browser has.
    pub route: String,
    pub running: bool,
    pub is_default: bool,
    /// The E.V extension is connected from this browser right now.
    pub connected: bool,
}

fn engine_label(engine: &str) -> &'static str {
    match engine {
        "blink" => "Chromium (Blink)",
        "webkit" => "WebKit",
        "gecko" => "Firefox (Gecko)",
        "goanna" => "Goanna",
        "libweb" => "Ladybird (LibWeb)",
        "servo" => "Servo",
        _ => "Unknown engine",
    }
}

fn plist_value(app: &Path, key: &str) -> String {
    let info = app.join("Contents/Info.plist");
    std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(&info)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Looks for a file or folder whose name satisfies `hit`, at most `depth` levels down.
fn find_inside(dir: &Path, depth: usize, hit: &dyn Fn(&str) -> bool) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if hit(&name) {
            return true;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false);
        if depth > 0 && is_dir && find_inside(&entry.path(), depth - 1, hit) {
            return true;
        }
    }
    false
}

/// The start of the program file holds the list of system libraries it loads.
fn links_webkit(exe: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(exe) else { return false };
    let mut head = vec![0u8; 512 * 1024];
    let n = file.read(&mut head).unwrap_or(0);
    let needle = b"/System/Library/Frameworks/WebKit.framework";
    head[..n].windows(needle.len()).any(|w| w == needle)
}

/// What the browser is built on, judged from what's inside its bundle (not its name).
pub fn detect_engine(app: &Path, bundle_id: &str, exe_name: &str) -> &'static str {
    let id = bundle_id.to_lowercase();
    if id.contains("palemoon") || id.contains("basilisk") || id.contains("moonchild") {
        return "goanna";
    }
    if id.contains("ladybird") {
        return "libweb";
    }
    if id.contains("servo") || id.contains("verso") {
        return "servo";
    }
    if id == "com.apple.safari" || id.starts_with("com.apple.safaritechnologypreview") {
        return "webkit";
    }
    let contents = app.join("Contents");
    if contents.join("MacOS/XUL").exists() || contents.join("Frameworks/XUL").exists() || contents.join("Resources/omni.ja").exists() {
        return "gecko";
    }
    let frameworks = contents.join("Frameworks");
    let blink = |name: &str| name.ends_with("Helper (Renderer).app") || name == "Electron Framework.framework" || name == "chrome_crashpad_handler" || name == "Chromium Embedded Framework.framework";
    if find_inside(&frameworks, 5, &blink) {
        return "blink";
    }
    if !exe_name.is_empty() && links_webkit(&contents.join("MacOS").join(exe_name)) {
        return "webkit";
    }
    "unknown"
}

/// What the browser's scripting dictionary offers: (runs JavaScript, has tabs).
fn scripting(app: &Path) -> (bool, bool) {
    let out = std::process::Command::new("/usr/bin/sdef").arg(app).output().ok().filter(|o| o.status.success());
    let Some(out) = out else { return (false, false) };
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    let js = (text.contains("name=\"execute\"") && text.contains("javascript")) || text.contains("name=\"do javascript\"");
    (js, text.contains("<class name=\"tab\""))
}

struct Cached {
    modified: Option<SystemTime>,
    base: BrowserInfo,
}

static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Everything about the browser at `path` that only changes when it's updated (cached until then).
fn inspect(path: &Path) -> BrowserInfo {
    let key = path.display().to_string();
    let modified = std::fs::metadata(path.join("Contents/Info.plist")).and_then(|m| m.modified()).ok();
    if let Some(hit) = lock(&CACHE).as_ref().and_then(|c| c.get(&key)).filter(|c| c.modified == modified) {
        return hit.base.clone();
    }
    let bundle_id = plist_value(path, "CFBundleIdentifier");
    let exe = plist_value(path, "CFBundleExecutable");
    let display = plist_value(path, "CFBundleDisplayName");
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(display);
    let engine = detect_engine(path, &bundle_id, &exe);
    let (js, _tabs) = scripting(path);
    let extensions = matches!(engine, "blink" | "gecko" | "goanna");
    let route = if js && matches!(engine, "blink" | "webkit") {
        "script"
    } else if extensions {
        "extension"
    } else {
        "accessibility"
    };
    let base = BrowserInfo {
        name,
        path: key.clone(),
        bundle_id,
        engine: engine.into(),
        engine_label: engine_label(engine).into(),
        scriptable: js,
        extensions,
        route: route.into(),
        running: false,
        is_default: false,
        connected: false,
    };
    lock(&CACHE).get_or_insert_with(HashMap::new).insert(key, Cached { modified, base: base.clone() });
    base
}

/// Every app that can open web pages, as macOS knows them.
fn web_apps() -> Vec<PathBuf> {
    let mut out = Vec::new();
    unsafe {
        let scheme = CFString::new("https");
        let raw = LSCopyAllHandlersForURLScheme(scheme.as_concrete_TypeRef());
        if raw.is_null() {
            return out;
        }
        let ids = CFArray::<CFString>::wrap_under_create_rule(raw);
        for id in ids.iter() {
            let urls = LSCopyApplicationURLsForBundleIdentifier(id.as_concrete_TypeRef(), std::ptr::null_mut());
            if urls.is_null() {
                continue;
            }
            let urls = CFArray::<CFURL>::wrap_under_create_rule(urls);
            // Several copies (a build folder, an old download): the one in an Applications folder.
            let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_path()).collect();
            let best = paths.iter().find(|p| p.starts_with("/Applications")).or_else(|| paths.iter().find(|p| p.to_string_lossy().contains("/Applications/"))).or(paths.first());
            if let Some(p) = best {
                if !out.contains(p) {
                    out.push(p.clone());
                }
            }
        }
    }
    out
}

/// Apps that answer web links but aren't browsers (mail, chat and helper apps register too).
fn is_browser_like(info: &BrowserInfo) -> bool {
    if info.engine == "unknown" {
        return info.scriptable;
    }
    // Electron apps (Slack, Discord, VS Code) are Blink inside but not browsers.
    let id = info.bundle_id.to_lowercase();
    !["com.tinyspeck", "com.hnc.discord", "com.microsoft.vscode", "com.spotify", "notion", "com.figma", "com.github", "com.apple.mail", "com.apple.iwork"].iter().any(|x| id.contains(x))
}

fn with_live(mut info: BrowserInfo, default_name: &str) -> BrowserInfo {
    info.running = crate::mac_control::pid_of_quiet(&info.name).is_some();
    info.is_default = info.name.eq_ignore_ascii_case(default_name);
    info.connected = bridge::connected_to(&info);
    info
}

/// The browsers on this Mac, the default one first.
#[tauri::command]
pub async fn browsers_list() -> Vec<BrowserInfo> {
    tokio::task::spawn_blocking(|| {
        let default_name = crate::mac_control::mac_default_browser();
        let mut list: Vec<BrowserInfo> = web_apps().iter().map(|p| inspect(p)).filter(is_browser_like).map(|b| with_live(b, &default_name)).collect();
        list.sort_by_key(|b| (!b.is_default, !b.running, b.name.to_lowercase()));
        list.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
        list
    })
    .await
    .unwrap_or_default()
}

/// Where an app named `app` lives: the running copy, a web app macOS knows, or Applications.
fn app_path(app: &str) -> Option<PathBuf> {
    let want = app.trim().trim_end_matches(".app");
    if let Some(pid) = crate::mac_control::pid_of_quiet(want) {
        if let Some(p) = crate::mac_control::bundle_path(pid) {
            return Some(PathBuf::from(p));
        }
    }
    let lower = want.to_lowercase();
    let known = web_apps();
    if let Some(p) = known.iter().find(|p| p.file_stem().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(want))) {
        return Some(p.clone());
    }
    // "Chrome" for "Google Chrome", "Brave" for "Brave Browser".
    if let Some(p) = known.iter().find(|p| p.file_stem().is_some_and(|s| s.to_string_lossy().to_lowercase().contains(&lower))) {
        return Some(p.clone());
    }
    let home = crate::shell_env::home_dir();
    [PathBuf::from(format!("/Applications/{want}.app")), home.join(format!("Applications/{want}.app"))].into_iter().find(|p| p.exists())
}

pub fn info_for(app: &str) -> Result<BrowserInfo, String> {
    let path = app_path(app).ok_or_else(|| format!("couldn't find an app called {app}"))?;
    Ok(with_live(inspect(&path), &crate::mac_control::mac_default_browser()))
}

#[tauri::command]
pub async fn browser_info(app: String) -> Result<BrowserInfo, String> {
    tokio::task::spawn_blocking(move || info_for(&app)).await.map_err(|e| e.to_string())?
}

// ── Running the page agent ────────────────────────────────────────────────────

/// Error codes the frontend turns into plain instructions (see pageTools.ts).
pub const SWITCH_OFF: &str = "SWITCH_OFF";
pub const NEEDS_EXTENSION: &str = "NEEDS_EXTENSION";
pub const NO_PAGE_ROUTE: &str = "NO_PAGE_ROUTE";
pub const NO_TAB: &str = "NO_TAB";

fn apple_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_safari_dialect(info: &BrowserInfo) -> bool {
    info.engine == "webkit"
}

/// "window 2's tab 3" for the tab whose title or address has `matching`, else the front tab.
fn tab_ref(info: &BrowserInfo, matching: Option<&str>) -> Result<(String, Option<crate::mac_control::BrowserTab>), String> {
    let front = if is_safari_dialect(info) { "current tab of front window" } else { "active tab of front window" };
    let Some(want) = matching.map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty()) else {
        return Ok((front.into(), None));
    };
    let tabs = crate::mac_control::browser_tabs(&info.name)?;
    let hit = |t: &&crate::mac_control::BrowserTab| t.url.to_lowercase().contains(&want) || t.title.to_lowercase().contains(&want);
    let found = tabs.iter().filter(hit).find(|t| t.active).or_else(|| tabs.iter().find(hit));
    match found {
        Some(t) => Ok((format!("tab {} of window {}", t.tab, t.window), Some(t.clone()))),
        None => {
            let open: Vec<String> = tabs.iter().take(30).map(|t| format!("{} — {}", t.title, t.url)).collect();
            Err(format!("{NO_TAB}: no open {} tab has \"{want}\" in its title or address. Open tabs:\n{}", info.name, open.join("\n")))
        }
    }
}

fn script_js(info: &BrowserInfo, tab: &str, js: &str) -> Result<String, String> {
    let script = if is_safari_dialect(info) {
        format!("tell application {} to do JavaScript {} in {tab}", apple_string(&info.name), apple_string(js))
    } else {
        format!("tell application {} to execute {tab} javascript {}", apple_string(&info.name), apple_string(js))
    };
    match crate::mac_control::run_timed("/usr/bin/osascript", &["-e", &script], 20) {
        Ok(out) => Ok(out),
        Err(e) if e.contains("Allow JavaScript from Apple Events") || e.contains("JavaScript through AppleScript is turned off") => Err(format!("{SWITCH_OFF}: {}", info.name)),
        Err(e) => Err(e),
    }
}

/// Runs one request through the page agent in `app`'s tab and returns its JSON answer.
fn agent(info: &BrowserInfo, matching: Option<&str>, request: &Value) -> Result<(Value, &'static str), String> {
    agent_with(info, matching, request, 3)
}

/// `agent` with a set number of tries: actions get one (a repeat could do them twice).
fn agent_with(info: &BrowserInfo, matching: Option<&str>, request: &Value, attempts: u32) -> Result<(Value, &'static str), String> {
    let call = format!("{PAGE_AGENT}\n;window.__evAgent.run({request});");
    let mut switch_off = false;
    if info.route == "script" {
        let (tab, _) = tab_ref(info, matching)?;
        // A page that's loading can't answer yet: try again a moment later.
        let mut last = String::new();
        for attempt in 0..attempts.max(1) {
            match script_js(info, &tab, &call) {
                Ok(out) => {
                    let text = out.trim();
                    if let Ok(v) = serde_json::from_str::<Value>(text) {
                        return Ok((v, "script"));
                    }
                    last = format!("the page didn't answer ({})", if text.is_empty() || text == "missing value" { "it may still be loading" } else { text });
                }
                Err(e) if e.starts_with(SWITCH_OFF) => {
                    switch_off = true;
                    break;
                }
                Err(e) => last = e,
            }
            if attempt + 1 < attempts.max(1) {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        if !switch_off {
            return Err(last);
        }
    }
    if info.extensions || info.connected {
        if bridge::connected_to(info) {
            let v = bridge::request(info, matching, request)?;
            return Ok((v, "extension"));
        }
        if switch_off {
            return Err(format!("{SWITCH_OFF}: {}", info.name));
        }
        return Err(format!("{NEEDS_EXTENSION}: {}", info.name));
    }
    if switch_off {
        return Err(format!("{SWITCH_OFF}: {}", info.name));
    }
    Err(format!("{NO_PAGE_ROUTE}: {} ({})", info.name, info.engine_label))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLook {
    pub app: String,
    pub engine: String,
    pub engine_label: String,
    pub via: String,
    pub title: String,
    pub url: String,
    pub total: u64,
    pub shown: u64,
    pub matching: Option<u64>,
    pub controls: Vec<String>,
    pub text: Option<String>,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn agent_error(v: &Value) -> Result<(), String> {
    match v.get("error").and_then(|e| e.as_str()) {
        Some(e) => Err(format!("the page agent failed: {e}")),
        None => Ok(()),
    }
}

/// Reads a tab of the user's browser as numbered controls (and its words, with `text`).
#[tauri::command]
pub async fn page_look(app: String, tab: Option<String>, find: Option<String>, text: Option<bool>) -> Result<PageLook, String> {
    tokio::task::spawn_blocking(move || {
        let info = info_for(&app)?;
        let req = json!({ "op": "look", "find": find, "text": text.unwrap_or(false) });
        let (v, via) = agent(&info, tab.as_deref(), &req)?;
        agent_error(&v)?;
        let url = s(&v, "url");
        if money_blocked(&url) {
            return Err(crate::mac_control::MONEY_REFUSAL.into());
        }
        Ok(PageLook {
            app: info.name.clone(),
            engine: info.engine.clone(),
            engine_label: info.engine_label.clone(),
            via: via.into(),
            title: s(&v, "title"),
            url,
            total: v.get("total").and_then(|x| x.as_u64()).unwrap_or(0),
            shown: v.get("shown").and_then(|x| x.as_u64()).unwrap_or(0),
            matching: v.get("matching").and_then(|x| x.as_u64()),
            controls: strings(&v, "controls"),
            text: v.get("text").and_then(|x| x.as_str()).map(String::from),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageDo {
    /// ok · final (waiting on the user's approval) · never (money or a password)
    pub verdict: String,
    /// What the approval card says, or what was refused.
    pub target: String,
    pub done: Vec<String>,
    pub failed: Option<String>,
    pub failed_index: Option<u64>,
    pub url: String,
    pub title: String,
    pub navigated: bool,
    pub changed: Vec<String>,
    pub added: Vec<String>,
    pub more_added: u64,
    pub removed: u64,
    pub via: String,
    /// What each action touched (role, own label, words beside it), so the route can be saved by words.
    pub targets: Vec<Value>,
    /// Popups the page raised while E.V acted, and how they were answered.
    pub dialogs: Vec<String>,
}

/// How a web role reads to the click rules (which were written for app windows).
fn ax_role(role: &str) -> &str {
    match role {
        "Button" | "Link" | "MenuItem" => role,
        "Clickable" | "Tab" | "Option" | "Cell" | "TreeItem" => "",
        _ => "Other",
    }
}

/// The rule for each action, from what the page says it would touch.
fn judge(about: &Value) -> (Verdict, String) {
    let mut worst = (Verdict::Ok, String::new());
    for a in about.get("actions").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        if a.get("missing").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let kind = s(&a, "do");
        let role = s(&a, "role");
        let label = s(&a, "label");
        let dialog = a.get("dialog").and_then(|x| x.as_bool()).unwrap_or(false);
        let verdict = match kind.as_str() {
            "click" | "check" => click_verdict_in(ax_role(&role), &label, dialog),
            "set" | "select" => {
                if a.get("password").and_then(|x| x.as_bool()) == Some(true) || has_any(&label, MONEY_WORDS) {
                    Verdict::Never
                } else {
                    Verdict::Ok
                }
            }
            "press" => {
                let key = s(&a, "key").to_lowercase();
                let search = a.get("search").and_then(|x| x.as_bool()).unwrap_or(false);
                if (key == "enter" || key == "return") && !search {
                    Verdict::Final
                } else {
                    Verdict::Ok
                }
            }
            _ => Verdict::Ok,
        };
        let what = match kind.as_str() {
            "press" => format!("press {} in “{}”", s(&a, "key"), label),
            _ => format!("“{label}”"),
        };
        match (verdict, &worst.0) {
            (Verdict::Never, _) => return (Verdict::Never, what),
            (Verdict::Final, Verdict::Ok) => worst = (Verdict::Final, what),
            _ => {}
        }
    }
    worst
}

/// Runs a batch of actions in a tab: click, set (type or pick), check, select, press, scroll, wait.
/// Sends and deletes come back as `final` until `approved`; money and passwords are refused.
#[tauri::command]
pub async fn page_do(app: String, tab: Option<String>, actions: Vec<Value>, approved: Option<bool>) -> Result<PageDo, String> {
    tokio::task::spawn_blocking(move || {
        let info = info_for(&app)?;
        if actions.is_empty() {
            return Err("no actions given".into());
        }
        if actions.len() > 60 {
            return Err("at most 60 actions in one batch — split it".into());
        }
        let actions: Vec<Value> = actions.into_iter().map(normalize_action).collect();
        let (about, via) = agent(&info, tab.as_deref(), &json!({ "op": "about", "actions": actions }))?;
        agent_error(&about)?;
        let url = s(&about, "url");
        if money_blocked(&url) {
            return Err(crate::mac_control::MONEY_REFUSAL.into());
        }
        if let Some((i, _)) = about.get("actions").and_then(|x| x.as_array()).and_then(|a| a.iter().enumerate().find(|(_, x)| x.get("missing").and_then(|m| m.as_bool()) == Some(true))) {
            let action = actions.get(i).cloned().unwrap_or(Value::Null);
            let what = match action.get("ref") {
                Some(r) if !r.is_null() => format!("#{r} isn't on the page now"),
                _ => format!("nothing called “{}” is on the page now", s(&action, "label")),
            };
            return Ok(PageDo { verdict: "ok".into(), failed: Some(format!("{what} — look again for current numbers")), failed_index: Some(i as u64), url, via: via.into(), ..Default::default() });
        }
        let (mut verdict, mut target) = judge(&about);
        // Answering OK to the page's own "are you sure?" is the user's call.
        if verdict == Verdict::Ok && actions.iter().any(|a| a.get("confirm").and_then(|c| c.as_bool()) == Some(true)) {
            verdict = Verdict::Final;
            target = "OK on the page's “are you sure?” question".into();
        }
        match verdict {
            Verdict::Never => return Ok(PageDo { verdict: "never".into(), target, url, via: via.into(), ..Default::default() }),
            Verdict::Final if !approved.unwrap_or(false) => return Ok(PageDo { verdict: "final".into(), target, url, via: via.into(), ..Default::default() }),
            _ => {}
        }
        // One action per call: each gets its own result, and one that hangs (a popup, a page that
        // stopped answering) can't take the ones before it down with it.
        let mut done: Vec<String> = Vec::new();
        let mut failed: Option<(u64, String)> = None;
        for (i, action) in actions.iter().enumerate() {
            match agent_with(&info, tab.as_deref(), &json!({ "op": "do", "actions": [action] }), 1) {
                Ok((v, _)) => {
                    if let Err(e) = agent_error(&v) {
                        failed = Some((i as u64, e));
                        break;
                    }
                    done.extend(strings(&v, "done"));
                    if let Some(f) = v.get("failed") {
                        failed = Some((i as u64, s(f, "error")));
                        break;
                    }
                }
                Err(e) if e.contains("timed out") => {
                    failed = Some((i as u64, "timed out — the page stopped answering (often a popup or dialog is open in the browser)".into()));
                    break;
                }
                Err(e) if i == 0 => return Err(e),
                Err(e) => {
                    failed = Some((i as u64, e));
                    break;
                }
            }
        }
        // Let the page react (menus open, panels redraw, a new page loads) before reading what changed.
        let waited: u64 = actions.iter().filter(|a| s(a, "do") == "wait").filter_map(|a| a.get("ms").and_then(|m| m.as_u64())).sum();
        std::thread::sleep(Duration::from_millis(450 + waited.min(5000)));
        let stuck = failed.as_ref().is_some_and(|(_, e)| e.starts_with("timed out"));
        let diff = if stuck { Value::Null } else { agent_with(&info, tab.as_deref(), &json!({ "op": "diff" }), 1).map(|(v, _)| v).unwrap_or(Value::Null) };
        Ok(PageDo {
            verdict: if verdict == Verdict::Final { "approved".into() } else { "ok".into() },
            target,
            done,
            failed: failed.as_ref().map(|(_, e)| e.clone()),
            failed_index: failed.as_ref().map(|(i, _)| *i),
            url: if diff.is_null() { url } else { s(&diff, "url") },
            title: s(&diff, "title"),
            navigated: diff.get("navigated").and_then(|x| x.as_bool()).unwrap_or(false),
            changed: strings(&diff, "changed"),
            added: strings(&diff, "added"),
            more_added: diff.get("moreAdded").and_then(|x| x.as_u64()).unwrap_or(0),
            removed: diff.get("removed").and_then(|x| x.as_u64()).unwrap_or(0),
            via: via.into(),
            targets: about.get("actions").and_then(|x| x.as_array()).cloned().unwrap_or_default(),
            dialogs: strings(&diff, "dialogs"),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Models write the number as "id", "#12" or "12"; the agent wants `ref`.
fn normalize_action(mut a: Value) -> Value {
    if let Some(obj) = a.as_object_mut() {
        if !obj.contains_key("ref") {
            if let Some(id) = obj.remove("id") {
                obj.insert("ref".into(), id);
            }
        }
        if let Some(r) = obj.get("ref").and_then(|r| r.as_str()).map(|r| r.trim_start_matches('#').to_string()) {
            if let Ok(n) = r.parse::<u64>() {
                obj.insert("ref".into(), json!(n));
            }
        }
    }
    a
}

/// Turns on "Allow JavaScript from Apple Events" in the browser's own menu (only called after the
/// browser said it's off, and after the user agreed).
#[tauri::command]
pub async fn browser_switch_on(app: String) -> Result<String, String> {
    let info = tokio::task::spawn_blocking({
        let app = app.clone();
        move || info_for(&app)
    })
    .await
    .map_err(|e| e.to_string())??;
    // The menu item is a toggle: only press it when the browser says it's off right now.
    let now = {
        let info = info.clone();
        tokio::task::spawn_blocking(move || agent(&info, None, &json!({ "op": "diff" })).map(|_| ())).await.map_err(|e| e.to_string())?
    };
    match now {
        Ok(()) => return Ok(format!("Already on in {}.", info.name)),
        Err(e) if e.starts_with(SWITCH_OFF) => {}
        Err(e) if e.starts_with(NEEDS_EXTENSION) || e.starts_with(NO_PAGE_ROUTE) => return Err(format!("{} doesn't have this setting — it uses the E.V extension instead.", info.name)),
        Err(_) => return Err(format!("Open a web page in {} first (E.V checks the setting on an open page), then try again.", info.name)),
    }
    let paths: &[&str] = if info.engine == "webkit" {
        &["Develop > Allow JavaScript from Apple Events", "Developer > Allow JavaScript from Apple Events"]
    } else {
        &["View > Developer > Allow JavaScript from Apple Events", "View > Developer > Allow JavaScript From Apple Events", "Developer > Allow JavaScript from Apple Events", "Tools > Developer > Allow JavaScript from Apple Events"]
    };
    let mut last = String::new();
    for path in paths {
        match crate::mac_control::mac_menu(info.name.clone(), (*path).into(), Some(true)).await {
            Ok(r) if r.action.as_ref().is_none_or(|a| !a.done) => last = r.listing,
            Ok(_) => {
                // Safari asks to confirm; Chromium browsers turn it on at once. Check by asking the page.
                tokio::time::sleep(Duration::from_millis(600)).await;
                let check = {
                    let info = info.clone();
                    tokio::task::spawn_blocking(move || agent(&info, None, &json!({ "op": "diff" })).map(|_| ())).await.map_err(|e| e.to_string())?
                };
                return match check {
                    Ok(()) => Ok(format!("Turned on in {}.", info.name)),
                    Err(e) if e.starts_with(SWITCH_OFF) => Err(format!(
                        "{} still has it off — it may be asking you to confirm. Look for a window from {} and allow it, or turn it on yourself: {}.",
                        info.name, info.name, path
                    )),
                    // No page open is fine: the switch itself is on.
                    Err(_) => Ok(format!("Turned on in {}.", info.name)),
                };
            }
            Err(e) => last = e,
        }
    }
    Err(format!("couldn't find the setting in {}'s menus ({last}). In {}, open the menu bar's View (or Develop) → Developer → Allow JavaScript from Apple Events.", info.name, info.name))
}

/// The browser the user named (or picked) for E.V, so the hidden E.V Browser can use another one.
static PREFERRED: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub fn browsers_set_preferred(name: Option<String>) {
    *lock(&PREFERRED) = name.filter(|n| !n.trim().is_empty());
}

pub fn preferred() -> Option<String> {
    lock(&PREFERRED).clone()
}

/// The Chromium browser the hidden E.V Browser runs on: Vivaldi if it's here (older setups), else
/// the first Chromium browser the user doesn't browse in themselves, else any Chromium browser.
pub fn hidden_engine() -> Option<(String, PathBuf)> {
    const ORDER: &[&str] = &["Vivaldi", "Chromium", "Google Chrome", "Brave Browser", "Microsoft Edge", "Opera", "Google Chrome Canary", "Thorium", "Ungoogled Chromium"];
    let home = crate::shell_env::home_dir();
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for name in ORDER {
        for base in [PathBuf::from("/Applications"), home.join("Applications")] {
            let app = base.join(format!("{name}.app"));
            let exe = plist_value(&app, "CFBundleExecutable");
            let exe_path = app.join("Contents/MacOS").join(if exe.is_empty() { name.to_string() } else { exe });
            if exe_path.exists() {
                found.push((name.to_string(), exe_path));
                break;
            }
        }
    }
    // Any other Chromium browser on the Mac (new ones included).
    if found.is_empty() {
        for path in web_apps() {
            let info = inspect(&path);
            if info.engine == "blink" && is_browser_like(&info) {
                let exe = plist_value(&path, "CFBundleExecutable");
                let exe_path = path.join("Contents/MacOS").join(exe);
                if exe_path.exists() {
                    found.push((info.name, exe_path));
                }
            }
        }
    }
    let theirs = preferred().unwrap_or_else(crate::mac_control::mac_default_browser).to_lowercase();
    found.iter().find(|(n, _)| n.to_lowercase() != theirs).or(found.first()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_for_applescript() {
        assert_eq!(apple_string("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }

    #[test]
    fn judges_batches_like_clicks() {
        let send = json!({ "actions": [ { "do": "set", "role": "TextField", "label": "Message" }, { "do": "click", "role": "Button", "label": "Send" } ] });
        assert!(matches!(judge(&send).0, Verdict::Final));
        let settings = json!({ "actions": [ { "do": "select", "role": "PopUp", "label": "Timer font" }, { "do": "check", "role": "CheckBox", "label": "Show average" }, { "do": "click", "role": "Clickable", "label": "display" } ] });
        assert!(matches!(judge(&settings).0, Verdict::Ok));
        let pay = json!({ "actions": [ { "do": "click", "role": "Button", "label": "Pay now" } ] });
        assert!(matches!(judge(&pay).0, Verdict::Never));
        let password = json!({ "actions": [ { "do": "set", "role": "TextField", "label": "Password", "password": true } ] });
        assert!(matches!(judge(&password).0, Verdict::Never));
        let search = json!({ "actions": [ { "do": "press", "key": "Enter", "label": "Search", "search": true } ] });
        assert!(matches!(judge(&search).0, Verdict::Ok));
        let enter = json!({ "actions": [ { "do": "press", "key": "Enter", "label": "Message #general" } ] });
        assert!(matches!(judge(&enter).0, Verdict::Final));
    }

    #[test]
    fn reads_numbers_however_written() {
        assert_eq!(normalize_action(json!({ "do": "click", "id": "#12" })), json!({ "do": "click", "ref": 12 }));
        assert_eq!(normalize_action(json!({ "do": "click", "ref": 7 })), json!({ "do": "click", "ref": 7 }));
    }

    #[test]
    fn knows_the_browsers_on_this_mac() {
        for app in ["/Applications/Safari.app", "/Applications/Google Chrome.app", "/Applications/Brave Browser.app", "/Applications/Ardia.app"] {
            let p = Path::new(app);
            if !p.exists() {
                continue;
            }
            let info = inspect(p);
            println!("{} → {} · route {} · scriptable {}", info.name, info.engine, info.route, info.scriptable);
            let want = if app.contains("Safari") { "webkit" } else { "blink" };
            assert_eq!(info.engine, want, "{app}");
        }
    }
}
