//! "Find my resume": Spotlight (the index ⌘Space uses), ranked like a person would — names over
//! contents, recently used first, your folders over app junk — with no AI and no tokens. The
//! request's own words narrow it: "latest", "PDF", "in Downloads", "from last week".

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(serde::Serialize, Debug, Clone)]
pub struct Hit {
    pub path: String,
    pub name: String,
    /// "Documents/School"
    pub folder: String,
    /// "today", "yesterday", "Mar 3"
    pub when: String,
    pub score: i32,
    /// The name matches (not only words inside the file).
    pub named: bool,
}

#[derive(serde::Serialize, Debug, Default)]
pub struct FileSearch {
    pub results: Vec<Hit>,
    /// One result is clearly the one meant: open it without asking.
    pub clear: bool,
    /// The request without filler ("resume pdf"), for remembering the pick.
    pub key: String,
    /// Nothing to search for (the request was only filler).
    pub empty: bool,
}

#[derive(Default, Debug, PartialEq)]
struct Request {
    terms: Vec<String>,
    kinds: Vec<&'static str>,
    folder: Option<&'static str>,
    since: Option<Duration>,
    until: Option<Duration>,
    latest: bool,
    folders_only: bool,
    screenshot: bool,
    /// "code", "script", "project": source files aren't pushed down.
    code: bool,
}

const FILLER: &[&str] = &[
    "find", "open", "show", "where", "where's", "wheres", "is", "are", "my", "the", "a", "an", "file", "files", "for", "me", "please", "called", "named", "about", "in", "on", "from", "that", "i", "was",
    "were", "with", "of", "to", "and", "can", "you", "could", "pull", "up", "bring", "get", "locate", "search", "look", "it", "this", "one", "hey", "e.v", "ev", "evie", "eevee", "some", "any", "made",
    "edited", "saved", "downloaded", "wrote", "copy", "version", "most", "recent", "recently", "newest", "latest", "last", "week", "month", "year", "today", "yesterday", "folder",
];

const KINDS: &[(&[&str], &[&str])] = &[
    (&["pdf", "pdfs"], &["pdf"]),
    (&["word", "docx", "doc"], &["docx", "doc"]),
    (&["pages"], &["pages"]),
    (&["excel", "spreadsheet", "spreadsheets", "xlsx", "sheet", "csv", "numbers"], &["xlsx", "xls", "csv", "numbers"]),
    (&["powerpoint", "slides", "presentation", "deck", "pptx", "keynote"], &["pptx", "ppt", "key"]),
    (&["image", "photo", "photos", "picture", "pictures", "screenshot", "screenshots", "png", "jpg", "jpeg", "heic"], &["png", "jpg", "jpeg", "heic", "gif", "webp"]),
    (&["video", "videos", "movie", "mp4", "mov", "recording"], &["mp4", "mov", "m4v", "mkv"]),
    (&["song", "audio", "mp3", "wav", "m4a"], &["mp3", "wav", "m4a", "aiff", "flac"]),
    (&["zip", "archive"], &["zip", "rar", "7z", "tar", "gz"]),
];

/// Source and build files: rarely what "my resume" means.
const CODE_KINDS: &[&str] = &[
    "c", "h", "cc", "cpp", "hpp", "m", "mm", "js", "jsx", "ts", "tsx", "rs", "py", "swift", "go", "java", "kt", "rb", "php", "cs", "json", "yml", "yaml", "toml", "lock", "o", "map",
    "css", "scss", "html", "svelte", "vue", "mjs", "cjs", "xml", "plist", "sh", "log", "d", "rlib", "class", "pyc", "sql", "gradle", "cmake",
];

/// Documents people usually mean by these words.
const DOC_WORDS: &[&str] = &["resume", "cv", "cover", "letter", "essay", "report", "assignment", "homework", "notes", "contract", "invoice", "receipt", "form", "application"];
const DOC_KINDS: &[&str] = &["pdf", "docx", "doc", "pages", "rtf", "txt", "md", "odt"];

