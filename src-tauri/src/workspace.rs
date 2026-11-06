use crate::shell_env::{expand_tilde, home_dir};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Skills whose instructions depend on tools only Claude has (its apps, connectors, sub-agents).
const CLAUDE_ONLY_SKILLS: &[&str] = &[
    "token-save",
    "deep-research",
    "docs",
    "google-workspace",
    "morning",
    "import-memory",
    "computer-use",
    "chrome-browser",
    "built-in-browser",
];

/// Native macOS folder chooser. Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut script = String::from("POSIX path of (choose folder with prompt \"Choose a project folder\"");
    if let Some(dir) = default_path.map(|p| expand_tilde(&p)).filter(|p| p.is_dir()) {
        script.push_str(&format!(" default location (POSIX file \"{}\")", dir.display().to_string().replace('"', "\\\"")));
    }
    script.push(')');
    run_osascript(&script).await
}

/// Native "save as" dialog; returns the chosen path or `None` on cancel.
#[tauri::command]
pub async fn pick_save_path(default_name: String) -> Result<Option<String>, String> {
    let script = format!(
        "POSIX path of (choose file name with prompt \"Save log\" default name \"{}\")",
        default_name.replace('"', "\\\"")
    );
    run_osascript(&script).await
}

async fn run_osascript(script: &str) -> Result<Option<String>, String> {
    let output = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // -128 is "User canceled".
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(expand_tilde(&path), contents).await.map_err(|e| e.to_string())
}

/// Claude Code keeps transcripts in ~/.claude/projects/<cwd with non-alphanumerics as '-'>.
pub fn claude_project_dir(cwd: &str) -> PathBuf {
    let key: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    home_dir().join(".claude/projects").join(key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionInfo {
    pub id: String,
    /// First thing the user asked, as a title.
    pub title: String,
    pub modified: f64,
    pub size: u64,
}

fn user_text(value: &serde_json::Value) -> Option<String> {
    if value.get("type")?.as_str()? != "user" || value.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let clean = text.trim();
    // Skip command wrappers and tool results that Claude Code records as user turns.
    if clean.is_empty() || clean.starts_with('<') || clean.starts_with("Caveat:") {
        return None;
    }
    Some(clean.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect())
}

fn session_title(path: &Path) -> String {
    let Ok(file) = std::fs::File::open(path) else { return String::new() };
    let mut summary = None;
    for line in BufReader::new(file).lines().take(400).map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("summary") | Some("custom-title") | Some("ai-title") => {
                let text = value
                    .get("summary")
                    .or_else(|| value.get("customTitle"))
                    .or_else(|| value.get("aiTitle"))
                    .or_else(|| value.get("title"))
                    .and_then(|s| s.as_str());
                if let Some(text) = text.filter(|t| !t.is_empty()) {
                    summary = Some(text.to_string());
                }
            }
            _ => {
                if let Some(text) = user_text(&value) {
                    return summary.unwrap_or(text);
                }
            }
        }
    }
    summary.unwrap_or_default()
}

/// Past Claude Code sessions for a folder, newest first — what `/resume` lists there.
#[tauri::command]
pub async fn claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionInfo>, String> {
    let cwd = expand_tilde(&cwd).display().to_string();
    tokio::task::spawn_blocking(move || {
        let dir = claude_project_dir(&cwd);
        let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
        let mut sessions: Vec<ClaudeSessionInfo> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
                let path = e.path();
                let title = session_title(&path);
                if title.is_empty() {
                    return None;
                }
                Some(ClaudeSessionInfo {
                    id: path.file_stem()?.to_string_lossy().into_owned(),
                    title,
                    modified,
                    size: meta.len(),
                })
            })
            .collect();
        sessions.sort_by(|a, b| b.modified.partial_cmp(&a.modified).unwrap_or(std::cmp::Ordering::Equal));
        Ok(sessions)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Id of the Claude session in `cwd` written to most recently since `since` (epoch seconds),
/// ignoring ids other E.V sessions already own. Used to follow `/clear` and `/resume`.
#[tauri::command]
pub fn claude_latest_session(cwd: String, since: f64, exclude: Vec<String>) -> Option<String> {
    let dir = claude_project_dir(&expand_tilde(&cwd).display().to_string());
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let id = path.file_stem()?.to_string_lossy().into_owned();
            let modified = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
            (modified >= since && !exclude.contains(&id)).then_some((modified, id))
        })
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(_, id)| id)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub claude_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub global_rules: Option<String>,
    pub project_rules: Option<String>,
    pub summary: Option<String>,
    pub skills: Vec<SkillInfo>,
    pub cwd: String,
    pub home: String,
}

