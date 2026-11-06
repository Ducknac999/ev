//! Safe-copy workspaces: an approved coding job runs in an APFS clone of the project (instant, no
//! extra disk space until files change). Nothing reaches the real project until the user reviews
//! the changes and presses Keep.

use crate::shell_env::{expand_tilde, home_dir};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Folders that are generated or huge; never compared or copied back.
const SKIP: &[&str] = &["node_modules", ".git", "target", "dist", "build", ".next", ".turbo", ".cache", "venv", ".venv", "__pycache__", ".DS_Store"];

fn root() -> PathBuf {
    home_dir().join("Library/Application Support/com.ducknac.ev/workspaces")
}

fn inside_root(path: &Path) -> bool {
    path.starts_with(root()) && path != root()
}

/// A relative path that can't climb out of its folder.
fn safe_relative(rel: &str) -> Option<PathBuf> {
    let path = PathBuf::from(rel);
    path.components().all(|c| matches!(c, Component::Normal(_))).then_some(path)
}

#[tauri::command]
pub async fn workspace_clone(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let src = expand_tilde(&project);
        if !src.is_dir() {
            return Err(format!("{} is not a folder", src.display()));
        }
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let dest = root().join(format!("{stamp}-{name}"));
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        // -c clones on APFS (copy-on-write); falls back to a normal copy elsewhere.
        let status = std::process::Command::new("/bin/cp")
            .args(["-cRp", &format!("{}/.", src.display()), &dest.display().to_string()])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = std::fs::remove_dir_all(&dest);
            return Err("couldn't make a safe copy of the project".into());
        }
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// added · modified · deleted
    pub status: &'static str,
}

fn files(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            files(base, &path, out);
        } else if kind.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.display().to_string());
            }
        }
    }
}

pub fn changes(real: &Path, shadow: &Path) -> Vec<Change> {
    let (mut a, mut b) = (Vec::new(), Vec::new());
    files(real, real, &mut a);
    files(shadow, shadow, &mut b);
    let before: std::collections::HashSet<&String> = a.iter().collect();
    let after: std::collections::HashSet<&String> = b.iter().collect();
    let mut out: Vec<Change> = Vec::new();
    for rel in &b {
        if !before.contains(rel) {
            out.push(Change { path: rel.clone(), status: "added" });
        } else if std::fs::read(real.join(rel)).ok() != std::fs::read(shadow.join(rel)).ok() {
            out.push(Change { path: rel.clone(), status: "modified" });
        }
    }
    for rel in &a {
        if !after.contains(rel) {
            out.push(Change { path: rel.clone(), status: "deleted" });
        }
    }
    out.sort_by(|x, y| x.path.cmp(&y.path));
    out
}

#[tauri::command]
pub async fn workspace_changes(project: String, shadow: String) -> Result<Vec<Change>, String> {
    tokio::task::spawn_blocking(move || Ok(changes(&expand_tilde(&project), &PathBuf::from(shadow)))).await.map_err(|e| e.to_string())?
}

/// Copies the reviewed changes into the real project.
#[tauri::command]
pub async fn workspace_apply(project: String, shadow: String, paths: Vec<String>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let real = expand_tilde(&project);
        let shadow = PathBuf::from(shadow);
        if !inside_root(&shadow) {
            return Err("that isn't an E.V safe copy".into());
        }
        let mut applied = 0;
        for rel in paths {
            let rel = safe_relative(&rel).ok_or_else(|| format!("refusing path {rel}"))?;
            let (from, to) = (shadow.join(&rel), real.join(&rel));
            if from.is_file() {
                if let Some(dir) = to.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", rel.display()))?;
            } else if to.is_file() {
                std::fs::remove_file(&to).map_err(|e| format!("{}: {e}", rel.display()))?;
            }
            applied += 1;
        }
        Ok(applied)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_discard(shadow: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let shadow = PathBuf::from(shadow);
        if !inside_root(&shadow) {
            return Err("that isn't an E.V safe copy".into());
        }
        std::fs::remove_dir_all(&shadow).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_and_applies_changes() {
        let base = std::env::temp_dir().join(format!("gideon-shadow-test-{}", std::process::id()));
        let real = base.join("real");
        let shadow = base.join("shadow");
        for dir in [&real, &shadow] {
            std::fs::create_dir_all(dir.join("src")).unwrap();
            std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        }
        std::fs::write(real.join("src/a.ts"), "old").unwrap();
        std::fs::write(real.join("gone.txt"), "x").unwrap();
        std::fs::write(shadow.join("src/a.ts"), "new").unwrap();
        std::fs::write(shadow.join("src/b.ts"), "added").unwrap();
        std::fs::write(shadow.join("node_modules/ignored.js"), "y").unwrap();
        assert_eq!(
            changes(&real, &shadow),
            vec![
                Change { path: "gone.txt".into(), status: "deleted" },
                Change { path: "src/a.ts".into(), status: "modified" },
                Change { path: "src/b.ts".into(), status: "added" },
            ]
        );
        assert!(safe_relative("../etc/passwd").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }
}