const FOLDERS: &[(&str, &str)] = &[("downloads", "Downloads"), ("desktop", "Desktop"), ("documents", "Documents"), ("pictures", "Pictures"), ("movies", "Movies"), ("music", "Music")];

const DAY: u64 = 86_400;

fn parse(text: &str) -> Request {
    let lower = text.to_lowercase();
    let words: Vec<String> = lower.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '.' || c == '-' || c == '_')).filter(|w| !w.is_empty()).map(|w| w.trim_matches('.').to_string()).collect();
    let mut req = Request::default();
    let has = |p: &str| lower.contains(p);
    req.latest = has("latest") || has("newest") || has("most recent") || has("last edited") || has("recent");
    if has("today") {
        req.since = Some(Duration::from_secs(DAY));
    } else if has("yesterday") {
        req.since = Some(Duration::from_secs(2 * DAY));
        req.until = Some(Duration::from_secs(DAY));
    } else if has("this week") || has("past week") {
        req.since = Some(Duration::from_secs(7 * DAY));
    } else if has("last week") {
        req.since = Some(Duration::from_secs(14 * DAY));
    } else if has("this month") || has("past month") {
        req.since = Some(Duration::from_secs(31 * DAY));
    } else if has("last month") {
        req.since = Some(Duration::from_secs(62 * DAY));
    } else if has("this year") || has("last year") {
        req.since = Some(Duration::from_secs(366 * DAY));
    }
    req.folders_only = words.iter().any(|w| w == "folder" || w == "folders");
    req.screenshot = words.iter().any(|w| w.starts_with("screenshot") || w == "screen" && has("screen shot"));
    req.code = words.iter().any(|w| ["code", "script", "source", "project", "repo", "function", "class"].contains(&w.as_str()));
    for (i, word) in words.iter().enumerate() {
        if let Some((_, exts)) = KINDS.iter().find(|(names, _)| names.contains(&word.as_str())) {
            for e in exts.iter() {
                if !req.kinds.contains(e) {
                    req.kinds.push(e);
                }
            }
            continue;
        }
        let after_in = i > 0 && matches!(words[i - 1].as_str(), "in" | "from" | "on");
        if let Some((_, folder)) = FOLDERS.iter().find(|(name, _)| name == word) {
            if after_in || req.folder.is_none() {
                req.folder = Some(folder);
                continue;
            }
        }
        if FILLER.contains(&word.as_str()) || word.len() < 2 {
            continue;
        }
        req.terms.push(word.clone());
    }
    req
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// Places that are never what someone means by "my file".
fn junk(path: &str, home: &str) -> bool {
    let rel = path.strip_prefix(home).unwrap_or(path);
    let icloud = rel.starts_with("/Library/Mobile Documents/com~apple~CloudDocs");
    (rel.starts_with("/Library/") && !icloud)
        || rel.split('/').any(|c| c.starts_with('.') && c.len() > 1)
        || [
            "/node_modules/", ".app/", "/site-packages/", "/Caches/", "/DerivedData/", "/target/", "/build/", "/dist/", "/.Trash/", "/Containers/", "/vendor/", "/__pycache__/",
        ]
        .iter()
        .any(|p| path.contains(p))
        || path.ends_with(".app")
}

fn mdfind(args: &[&str], limit: usize) -> Vec<String> {
    let out = std::process::Command::new("/usr/bin/mdfind").args(args).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().take(limit).map(str::to_string).collect()).unwrap_or_default()
}

fn escape(term: &str) -> String {
    term.replace('\\', "").replace('"', "").replace('*', "")
}

