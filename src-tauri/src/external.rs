/// Opens an http(s) URL in the user's default browser.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    tokio::process::Command::new("/usr/bin/open")
        .arg(&url)
        .status()
        .await
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("open exited with {s}")) })
}
