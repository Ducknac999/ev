use std::io::Write;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "settings.json";

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE_NAME))
}

/// Returns the raw settings JSON, or `null` when nothing has been saved yet.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

/// Persists settings (including API keys) atomically with owner-only permissions.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    let path = settings_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
