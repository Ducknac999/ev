//! Synced lyrics for the notch's music card, from LRCLIB (lrclib.net: free, no key). Saved on
//! the Mac for the last 100 songs only (a few KB each, ~0.5 MB in all), or not at all.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const KEEP: usize = 100;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct Lyrics {
    /// "[mm:ss.xx] line" per line; empty when only plain lyrics exist.
    pub synced: String,
    pub plain: String,
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("lyrics");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn key(artist: &str, title: &str) -> String {
    let raw = format!("{}\u{1f}{}", artist.to_lowercase().trim(), title.to_lowercase().trim());
    // FNV-1a: a stable file name, no crate needed.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in raw.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.json")
}

/// "Seasick (Official Music Video)" → "Seasick".
fn clean_title(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    let mut bracket = String::new();
    for c in title.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                bracket.clear();
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                let b = bracket.to_lowercase();
                if !["official", "video", "audio", "lyric", "visualizer", "remaster", "hd", "4k", "mv"].iter().any(|w| b.contains(w)) {
                    out.push_str(&format!("({bracket})"));
                }
            }
            _ if depth > 0 => bracket.push(c),
            _ => out.push(c),
        }
    }
    out.split(" - Topic").next().unwrap_or(&out).trim().to_string()
}

/// Keeps the newest `KEEP` saved songs.
fn trim(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= KEEP {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(path);
    }
}

fn pick(value: &serde_json::Value) -> Option<Lyrics> {
    let synced = value.get("syncedLyrics").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let plain = value.get("plainLyrics").and_then(|v| v.as_str()).unwrap_or("").to_string();
    (!synced.is_empty() || !plain.is_empty()).then_some(Lyrics { synced, plain })
}

async fn fetch(artist: &str, title: &str, album: &str, duration: f64) -> Option<Lyrics> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .user_agent("E.V (https://github.com/Ducknac999/ev)")
        .build()
        .ok()?;
    if !artist.is_empty() {
        let mut query = vec![("track_name", title.to_string()), ("artist_name", artist.to_string())];
        if !album.is_empty() {
            query.push(("album_name", album.to_string()));
        }
        if duration > 0.0 {
            query.push(("duration", format!("{}", duration.round() as i64)));
        }
        if let Ok(response) = client.get("https://lrclib.net/api/get").query(&query).send().await {
            if response.status().is_success() {
                if let Some(found) = response.json::<serde_json::Value>().await.ok().as_ref().and_then(pick) {
                    return Some(found);
                }
            }
        }
    }
    let search = if artist.is_empty() { vec![("q", title.to_string())] } else { vec![("track_name", title.to_string()), ("artist_name", artist.to_string())] };
    let list: Vec<serde_json::Value> = client.get("https://lrclib.net/api/search").query(&search).send().await.ok()?.json().await.ok()?;
    // Prefer synced lyrics with a matching length.
    let close = |v: &&serde_json::Value| duration <= 0.0 || v.get("duration").and_then(|d| d.as_f64()).map(|d| (d - duration).abs() < 4.0).unwrap_or(true);
    list.iter().filter(close).find(|v| v.get("syncedLyrics").and_then(|s| s.as_str()).is_some_and(|s| !s.is_empty())).or_else(|| list.iter().find(close)).and_then(pick)
}

/// Lyrics for a song: the saved copy, else LRCLIB (saved when `save`). None when there are none.
#[tauri::command]
pub async fn lyrics(app: AppHandle, artist: String, title: String, album: Option<String>, duration: Option<f64>, save: bool) -> Option<Lyrics> {
    let title = clean_title(&title);
    if title.is_empty() {
        return None;
    }
    let dir = dir(&app);
    let file = dir.as_ref().map(|d| d.join(key(&artist, &title)));
    if let Some(found) = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Lyrics>(&t).ok()) {
        if let Some(f) = &file {
            // Played again: counts as recent.
            let _ = std::fs::File::options().append(true).open(f).and_then(|h| h.set_modified(std::time::SystemTime::now()));
        }
        return Some(found);
    }
    let found = fetch(artist.trim(), &title, album.as_deref().unwrap_or("").trim(), duration.unwrap_or(0.0)).await?;
    if save {
        if let (Some(dir), Some(file)) = (dir, file) {
            let _ = std::fs::write(&file, serde_json::to_string(&found).unwrap_or_default());
            trim(&dir);
        }
    }
    Some(found)
}

/// "Save lyrics: never" — removes the saved ones.
#[tauri::command]
pub fn lyrics_clear(app: AppHandle) {
    if let Some(dir) = dir(&app) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_video_titles() {
        assert_eq!(clean_title("Seasick (Official Music Video)"), "Seasick");
        assert_eq!(clean_title("Crush [Lyric Video]"), "Crush");
        assert_eq!(clean_title("Hello (feat. Someone)"), "Hello (feat. Someone)");
    }
}