fn when(time: SystemTime) -> String {
    let age = SystemTime::now().duration_since(time).unwrap_or_default().as_secs();
    if age < DAY {
        "today".into()
    } else if age < 2 * DAY {
        "yesterday".into()
    } else if age < 7 * DAY {
        format!("{} days ago", age / DAY)
    } else {
        let out = std::process::Command::new("/bin/date")
            .args(["-r", &time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().to_string(), "+%b %-d, %Y"])
            .output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
}

/// When the file was last opened (Spotlight), else last changed.
fn last_used(paths: &[String]) -> Vec<Option<SystemTime>> {
    let mut used: Vec<Option<SystemTime>> = vec![None; paths.len()];
    if !paths.is_empty() {
        let mut args = vec!["-name".to_string(), "kMDItemLastUsedDate".into(), "-raw".into()];
        args.extend(paths.iter().cloned());
        if let Ok(out) = std::process::Command::new("/usr/bin/mdls").args(&args).output() {
            for (i, value) in String::from_utf8_lossy(&out.stdout).split('\0').enumerate().take(paths.len()) {
                // "2026-11-06 21:14:03 +0000"
                if value.len() >= 19 && value.as_bytes()[4] == b'-' {
                    let out = std::process::Command::new("/bin/date").args(["-j", "-u", "-f", "%Y-%m-%d %H:%M:%S", &value[..19], "+%s"]).output();
                    if let Some(secs) = out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok()) {
                        used[i] = Some(std::time::UNIX_EPOCH + Duration::from_secs(secs));
                    }
                }
            }
        }
    }
    used.into_iter()
        .zip(paths)
        .map(|(u, p)| {
            let modified = std::fs::metadata(p).and_then(|m| m.modified()).ok();
            match (u, modified) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            }
        })
        .collect()
}