/// Minimal YAML front-matter reader for SKILL.md: `key: value`, quoted values and
/// folded/literal block scalars (`>`, `>-`, `|`).
pub fn parse_front_matter(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let mut i = 0;
    while i < body.len() {
        let line = body[i];
        i += 1;
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_string();
        let value = value.trim();
        if value.starts_with('>') || value.starts_with('|') {
            let folded = value.starts_with('>');
            let mut parts = Vec::new();
            while i < body.len() && (body[i].starts_with(' ') || body[i].starts_with('\t') || body[i].trim().is_empty()) {
                parts.push(body[i].trim());
                i += 1;
            }
            let joined = if folded { parts.join(" ") } else { parts.join("\n") };
            out.insert(key, joined.trim().to_string());
        } else {
            let unquoted = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            out.insert(key, unquoted.to_string());
        }
    }
    out
}

fn skill_dirs() -> Vec<PathBuf> {
    let root = home_dir().join(".claude/skills");
    let mut dirs = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else { return dirs };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            dirs.push(path);
        } else if path.file_name().and_then(|n| n.to_str()) == Some("synced") {
            // claude.ai-synced skills live one or two levels deeper.
            for account in std::fs::read_dir(&path).into_iter().flatten().filter_map(Result::ok) {
                for skill in std::fs::read_dir(account.path()).into_iter().flatten().filter_map(Result::ok) {
                    if skill.path().join("SKILL.md").is_file() {
                        dirs.push(skill.path());
                    }
                }
            }
        }
    }
    dirs
}

/// Every skill Claude Code would see, deduplicated by name (personal skills win over synced).
pub fn list_skills() -> Vec<SkillInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut skills = Vec::new();
    for dir in skill_dirs() {
        let Ok(text) = std::fs::read_to_string(dir.join("SKILL.md")) else { continue };
        let meta = parse_front_matter(&text);
        let name = meta
            .get("name")
            .cloned()
            .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
        if !seen.insert(name.clone()) {
            continue;
        }
        skills.push(SkillInfo {
            claude_only: CLAUDE_ONLY_SKILLS.contains(&name.as_str()),
            description: meta.get("description").cloned().unwrap_or_default(),
            path: dir.display().to_string(),
            name,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn read_optional(path: PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok().filter(|t| !t.trim().is_empty())
}

/// Rules, project summary and skills an agent needs for a session in `cwd`.
#[tauri::command]
pub async fn agent_context(cwd: String) -> AgentContext {
    let dir = expand_tilde(&cwd);
    let cwd_text = dir.display().to_string();
    tokio::task::spawn_blocking(move || AgentContext {
        global_rules: read_optional(home_dir().join(".claude/CLAUDE.md")),
        project_rules: read_optional(dir.join("CLAUDE.md")),
        summary: read_optional(dir.join("SUMMARY.md")),
        skills: list_skills(),
        cwd: cwd_text,
        home: home_dir().display().to_string(),
    })
    .await
    .unwrap_or_else(|_| AgentContext {
        global_rules: None,
        project_rules: None,
        summary: None,
        skills: Vec::new(),
        cwd,
        home: home_dir().display().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub name: String,
    pub path: String,
    pub content: String,
    /// Other files in the skill folder, relative to `path`, for the agent to read if needed.
    pub files: Vec<String>,
    pub claude_only: bool,
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 3 || out.len() > 200 {
        return;
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out, depth + 1);
        } else if path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.display().to_string());
            }
        }
    }
}

#[tauri::command]
pub async fn load_skill(name: String) -> Result<SkillContent, String> {
    tokio::task::spawn_blocking(move || {
        let skill = list_skills()
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("No skill named \"{name}\""))?;
        let root = PathBuf::from(&skill.path);
        let content = std::fs::read_to_string(root.join("SKILL.md")).map_err(|e| e.to_string())?;
        let mut files = Vec::new();
        collect_files(&root, &root, &mut files, 0);
        files.sort();
        Ok(SkillContent { name: skill.name, path: skill.path, content, files, claude_only: skill.claude_only })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_front_matter() {
        let text = "---\nname: caveman\ndescription: >\n  Talks short.\n  Saves tokens.\nother: \"quoted\"\n---\n# Body";
        let meta = parse_front_matter(text);
        assert_eq!(meta["name"], "caveman");
        assert_eq!(meta["description"], "Talks short. Saves tokens.");
        assert_eq!(meta["other"], "quoted");
    }

    #[test]
    fn maps_folders_to_claude_project_dirs() {
        assert!(claude_project_dir("/Users/a/Jarvis 2.0").ends_with(".claude/projects/-Users-a-Jarvis-2-0"));
    }

    #[test]
    fn finds_real_skills() {
        let skills = list_skills();
        if skills.is_empty() {
            return; // machine without skills
        }
        assert!(skills.iter().all(|s| !s.name.is_empty()));
        assert!(skills.iter().filter(|s| s.name == "caveman").count() <= 1);
    }
}
