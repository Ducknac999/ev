//! Actions an API model (Gemini, Groq, …) can take on the Mac. The frontend shows each one to
//! the user as an approval card and only calls these commands after the user approves.

use crate::shell_env::expand_tilde;
use crate::tasks::TaskRegistry;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncReadExt;

const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS: usize = 60_000;
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", ".next", "venv", ".venv", "__pycache__", "Library"];

/// Resolves a tool path: `~` expands, relative paths are taken from the session folder.
fn resolve(cwd: &str, path: &str) -> PathBuf {
    let p = expand_tilde(path.trim());
    if p.is_absolute() {
        p
    } else {
        expand_tilde(cwd).join(p)
    }
}

fn truncate(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\n…[truncated — output was {} characters]", text.chars().count())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub total_lines: usize,
}

/// Reads a text file (optionally a line window). Used both by the `read_file` tool and to
/// render edit previews on approval cards.
#[tauri::command]
pub async fn tool_read_file(cwd: String, path: String, offset: Option<usize>, limit: Option<usize>) -> Result<FileText, String> {
    let full = resolve(&cwd, &path);
    let shown = full.display().to_string();
    let meta = match tokio::fs::metadata(&full).await {
        Ok(m) => m,
        Err(_) => return Ok(FileText { path: shown, exists: false, content: String::new(), total_lines: 0 }),
    };
    if meta.is_dir() {
        return Err(format!("{shown} is a folder — use list_directory"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{shown} is {} MB; too large to read as text", meta.len() / 1024 / 1024));
    }
    let bytes = tokio::fs::read(&full).await.map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(format!("{shown} is a binary file"));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let total_lines = text.lines().count();
    let content = match (offset, limit) {
        (None, None) => text,
        (o, l) => {
            let start = o.unwrap_or(1).max(1) - 1;
            text.lines().skip(start).take(l.unwrap_or(usize::MAX)).collect::<Vec<_>>().join("\n")
        }
    };
    Ok(FileText { path: shown, exists: true, content, total_lines })
}

#[tauri::command]
pub async fn tool_write_file(cwd: String, path: String, content: String) -> Result<String, String> {
    let full = resolve(&cwd, &path);
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let existed = full.exists();
    tokio::fs::write(&full, content.as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(format!(
        "{} {} ({} lines)",
        if existed { "Overwrote" } else { "Created" },
        full.display(),
        content.lines().count()
    ))
}

#[tauri::command]
pub async fn tool_edit_file(cwd: String, path: String, old_string: String, new_string: String, replace_all: Option<bool>) -> Result<String, String> {
    let full = resolve(&cwd, &path);
    let text = tokio::fs::read_to_string(&full).await.map_err(|e| format!("{}: {e}", full.display()))?;
    if old_string.is_empty() {
        return Err("old_string is empty — use write_file to create a file".into());
    }
    let count = text.matches(&old_string).count();
    if count == 0 {
        return Err(format!("old_string was not found in {}", full.display()));
    }
    let all = replace_all.unwrap_or(false);
    if count > 1 && !all {
        return Err(format!("old_string appears {count} times in {}; add more context or set replace_all", full.display()));
    }
    let updated = if all { text.replace(&old_string, &new_string) } else { text.replacen(&old_string, &new_string, 1) };
    tokio::fs::write(&full, updated).await.map_err(|e| e.to_string())?;
    Ok(format!("Edited {} ({} replacement{})", full.display(), if all { count } else { 1 }, if all && count != 1 { "s" } else { "" }))
}

#[tauri::command]
pub async fn tool_list_directory(cwd: String, path: String) -> Result<String, String> {
    let full = resolve(&cwd, &path);
    let mut entries = tokio::fs::read_dir(&full).await.map_err(|e| format!("{}: {e}", full.display()))?;
    let mut rows = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().await.ok();
        let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
        let size = meta.filter(|m| m.is_file()).map(|m| format!("  {} B", m.len())).unwrap_or_default();
        rows.push(if is_dir { format!("{name}/") } else { format!("{name}{size}") });
    }
    rows.sort_by_key(|r| (!r.ends_with('/'), r.to_lowercase()));
    Ok(truncate(format!("{}\n{}", full.display(), rows.join("\n")), MAX_OUTPUT_CHARS))
}

fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
}

fn walk(dir: &Path, pattern: &str, out: &mut Vec<String>, depth: usize, limit: usize) {
    if depth > 12 || out.len() >= limit {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        if out.len() >= limit {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if glob_match(pattern, &name) {
            out.push(format!("{}{}", path.display(), if is_dir { "/" } else { "" }));
        }
        if is_dir && !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
            walk(&path, pattern, out, depth + 1, limit);
        }
    }
}

/// Finds files or folders by name. `everywhere` uses Spotlight across the whole Mac.
#[tauri::command]
pub async fn tool_find_files(cwd: String, pattern: String, path: Option<String>, everywhere: Option<bool>) -> Result<String, String> {
    if everywhere.unwrap_or(false) {
        let query = pattern.replace('*', "");
        let output = tokio::process::Command::new("/usr/bin/mdfind")
            .args(["-name", &query])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        let hits: Vec<&str> = text.lines().filter(|l| glob_match(&pattern, l.rsplit('/').next().unwrap_or(l))).take(300).collect();
        return Ok(if hits.is_empty() { format!("No matches for \"{pattern}\" anywhere on this Mac.") } else { hits.join("\n") });
    }
    let root = resolve(&cwd, path.as_deref().unwrap_or("."));
    let pattern_owned = pattern.clone();
    let hits = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(&root, &pattern_owned, &mut out, 0, 500);
        out
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(if hits.is_empty() { format!("No files matching \"{pattern}\".") } else { hits.join("\n") })
}

/// Searches file contents with grep (regex, case-insensitive), skipping dependency folders.
#[tauri::command]
pub async fn tool_search_files(cwd: String, pattern: String, path: Option<String>, glob: Option<String>) -> Result<String, String> {
    let root = resolve(&cwd, path.as_deref().unwrap_or("."));
    let mut cmd = tokio::process::Command::new("/usr/bin/grep");
    cmd.args(["-rniIE", "--color=never", "-m", "50"]);
    for dir in SKIP_DIRS {
        cmd.arg(format!("--exclude-dir={dir}"));
    }
    if let Some(glob) = glob.filter(|g| !g.trim().is_empty()) {
        cmd.arg(format!("--include={glob}"));
    }
    cmd.arg("--").arg(&pattern).arg(&root);
    let output = tokio::time::timeout(Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| "search timed out after 60s — narrow the path".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.trim().is_empty() {
        return Ok(format!("No matches for /{pattern}/ in {}.", root.display()));
    }
    Ok(truncate(text, MAX_OUTPUT_CHARS))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
}

/// Runs a shell command (login zsh) in the session folder. Cancelable via `task_id`.
#[tauri::command]
pub async fn tool_run_command(
    cwd: String,
    command: String,
    timeout_seconds: Option<u64>,
    task_id: String,
    registry: State<'_, TaskRegistry>,
) -> Result<CommandResult, String> {
    let lower = command.to_lowercase();
    // `open` with a web address or Vivaldi must reach the user's Vivaldi, not the hidden E.V Browser.
    if lower.contains("vivaldi") || (lower.contains("open ") && lower.contains("://")) {
        crate::gideon_browser::step_aside();
    }
    let dir = expand_tilde(&cwd);
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(120).clamp(1, 1800));
    let mut child = tokio::process::Command::new("/bin/zsh")
        .args(["-l", "-c", &command])
        .current_dir(if dir.is_dir() { dir } else { crate::shell_env::home_dir() })
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    let task = tokio::spawn(async move {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read = async {
            let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            child.wait().await
        };
        match tokio::time::timeout(timeout, read).await {
            Ok(status) => {
                let mut text = String::from_utf8_lossy(&out).into_owned();
                let err_text = String::from_utf8_lossy(&err);
                if !err_text.trim().is_empty() {
                    if !text.is_empty() && !text.ends_with('\n') {
                        text.push('\n');
                    }
                    text.push_str(&err_text);
                }
                CommandResult { exit_code: status.ok().and_then(|s| s.code()), output: truncate(text, MAX_OUTPUT_CHARS), timed_out: false }
            }
            Err(_) => CommandResult { exit_code: None, output: truncate(String::from_utf8_lossy(&out).into_owned(), MAX_OUTPUT_CHARS), timed_out: true },
        }
    });
    registry.insert(&task_id, task.abort_handle());
    let outcome = task.await;
    registry.remove(&task_id);
    match outcome {
        Ok(result) => Ok(result),
        Err(e) if e.is_cancelled() => Err("command stopped".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Named entities common on real pages, plus every numeric one (`&#176;`, `&#xB0;`).
fn decode_entities(text: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("nbsp", " "), ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("deg", "°"),
        ("rsquo", "’"), ("lsquo", "‘"), ("rdquo", "”"), ("ldquo", "“"), ("ndash", "–"), ("mdash", "—"),
        ("hellip", "…"), ("middot", "·"), ("bull", "•"), ("copy", "©"), ("reg", "®"), ("trade", "™"),
        ("frac12", "½"), ("times", "×"), ("euro", "€"), ("pound", "£"), ("cent", "¢"), ("plusmn", "±"),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let decoded = after.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &after[..end];
            let ch = if let Some(num) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(num, 16).ok().and_then(char::from_u32).map(String::from)
            } else if let Some(num) = name.strip_prefix('#') {
                num.parse::<u32>().ok().and_then(char::from_u32).map(String::from)
            } else {
                NAMED.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string())
            };
            ch.map(|c| (c, end))
        });
        match decoded {
            Some((ch, end)) => {
                out.push_str(&ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut skip_until: Option<&str> = None;
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    let step = |i: usize| html[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    while i < bytes.len() {
        if let Some(end) = skip_until {
            if lower[i..].starts_with(end) {
                i += end.len();
                skip_until = None;
            } else {
                i += step(i);
            }
            continue;
        }
        let c = bytes[i] as char;
        if c == '<' {
            if lower[i..].starts_with("<script") {
                skip_until = Some("</script>");
            } else if lower[i..].starts_with("<style") {
                skip_until = Some("</style>");
            } else if ["<br", "<p", "</p", "<div", "</div", "<li", "<h", "</h", "<tr"].iter().any(|t| lower[i..].starts_with(t)) {
                out.push('\n');
            }
            in_tag = true;
            i += 1;
            continue;
        }
        if c == '>' && in_tag {
            in_tag = false;
            i += 1;
            continue;
        }
        let ch_len = step(i);
        if !in_tag {
            out.push_str(&html[i..i + ch_len]);
        }
        i += ch_len;
    }
    let decoded = decode_entities(&out);
    let mut lines: Vec<String> = Vec::new();
    for line in decoded.lines() {
        let t = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() || lines.last().is_some_and(|l| !l.is_empty()) {
            lines.push(t);
        }
    }
    lines.join("\n")
}

#[tauri::command]
pub async fn tool_web_fetch(url: String) -> Result<String, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http(s) URLs can be fetched".into());
    }
    let response = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh) E.V/1.0")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let is_html = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.contains("html"));
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&bytes[..bytes.len().min(3 * 1024 * 1024)]).into_owned();
    let text = if is_html { html_to_text(&raw) } else { raw };
    Ok(truncate(format!("HTTP {} — {url}\n\n{text}", status.as_u16()), MAX_OUTPUT_CHARS))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() => {
                let hex = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
                out.push(hex(bytes[i + 1]) << 4 | hex(bytes[i + 2]));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(&text[from..to])
}

#[derive(Debug, PartialEq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// URL-safe or standard base64 without padding requirements (Bing link targets).
pub(crate) fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        buffer = buffer << 6 | value(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Real destination of a result link: Bing wraps them in `/ck/a?…&u=a1<base64 url>` and Google
/// sometimes in `/url?q=<url>`.
pub fn clean_result_url(href: &str) -> String {
    let href = href.replace("&amp;", "&");
    if href.contains("bing.com/ck/") {
        if let Some(url) = href
            .split(['?', '&'])
            .find_map(|part| part.strip_prefix("u=a1"))
            .and_then(base64_decode)
            .and_then(|bytes| String::from_utf8(bytes).ok())
        {
            return url;
        }
    }
    if href.contains("google.") && href.contains("/url?") {
        if let Some(url) = href.split(['?', '&']).find_map(|part| part.strip_prefix("q=").or_else(|| part.strip_prefix("url="))) {
            return percent_decode(url);
        }
    }
    href
}

/// Organic results from Bing's HTML page.
fn parse_bing(html: &str) -> Vec<SearchHit> {
    html.split("<li class=\"b_algo\"")
        .skip(1)
        .filter_map(|block| {
            let heading = between(block, "<h2", "</h2>")?;
            let href = between(heading, "href=\"", "\"")?;
            let title = html_to_text(&heading[heading.find('>')? + 1..]).split_whitespace().collect::<Vec<_>>().join(" ");
            let snippet = block
                .split("<p")
                .skip(1)
                .find_map(|p| between(p, ">", "</p>"))
                .map(|s| html_to_text(s).split_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let url = clean_result_url(href);
            (!title.is_empty() && url.starts_with("http")).then_some(SearchHit { title, url, snippet })
        })
        .take(8)
        .collect()
}

const BROWSER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// Plain-HTTP Bing, the last resort when the hidden browser can't run.
async fn search_bing_http(query: &str) -> Result<Vec<SearchHit>, String> {
    let response = reqwest::Client::builder()
        .user_agent(BROWSER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get("https://www.bing.com/search")
        .query(&[("q", query), ("setlang", "en")])
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Bing: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Bing returned HTTP {}", response.status().as_u16()));
    }
    Ok(parse_bing(&response.text().await.map_err(|e| e.to_string())?))
}

fn format_hits(hits: impl Iterator<Item = (String, String, String)>) -> String {
    hits.enumerate()
        .map(|(i, (title, url, snippet))| format!("[{}] {title}\n{url}\n{snippet}", i + 1))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Web search: Google, then Bing, then Brave, each in a hidden browser window so answer boxes
/// (weather, race times in local time, …) come through. Plain-HTTP Bing is the last resort.
#[tauri::command]
pub async fn tool_web_search(query: String, app: tauri::AppHandle) -> Result<String, String> {
    match crate::browser_search::search(&app, &query).await {
        Ok(found) => {
            let mut text = format!("Source: {} search for \"{query}\"", found.engine.name());
            if !found.overview.is_empty() {
                text.push_str(&format!("\n\nTop of the results page (answer boxes come first):\n{}", found.overview));
            }
            if !found.results.is_empty() {
                text.push_str("\n\nResults:\n");
                text.push_str(&format_hits(found.results.into_iter().map(|h| (h.title, h.url, h.snippet))));
            }
            Ok(text)
        }
        Err(browser) => {
            let hits = search_bing_http(&query).await.map_err(|bing| format!("{browser}; {bing}"))?;
            if hits.is_empty() {
                return Ok(format!("No results for \"{query}\"."));
            }
            Ok(format!("Source: Bing (plain) search for \"{query}\"\n\nResults:\n{}", format_hits(hits.into_iter().map(|h| (h.title, h.url, h.snippet)))))
        }
    }
}

/// Free live-data services the agent tools may read (no keys, no personal data sent).
const LIVE_HOSTS: &[&str] = &[
    "api.open-meteo.com",
    "geocoding-api.open-meteo.com",
    "site.api.espn.com",
    "api.jolpi.ca",
    "en.wikipedia.org",
];

/// GETs JSON from one of the live-data services above; the frontend formats it.
#[tauri::command]
pub async fn live_fetch_json(url: String) -> Result<String, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad URL: {e}"))?;
    if parsed.scheme() != "https" || !LIVE_HOSTS.contains(&parsed.host_str().unwrap_or("")) {
        return Err("that address is not one of the live-data services".into());
    }
    let response = reqwest::Client::new()
        .get(parsed)
        .header("User-Agent", "E.V/1.0 (desktop assistant)")
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.chars().take(200).collect::<String>()));
    }
    Ok(body)
}

