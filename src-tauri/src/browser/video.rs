//! What a video says, in one step: its title, channel, length, description, chapters and spoken
//! words (subtitles). yt-dlp is used when it's on the Mac (it handles YouTube and most video
//! sites); without it, YouTube's own caption list is read from the watch page. The full words are
//! saved to a file so the AI only carries the parts it needs.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoFacts {
    pub url: String,
    pub title: String,
    pub channel: String,
    pub seconds: u64,
    pub description: String,
    pub chapters: Vec<String>,
    /// The spoken words, one line per caption, repeats removed.
    pub transcript: String,
    /// Where the full words were saved.
    pub file: String,
    /// yt-dlp · youtube · none
    pub source: String,
    /// Why there are no words, when there aren't.
    pub note: String,
}

fn yt_dlp() -> Option<PathBuf> {
    let home = crate::shell_env::home_dir();
    let fixed = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"].map(PathBuf::from);
    fixed.into_iter().chain([home.join(".local/bin/yt-dlp"), home.join("bin/yt-dlp")]).find(|p| p.exists())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
        .build()
        .unwrap_or_default()
}

/// json3 captions → lines; VTT → lines. Rolling auto-captions repeat each line, so repeats go.
/// When the captions carry times, a "[m:ss]" line marks every 20 seconds, so a moment can be
/// found again (video_frames takes those times).
pub fn caption_lines(body: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut last_text = String::new();
    let mut last_mark: Option<u64> = None;
    let mut push = |text: &str, at: Option<u64>| {
        let t = text.replace('\n', " ").split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() || last_text == t || last_text.ends_with(&t) {
            return;
        }
        if let Some(seconds) = at {
            if last_mark.is_none_or(|m| seconds >= m + 20) {
                lines.push(format!("[{}]", clock(seconds)));
                last_mark = Some(seconds);
            }
        }
        last_text = t.clone();
        lines.push(t);
    };
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        for event in v.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default() {
            let text: String = event.get("segs").and_then(|s| s.as_array()).map(|segs| segs.iter().filter_map(|s| s.get("utf8").and_then(|u| u.as_str())).collect()).unwrap_or_default();
            push(&text, event.get("tStartMs").and_then(|t| t.as_u64()).map(|ms| ms / 1000));
        }
        return lines;
    }
    let tag = regex_lite_strip;
    let mut at: Option<u64> = None;
    for raw in body.lines() {
        let l = raw.trim();
        if l.contains("-->") {
            at = l.split("-->").next().and_then(|start| seconds_of(start.trim().split('.').next().unwrap_or("")));
            continue;
        }
        if l.is_empty() || l == "WEBVTT" || l.starts_with("Kind:") || l.starts_with("Language:") || l.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        push(&tag(l), at);
    }
    lines
}

/// "1:23", "01:02:03", "83" or "83.5" → seconds.
pub fn seconds_of(text: &str) -> Option<u64> {
    let text = text.trim().trim_start_matches('[').trim_end_matches(']');
    if text.is_empty() {
        return None;
    }
    let mut total = 0f64;
    for part in text.split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    (total >= 0.0).then_some(total as u64)
}

/// Drops <c>…</c> and <00:00:01.000> timing tags from a VTT line.
fn regex_lite_strip(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth = 0;
    for ch in line.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&gt;", ">").replace("&lt;", "<").replace("&#39;", "'").replace("&quot;", "\"")
}

/// The best English (or original-language) caption track from yt-dlp's or YouTube's list.
fn pick_track(tracks: &[(String, String, bool)]) -> Option<String> {
    // (language, url, made by a person)
    let by = |pred: &dyn Fn(&(String, String, bool)) -> bool| tracks.iter().find(|t| pred(t)).map(|t| t.1.clone());
    by(&|t| t.2 && t.0.starts_with("en"))
        .or_else(|| by(&|t| t.0 == "en-orig"))
        .or_else(|| by(&|t| t.0.starts_with("en")))
        .or_else(|| by(&|t| t.2))
        .or_else(|| tracks.first().map(|t| t.1.clone()))
}

fn json3(url: &str) -> String {
    let base = url.split("&fmt=").next().unwrap_or(url);
    format!("{base}&fmt=json3")
}

