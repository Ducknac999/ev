use crate::speech::percent_decode;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// Largest single file accepted; Gemini's inline request limit is 20 MB in total.
const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;

fn attachments_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.canonicalize().map_err(|e| e.to_string())
}

/// Keeps a file name readable but safe as a single path component.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    let base = if trimmed.is_empty() { "file" } else { trimmed };
    base.chars().take(120).collect()
}

fn unique_dir_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}-{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Resolves `path` and refuses anything outside the attachments folder.
fn inside_root(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = attachments_root(app)?;
    let resolved = Path::new(path).canonicalize().map_err(|_| "attachment no longer exists".to_string())?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err("path is outside E.V's attachments folder".into())
    }
}

/// Stores an attached file (raw IPC body, name in `x-name`) and returns its absolute path.
#[tauri::command]
pub async fn attachment_save(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file body".into());
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file is larger than {} MB", MAX_FILE_BYTES / 1024 / 1024));
    }
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "file".into());
    let dir = attachments_root(&app)?.join(unique_dir_name());
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(sanitize(&name));
    tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Returns a stored attachment's bytes, for providers that take files inline.
#[tauri::command]
pub async fn attachment_read(app: AppHandle, path: String) -> Result<Response, String> {
    let resolved = inside_root(&app, &path)?;
    let bytes = tokio::fs::read(resolved).await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Reads a file the user dragged in from Finder, so it can be attached. Folders are refused.
#[tauri::command]
pub async fn read_dropped_file(path: String) -> Result<Response, String> {
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("folders can't be attached — drop the files inside it".into());
    }
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(format!("file is larger than {} MB", MAX_FILE_BYTES / 1024 / 1024));
    }
    tokio::fs::read(&path).await.map(Response::new).map_err(|e| e.to_string())
}

/// Opens a stored attachment in its default macOS app.
#[tauri::command]
pub async fn attachment_open(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = inside_root(&app, &path)?;
    tokio::process::Command::new("/usr/bin/open")
        .arg(resolved)
        .status()
        .await
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("open exited with {s}")) })
}

/// Deletes stored attachments (and their per-file folders) when a chat is deleted.
#[tauri::command]
pub async fn attachment_delete(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let root = attachments_root(&app)?;
    for path in paths {
        let Ok(resolved) = inside_root(&app, &path) else { continue };
        let _ = tokio::fs::remove_file(&resolved).await;
        if let Some(parent) = resolved.parent().filter(|p| *p != root && p.starts_with(&root)) {
            let _ = tokio::fs::remove_dir(parent).await;
        }
    }
    Ok(())
}

/// The folder attachments live in, so the Claude CLI can be granted read access to it.
#[tauri::command]
pub fn attachment_root(app: AppHandle) -> Result<String, String> {
    attachments_root(&app).map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize("photo 1.png"), "photo 1.png");
        assert_eq!(sanitize("  "), "file");
        assert_eq!(sanitize(".hidden"), "hidden");
    }
}