#[tauri::command]
pub fn tool_cancel(task_id: String, registry: State<'_, TaskRegistry>) -> bool {
    registry.abort(&task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_globs() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(glob_match("Gideon", "gideon"));
        assert!(glob_match("gid*", "Gideon.app"));
        assert!(!glob_match("*.ts", "main.rs"));
    }

    #[test]
    fn converts_html() {
        assert_eq!(html_to_text("<p>café — ünïcode</p>").trim(), "café — ünïcode");
        let text = html_to_text("<html><style>x{}</style><h1>Title</h1><p>Hello &amp; bye</p><script>evil()</script></html>");
        assert!(text.contains("Title"));
        assert!(text.contains("Hello & bye"));
        assert!(!text.contains("evil"));
        assert_eq!(decode_entities("61&deg;F &#176; &#xB0; &rsquo;s &bogus; a & b"), "61°F ° ° ’s &bogus; a & b");
    }

    #[test]
    fn parses_bing_results() {
        let html = r#"<li class="b_algo" data-id><style>.x{}</style><h2 class=""><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cHM6Ly93ZWF0aGVyLmNvbS91cy9mcmVtb250&amp;ntb=1">Springfield <strong>Weather</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">Highs near 72.</p></div></li>"#;
        assert_eq!(
            parse_bing(html),
            vec![SearchHit { title: "Springfield Weather".into(), url: "https://weather.com/us/springfield".into(), snippet: "Highs near 72.".into() }]
        );
    }

    #[test]
    fn cleans_result_urls() {
        assert_eq!(clean_result_url("https://www.google.com/url?q=https%3A%2F%2Fa.com%2Fx&sa=U"), "https://a.com/x");
        assert_eq!(clean_result_url("https://a.com/page"), "https://a.com/page");
        assert_eq!(percent_decode("a%20b%zz+c"), "a b%zz c");
    }

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(resolve("/tmp/project", "src/a.rs"), PathBuf::from("/tmp/project/src/a.rs"));
        assert_eq!(resolve("/tmp/project", "/etc/hosts"), PathBuf::from("/etc/hosts"));
    }
}