fn ext(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// `picks`: what you chose before for each request ("resume pdf" → that file).
pub fn search(text: &str, picks: &std::collections::HashMap<String, String>) -> FileSearch {
    let req = parse(text);
    let key = {
        let mut parts = req.terms.clone();
        parts.extend(req.kinds.iter().take(1).map(|k| k.to_string()));
        if let Some(f) = req.folder {
            parts.push(f.to_lowercase());
        }
        parts.join(" ")
    };
    let kind_only = req.terms.is_empty() && (!req.kinds.is_empty() || req.screenshot);
    if req.terms.is_empty() && !kind_only {
        return FileSearch { key, empty: true, ..Default::default() };
    }
    let home = home();
    let home_s = home.display().to_string();
    let root = req.folder.map(|f| home.join(f)).unwrap_or_else(|| home.clone());
    let root_s = root.display().to_string();

    let name_query = if kind_only {
        // "my latest screenshot", "the PDF from this week": by type, recent ones only.
        let kind = if req.screenshot {
            "kMDItemIsScreenCapture == 1".to_string()
        } else {
            format!("({})", req.kinds.iter().map(|k| format!("kMDItemFSName == \"*.{k}\"c")).collect::<Vec<_>>().join(" || "))
        };
        let seconds = req.since.map(|d| d.as_secs()).unwrap_or(90 * DAY);
        format!("{kind} && kMDItemFSContentChangeDate >= $time.now(-{seconds})")
    } else {
        req.terms.iter().map(|t| format!("kMDItemFSName == \"*{}*\"cd", escape(t))).collect::<Vec<_>>().join(" && ")
    };
    let mut by_name = mdfind(&["-onlyin", &root_s, &name_query], 400);
    if root != home {
        // iCloud Drive's Desktop & Documents live elsewhere.
        let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        if icloud.exists() {
            by_name.extend(mdfind(&["-onlyin", &icloud.display().to_string(), &name_query], 100));
        }
    }
    let content_query = req.terms.iter().map(|t| escape(t)).collect::<Vec<_>>().join(" ");
    let by_content = if kind_only { Vec::new() } else { mdfind(&["-onlyin", &root_s, &content_query], 200) };

    let mut candidates: Vec<(String, bool)> = Vec::new();
    for path in by_name {
        if !junk(&path, &home_s) && !candidates.iter().any(|(p, _)| *p == path) {
            candidates.push((path, true));
        }
    }
    for path in by_content {
        if !junk(&path, &home_s) && !candidates.iter().any(|(p, _)| *p == path) {
            candidates.push((path, false));
        }
    }
    candidates.retain(|(path, _)| {
        let is_dir = Path::new(path).is_dir();
        if req.folders_only {
            return is_dir;
        }
        req.screenshot || req.kinds.is_empty() || req.kinds.contains(&ext(path).as_str())
    });
    // Name matches first, then a cheap pre-ranking so the date lookup stays small.
    candidates.sort_by_key(|(p, named)| (!named, p.len()));
    candidates.truncate(40);

    let paths: Vec<String> = candidates.iter().map(|(p, _)| p.clone()).collect();
    let used = last_used(&paths);
    let now = SystemTime::now();
    let doc_words = req.terms.iter().any(|t| DOC_WORDS.contains(&t.as_str()));
    let mut hits: Vec<(Hit, Option<SystemTime>)> = Vec::new();
    for ((path, named), time) in candidates.into_iter().zip(used) {
        let age = time.and_then(|t| now.duration_since(t).ok());
        if let Some(since) = req.since {
            if age.is_none_or(|a| a > since) {
                continue;
            }
        }
        if let Some(until) = req.until {
            if age.is_none_or(|a| a < until) {
                continue;
            }
        }
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let lname = name.to_lowercase();
        let stem = lname.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(lname.clone());
        let mut score = if named { 45 } else { 15 };
        for term in &req.terms {
            let whole = stem.split(|c: char| !c.is_alphanumeric()).any(|w| w == term);
            if whole {
                score += 25;
            }
            if stem.starts_with(term.as_str()) {
                score += 5;
            }
        }
        let rel = path.strip_prefix(&home_s).unwrap_or(&path);
        if ["/Desktop/", "/Documents/", "/Downloads/", "/Library/Mobile Documents/com~apple~CloudDocs/"].iter().any(|f| rel.starts_with(f)) {
            score += 15;
        }
        if doc_words && DOC_KINDS.contains(&ext(&path).as_str()) {
            score += 20;
        }
        if !req.code && CODE_KINDS.contains(&ext(&path).as_str()) {
            score -= 45;
        }
        score += match age.map(|a| a.as_secs()) {
            Some(a) if a < DAY => 25,
            Some(a) if a < 7 * DAY => 18,
            Some(a) if a < 30 * DAY => 12,
            Some(a) if a < 365 * DAY => 5,
            _ => 0,
        };
        // Copies and leftovers rank a little lower.
        if lname.contains("copy") || lname.contains("old") || lname.starts_with('~') {
            score -= 8;
        }
        if ["/tests/", "/test/", "/fixtures/", "/examples/", "/docs/", "/src/"].iter().any(|d| rel.contains(d)) && !req.code {
            score -= 15;
        }
        let folder = Path::new(rel).parent().map(|p| p.display().to_string()).unwrap_or_default();
        let folder = folder.trim_start_matches('/').replace("Library/Mobile Documents/com~apple~CloudDocs", "iCloud Drive");
        let folder = if folder.is_empty() { "Home".to_string() } else { folder };
        hits.push((Hit { when: time.map(when).unwrap_or_default(), path, name, folder, score, named }, time));
    }
    if req.latest {
        hits.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.score.cmp(&a.0.score)));
    } else {
        hits.sort_by(|a, b| b.0.score.cmp(&a.0.score).then(b.1.cmp(&a.1)));
    }
    // Something whose name matches well beats files that only mention the words inside.
    let best = hits.iter().map(|(h, _)| h.score).max().unwrap_or(0);
    let floor = if best >= 70 { 40 } else { 0 };
    let mut results: Vec<Hit> = hits.into_iter().map(|(h, _)| h).filter(|h| h.score >= floor).take(10).collect();
    // The one you picked last time for these words, if it's still there, goes first.
    if let Some(learned) = picks.get(&key).filter(|p| Path::new(p.as_str()).exists()) {
        let hit = match results.iter().position(|h| &h.path == learned) {
            Some(i) => results.remove(i),
            None => {
                let name = Path::new(learned).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let rel = learned.strip_prefix(&home_s).unwrap_or(learned);
                let folder = Path::new(rel).parent().map(|p| p.display().to_string()).unwrap_or_default().trim_start_matches('/').to_string();
                Hit { path: learned.clone(), name, folder, when: String::new(), score: 100, named: true }
            }
        };
        results.insert(0, hit);
        return FileSearch { results, clear: true, key, empty: false };
    }
    // Only a name match is ever opened without asking.
    let clear = match results.as_slice() {
        [only] => only.named,
        [first, second, ..] => first.named && (req.latest || first.score - second.score >= 25),
        [] => false,
    };
    FileSearch { results, clear, key, empty: false }
}

