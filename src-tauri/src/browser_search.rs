//! Web search through a hidden browser window. Google and Brave refuse plain HTTP scrapers, and
//! Bing's answer boxes (weather, sports times in local time, …) only render in a real browser.
//! The hidden window gets no E.V permissions; an injected script reads the results page and
//! hands it back by navigating to a `gideon-search:` URL, which is intercepted and never loaded.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const BROWSER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long an engine that showed a robot check is skipped before trying it again.
const BLOCK_COOLDOWN_SECS: u64 = 30 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Google,
    Bing,
    Brave,
}

impl Engine {
    pub const ORDER: [Engine; 3] = [Engine::Google, Engine::Bing, Engine::Brave];

    pub fn name(self) -> &'static str {
        match self {
            Engine::Google => "Google",
            Engine::Bing => "Bing",
            Engine::Brave => "Brave",
        }
    }

    fn url(self, query: &str) -> String {
        let q = encode_query(query);
        match self {
            Engine::Google => format!("https://www.google.com/search?q={q}&hl=en&gl=us"),
            Engine::Bing => format!("https://www.bing.com/search?q={q}&setlang=en&cc=US"),
            Engine::Brave => format!("https://search.brave.com/search?q={q}&source=web"),
        }
    }

    fn blocked_until(self) -> &'static AtomicU64 {
        static GOOGLE: AtomicU64 = AtomicU64::new(0);
        static BING: AtomicU64 = AtomicU64::new(0);
        static BRAVE: AtomicU64 = AtomicU64::new(0);
        match self {
            Engine::Google => &GOOGLE,
            Engine::Bing => &BING,
            Engine::Brave => &BRAVE,
        }
    }

    pub fn is_cooling_down(self) -> bool {
        now_secs() < self.blocked_until().load(Ordering::Relaxed)
    }

    fn mark_blocked(self) {
        self.blocked_until().store(now_secs() + BLOCK_COOLDOWN_SECS, Ordering::Relaxed);
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn encode_query(query: &str) -> String {
    query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct PageHit {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub snippet: String,
}

#[derive(Deserialize, Debug)]
struct PageReport {
    blocked: bool,
    #[serde(default)]
    overview: String,
    #[serde(default)]
    results: Vec<PageHit>,
}

pub struct EngineResult {
    pub engine: Engine,
    /// Top of the results page: answer boxes such as weather, scores and race times.
    pub overview: String,
    pub results: Vec<PageHit>,
}

/// Runs in the hidden window after the results page loads.
const EXTRACT_JS: &str = r##"
(() => {
  if (window.__gideonSearch) return;
  window.__gideonSearch = true;
  // Collapses whitespace and the digit columns of animated number tickers ("9 8 7 … 0").
  const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/(?:9 8 7 6 5 4 3 2 1 0 ?)+/g, "").trim();
  const send = (report) => {
    location.href = "gideon-search://result?d=" + encodeURIComponent(JSON.stringify(report));
  };
  const run = () => {
    const host = location.hostname;
    const body = document.body ? document.body.innerText : "";
    const blocked =
      location.pathname.startsWith("/sorry") ||
      /unusual traffic|not a robot|verify you.?re (a )?human|verifying you.?re not a bot|captcha|enablejs/i.test(body.slice(0, 4000));
    let container = document.body;
    let links = [];
    if (host.includes("google.")) {
      container = document.querySelector("#rcnt") || document.querySelector("#center_col") || document.body;
      links = [...document.querySelectorAll("#search a:has(h3)")].map((a) => {
        const box = a.closest("div[data-hveid], div.g") || a.parentElement;
        const title = clean(a.querySelector("h3")?.innerText);
        return { title, url: a.href, snippet: clean((box?.innerText || "").replace(title, "")).slice(0, 400) };
      });
    } else if (host.includes("bing.")) {
      container = document.querySelector("#b_results") || document.body;
      links = [...document.querySelectorAll("li.b_algo")].map((li) => {
        const a = li.querySelector("h2 a");
        return { title: clean(a?.innerText), url: a?.href || "", snippet: clean(li.querySelector("p, .b_caption")?.innerText).slice(0, 400) };
      });
    } else {
      container = document.querySelector("#results") || document.querySelector("main") || document.body;
      links = [...container.querySelectorAll("a[href^='http']")]
        .filter((a) => a.querySelector(".title, h2, h3") && !a.href.includes("brave.com"))
        .map((a) => {
          const box = a.closest(".snippet") || a.parentElement;
          return { title: clean(a.querySelector(".title, h2, h3")?.innerText), url: a.href, snippet: clean(box?.querySelector(".snippet-description, .content, p")?.innerText).slice(0, 400) };
        });
    }
    const seen = new Set();
    const results = links.filter((l) => l.title && /^https?:/.test(l.url) && !seen.has(l.url) && seen.add(l.url)).slice(0, 8);
    send({ blocked, overview: clean(container.innerText).slice(0, 3500), results });
  };
  const start = () => setTimeout(run, 1200);
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
"##;

fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

/// Loads one engine's results page in a hidden window and reads it.
async fn load_engine(app: &AppHandle, engine: Engine, query: &str) -> Result<EngineResult, String> {
    let label = format!("search-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let (tx, rx) = oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let url: Url = engine.url(query).parse().map_err(|e| format!("bad search URL: {e}"))?;
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("E.V search")
        .visible(false)
        .focused(false)
        .inner_size(1280.0, 900.0)
        .user_agent(BROWSER_AGENT)
        .initialization_script(EXTRACT_JS)
        .on_navigation(move |target| {
            if target.scheme() != "gideon-search" {
                return true;
            }
            if let (Some(data), Some(sender)) = (query_param(target, "d"), tx.lock().unwrap().take()) {
                let _ = sender.send(data);
            }
            false
        })
        .build()
        .map_err(|e| format!("could not open the search browser: {e}"))?;

    let outcome = tokio::time::timeout(PAGE_TIMEOUT, rx).await;
    let _ = window.destroy();
    let raw = outcome
        .map_err(|_| format!("{} did not answer in time", engine.name()))?
        .map_err(|_| format!("{} search was interrupted", engine.name()))?;
    let report: PageReport = serde_json::from_str(&raw).map_err(|e| format!("could not read {} results: {e}", engine.name()))?;
    if report.blocked {
        engine.mark_blocked();
        return Err(format!("{} asked for a robot check", engine.name()));
    }
    if report.results.is_empty() && report.overview.len() < 40 {
        return Err(format!("{} returned no results", engine.name()));
    }
    let results = resolve_links(report.results).await;
    Ok(EngineResult { engine, overview: report.overview, results })
}

/// Google hides result addresses behind `/goto?url=…` redirects; follow one hop of each (in
/// parallel) so the agent gets the real page address.
async fn resolve_links(hits: Vec<PageHit>) -> Vec<PageHit> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(BROWSER_AGENT)
        .timeout(Duration::from_secs(5))
        .build();
    let Ok(client) = client else { return hits };
    let resolved = hits.into_iter().map(|hit| {
        let client = client.clone();
        async move {
            let url = crate::agent_tools::clean_result_url(&hit.url);
            if !(url.contains("google.") && url.contains("/goto?")) {
                return PageHit { url, ..hit };
            }
            let target = client
                .get(&url)
                .send()
                .await
                .ok()
                .and_then(|r| r.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string))
                .filter(|l| l.starts_with("http"));
            PageHit { url: target.unwrap_or(url), ..hit }
        }
    });
    futures_util::future::join_all(resolved).await
}

/// Google first, then Bing, then Brave; engines that recently showed a robot check are skipped.
pub async fn search(app: &AppHandle, query: &str) -> Result<EngineResult, String> {
    let mut failures = Vec::new();
    for engine in Engine::ORDER {
        if engine.is_cooling_down() {
            failures.push(format!("{} skipped (robot check earlier)", engine.name()));
            continue;
        }
        match load_engine(app, engine, query).await {
            Ok(result) => return Ok(result),
            Err(e) => failures.push(e),
        }
    }
    Err(failures.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_search_urls() {
        assert_eq!(Engine::Bing.url("f1 race & time"), "https://www.bing.com/search?q=f1+race+%26+time&setlang=en&cc=US");
        assert!(Engine::Google.url("weather").starts_with("https://www.google.com/search?q=weather"));
    }

    #[test]
    fn cooldown_skips_blocked_engines() {
        assert!(!Engine::Brave.is_cooling_down());
        Engine::Brave.mark_blocked();
        assert!(Engine::Brave.is_cooling_down());
    }
}