async fn with_yt_dlp(exe: PathBuf, url: &str, facts: &mut VideoFacts) -> Result<(), String> {
    let out = tokio::time::timeout(Duration::from_secs(60), tokio::process::Command::new(exe).args(["--skip-download", "--no-warnings", "--no-playlist", "--dump-single-json", url]).output())
        .await
        .map_err(|_| "yt-dlp took too long".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("yt-dlp failed").to_string());
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    facts.title = s("title");
    facts.channel = if s("channel").is_empty() { s("uploader") } else { s("channel") };
    facts.seconds = v.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0) as u64;
    facts.description = s("description");
    facts.chapters = v
        .get("chapters")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().map(|c| format!("{} {}", clock(c.get("start_time").and_then(|t| t.as_f64()).unwrap_or(0.0) as u64), c.get("title").and_then(|t| t.as_str()).unwrap_or_default())).collect())
        .unwrap_or_default();
    let mut tracks = Vec::new();
    for (key, human) in [("subtitles", true), ("automatic_captions", false)] {
        if let Some(map) = v.get(key).and_then(|m| m.as_object()) {
            for (lang, list) in map {
                let url = list.as_array().and_then(|l| l.iter().find(|f| f.get("ext").and_then(|e| e.as_str()) == Some("json3")).or_else(|| l.first())).and_then(|f| f.get("url")).and_then(|u| u.as_str());
                if let Some(u) = url {
                    tracks.push((lang.clone(), u.to_string(), human));
                }
            }
        }
    }
    if let Some(track) = pick_track(&tracks) {
        let body = client().get(json3(&track)).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        facts.transcript = caption_lines(&body).join("\n");
    } else {
        facts.note = "The video has no subtitles or automatic captions.".into();
    }
    facts.source = "yt-dlp".into();
    Ok(())
}

/// YouTube's own page: player data has the title, description and caption tracks.
async fn with_youtube_page(url: &str, facts: &mut VideoFacts) -> Result<(), String> {
    let html = client().get(url).header("Accept-Language", "en-US,en;q=0.9").send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let start = html.find("ytInitialPlayerResponse = ").ok_or("couldn't read the video page")? + "ytInitialPlayerResponse = ".len();
    // The player data is one JSON object followed by more script: read just that object.
    let v: Value = serde_json::Deserializer::from_str(&html[start..]).into_iter::<Value>().next().ok_or("couldn't read the video page")?.map_err(|e| e.to_string())?;
    let details = v.get("videoDetails").cloned().unwrap_or(Value::Null);
    let s = |k: &str| details.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    facts.title = s("title");
    facts.channel = s("author");
    facts.seconds = s("lengthSeconds").parse().unwrap_or(0);
    facts.description = s("shortDescription");
    let tracks: Vec<(String, String, bool)> = v
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| Some((t.get("languageCode")?.as_str()?.to_string(), t.get("baseUrl")?.as_str()?.to_string(), t.get("kind").and_then(|k| k.as_str()) != Some("asr"))))
                .collect()
        })
        .unwrap_or_default();
    if let Some(track) = pick_track(&tracks) {
        let body = client().get(json3(&track)).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        facts.transcript = caption_lines(&body).join("\n");
    }
    if facts.transcript.is_empty() {
        facts.note = "YouTube didn't hand over the captions. Installing yt-dlp (brew install yt-dlp) lets E.V read them.".into();
    }
    facts.source = "youtube".into();
    Ok(())
}

fn clock(seconds: u64) -> String {
    if seconds >= 3600 {
        format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
    } else {
        format!("{}:{:02}", seconds / 60, seconds % 60)
    }
}

#[tauri::command]
pub async fn video_facts(app: tauri::AppHandle, url: String) -> Result<VideoFacts, String> {
    use tauri::Manager;
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("give the video's web address".into());
    }
    let mut facts = VideoFacts { url: url.clone(), ..Default::default() };
    let mut tried = Vec::new();
    if let Some(exe) = yt_dlp() {
        match with_yt_dlp(exe, &url, &mut facts).await {
            Ok(()) => {}
            Err(e) => tried.push(format!("yt-dlp: {e}")),
        }
    }
    let youtube = url.contains("youtube.com/") || url.contains("youtu.be/");
    if facts.source.is_empty() && youtube {
        if let Err(e) = with_youtube_page(&url, &mut facts).await {
            tried.push(format!("YouTube page: {e}"));
        }
    }
    if facts.source.is_empty() {
        return Err(if tried.is_empty() { "this isn't a YouTube video and yt-dlp isn't installed (brew install yt-dlp reads most video sites)".into() } else { tried.join("; ") });
    }
    if !facts.transcript.is_empty() {
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("videos");
        let _ = std::fs::create_dir_all(&dir);
        let name: String = facts.title.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>().split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
        let file = dir.join(format!("{}.txt", if name.is_empty() { "video".into() } else { name.chars().take(60).collect::<String>() }));
        if std::fs::write(&file, &facts.transcript).is_ok() {
            facts.file = file.display().to_string();
        }
    }
    Ok(facts)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrame {
    /// "m:ss" in the video.
    pub at: String,
    /// JPEG, base64.
    pub image: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrames {
    pub seconds: u64,
    pub frames: Vec<VideoFrame>,
    /// Times that couldn't be read, with why.
    pub failed: Vec<String>,
}

fn ffmpeg() -> Option<PathBuf> {
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].map(PathBuf::from).into_iter().find(|p| p.exists())
}