#[tauri::command]
pub async fn find_my_files(query: String, picks: Option<std::collections::HashMap<String, String>>) -> FileSearch {
    tokio::task::spawn_blocking(move || search(&query, &picks.unwrap_or_default())).await.unwrap_or_default()
}

#[tauri::command]
pub fn file_open(path: String, reveal: Option<bool>) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That file isn't there anymore.".into());
    }
    let mut args = Vec::new();
    if reveal.unwrap_or(false) {
        args.push("-R");
    }
    args.push(path.as_str());
    std::process::Command::new("/usr/bin/open").args(&args).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// "Take a screenshot" (saved to the Desktop, like ⌘⇧3) or "… into Slack" (`clipboard`: copied,
/// for pasting). Uses E.V's Screen Recording permission.
#[tauri::command]
pub fn voice_screenshot(clipboard: bool) -> Result<String, String> {
    let mut command = std::process::Command::new("/usr/sbin/screencapture");
    command.arg("-x");
    let path = if clipboard {
        command.arg("-c");
        String::new()
    } else {
        let stamp = std::process::Command::new("/bin/date").arg("+%Y-%m-%d at %H.%M.%S").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let path = home().join("Desktop").join(format!("Screenshot {stamp}.png")).display().to_string();
        command.arg(&path);
        path
    };
    let status = command.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Couldn't take the screenshot (Screen Recording permission?)".into());
    }
    Ok(path)
}

/// Which drop-box files are still where they were.
#[tauri::command]
pub fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_request() {
        let r = parse("find my latest resume PDF in Downloads");
        assert_eq!(r.terms, vec!["resume"]);
        assert_eq!(r.kinds, vec!["pdf"]);
        assert_eq!(r.folder, Some("Downloads"));
        assert!(r.latest);
        let r = parse("open the tax return from last week");
        assert_eq!(r.terms, vec!["tax", "return"]);
        assert_eq!(r.since, Some(Duration::from_secs(14 * DAY)));
        assert!(parse("open my file").terms.is_empty());
        assert!(parse("find my school folder").folders_only);
    }

    #[test]
    fn skips_app_junk() {
        let home = "/Users/x";
        assert!(junk("/Users/x/Library/Caches/resume.pdf", home));
        assert!(junk("/Users/x/code/app/node_modules/resume/index.js", home));
        assert!(junk("/Users/x/.cache/resume.pdf", home));
        assert!(!junk("/Users/x/Documents/Resume.pdf", home));
        assert!(!junk("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Resume.pdf", home));
    }
}

#[cfg(test)]
mod real {
    #[test]
    #[ignore]
    fn on_this_mac() {
        for q in ["find my resume", "open my latest screenshot", "find the readme in Documents", "find my pdf from this week"] {
            let started = std::time::Instant::now();
            let found = super::search(q, &Default::default());
            println!("{q:?} → clear={} in {:?}", found.clear, started.elapsed());
            for h in found.results.iter().take(4) {
                println!("   {} · {} · {} · {}", h.score, h.name, h.folder, h.when);
            }
        }
    }
}