/// Pictures from a video at the given times (or spread evenly over it), for what it only shows on
/// screen. yt-dlp finds the video stream; ffmpeg reads one frame per time straight from it, so
/// nothing is downloaded in full.
#[tauri::command]
pub async fn video_frames(url: String, at: Option<Vec<String>>, count: Option<u32>) -> Result<VideoFrames, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("give the video's web address".into());
    }
    let exe = yt_dlp().ok_or("reading pictures from a video needs yt-dlp (brew install yt-dlp)")?;
    let ff = ffmpeg().ok_or("reading pictures from a video needs ffmpeg (brew install ffmpeg)")?;
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(exe)
            .args(["--no-playlist", "--no-warnings", "-f", "bv*[height<=720][vcodec!=none]/b[height<=720]/b", "--print", "duration", "--print", "urls", &url])
            .output(),
    )
    .await
    .map_err(|_| "yt-dlp took too long".to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("yt-dlp failed").to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let seconds = lines.next().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    let stream = lines.find(|l| l.starts_with("http")).ok_or("yt-dlp didn't find the video stream")?.to_string();
    let mut times: Vec<u64> = at.unwrap_or_default().iter().filter_map(|t| seconds_of(t)).collect();
    if times.is_empty() {
        let n = count.unwrap_or(6).clamp(1, 10) as u64;
        let span = seconds.max(1);
        times = (0..n).map(|i| span * (2 * i + 1) / (2 * n)).collect();
    }
    times.retain(|t| seconds == 0 || *t < seconds);
    times.dedup();
    times.truncate(10);
    let mut result = VideoFrames { seconds, ..Default::default() };
    for t in times {
        let run = tokio::process::Command::new(&ff)
            .args(["-hide_banner", "-loglevel", "error", "-ss", &t.to_string(), "-i", &stream, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"])
            .output();
        match tokio::time::timeout(Duration::from_secs(30), run).await {
            Ok(Ok(o)) if o.status.success() && !o.stdout.is_empty() => result.frames.push(VideoFrame { at: clock(t), image: crate::mac_control::base64_encode(&o.stdout) }),
            Ok(Ok(o)) => result.failed.push(format!("{}: {}", clock(t), String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("no picture"))),
            Ok(Err(e)) => result.failed.push(format!("{}: {e}", clock(t))),
            Err(_) => result.failed.push(format!("{}: timed out", clock(t))),
        }
    }
    if result.frames.is_empty() {
        return Err(format!("no pictures came out of the video ({})", result.failed.join("; ")));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_captions_lose_their_repeats() {
        let vtt = "WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:02.000\nhello <00:00:01.500><c>there</c>\n\n00:00:02.000 --> 00:00:03.000\nhello there\n\n00:00:03.000 --> 00:00:04.000\nopen the settings\n";
        assert_eq!(caption_lines(vtt), vec!["[0:01]", "hello there", "open the settings"]);
        let json = r#"{"events":[{"segs":[{"utf8":"go to "},{"utf8":"options"}]},{"segs":[{"utf8":"\n"}]},{"segs":[{"utf8":"go to options"}]}]}"#;
        assert_eq!(caption_lines(json), vec!["go to options"]);
    }

    #[test]
    fn reads_times() {
        assert_eq!(seconds_of("1:23"), Some(83));
        assert_eq!(seconds_of("01:02:03"), Some(3723));
        assert_eq!(seconds_of("[0:45]"), Some(45));
        assert_eq!(seconds_of("abc"), None);
    }

    #[test]
    fn prefers_english_written_by_a_person() {
        let tracks = vec![("de".into(), "de".into(), true), ("en".into(), "en-auto".into(), false), ("en-US".into(), "en-human".into(), true)];
        assert_eq!(pick_track(&tracks).as_deref(), Some("en-human"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Real network: `cargo test video::live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn reads_a_real_video() {
        let url = "https://www.youtube.com/watch?v=gWFlvHNrnGk";
        let mut a = VideoFacts::default();
        if let Some(exe) = yt_dlp() {
            let t = std::time::Instant::now();
            with_yt_dlp(exe, url, &mut a).await.expect("yt-dlp");
            println!("yt-dlp: {:?} · {} · {}s · {} chapters · {} words · {:?}", a.title, a.channel, a.seconds, a.chapters.len(), a.transcript.split_whitespace().count(), t.elapsed());
            assert!(!a.transcript.is_empty());
        }
        let mut b = VideoFacts::default();
        let t = std::time::Instant::now();
        let page = with_youtube_page(url, &mut b).await;
        println!("page: {page:?} {:?} · {} words · note {:?} · {:?}", b.title, b.transcript.split_whitespace().count(), b.note, t.elapsed());
    }
}
