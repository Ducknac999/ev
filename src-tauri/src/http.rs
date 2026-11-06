use crate::tasks::TaskRegistry;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub request_id: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// `status` is the upstream HTTP status, or 0 for transport/abort failures. `headers` carries the
/// upstream response headers (lower-cased) so the frontend can read rate-limit and retry hints.
#[derive(Serialize)]
pub struct ProviderError {
    pub status: u16,
    pub message: String,
    pub headers: HashMap<String, String>,
}

impl ProviderError {
    fn transport(message: impl Into<String>) -> Self {
        Self { status: 0, message: message.into(), headers: HashMap::new() }
    }
}

/// Response headers of a successful stream, resolved once the body has been fully forwarded.
#[derive(Serialize)]
pub struct ProviderResponse {
    pub headers: HashMap<String, String>,
}

fn header_map(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| Some((name.as_str().to_ascii_lowercase(), value.to_str().ok()?.to_string())))
        .collect()
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("failed to build HTTP client")
    })
}

/// POSTs to a provider endpoint and streams the response body to the frontend as UTF-8 text.
/// Non-2xx responses resolve to a `ProviderError` carrying the status so the key-rotation
/// engine can react to rate limits before any body is streamed.
#[tauri::command]
pub async fn provider_stream(
    request: ProviderRequest,
    on_chunk: Channel<String>,
    registry: State<'_, TaskRegistry>,
) -> Result<ProviderResponse, ProviderError> {
    let ProviderRequest { request_id, url, headers, body } = request;

    let task = tokio::spawn(async move {
        let mut builder = client().post(&url).body(body);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        let response = builder.send().await.map_err(|e| ProviderError::transport(e.to_string()))?;
        let status = response.status();
        let headers = header_map(response.headers());
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(ProviderError { status: status.as_u16(), message, headers });
        }

        let mut stream = response.bytes_stream();
        let mut pending: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ProviderError::transport(e.to_string()))?;
            pending.extend_from_slice(&chunk);
            // Only forward complete UTF-8 sequences; keep a split multi-byte tail for the next chunk.
            let valid_up_to = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid_up_to > 0 {
                let text = String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                pending.drain(..valid_up_to);
                if on_chunk.send(text).is_err() {
                    return Err(ProviderError::transport("receiver closed"));
                }
            }
        }
        if !pending.is_empty() {
            let _ = on_chunk.send(String::from_utf8_lossy(&pending).into_owned());
        }
        Ok(ProviderResponse { headers })
    });

    registry.insert(&request_id, task.abort_handle());
    let outcome = task.await;
    registry.remove(&request_id);

    match outcome {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err(ProviderError::transport("aborted")),
        Err(e) => Err(ProviderError::transport(e.to_string())),
    }
}

#[tauri::command]
pub fn provider_cancel(request_id: String, registry: State<'_, TaskRegistry>) -> bool {
    registry.abort(&request_id)
}


/// DeepSeek's account balance (free to ask; uses no tokens): what's left, in the account's currency.
/// E.V reads it to show what a day of use actually cost.
#[derive(Serialize)]
pub struct Balance {
    pub amount: f64,
    pub currency: String,
}

#[tauri::command]
pub async fn deepseek_balance(key: String) -> Result<Balance, String> {
    let response = client()
        .get("https://api.deepseek.com/user/balance")
        .bearer_auth(key.trim())
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body["error"]["message"].as_str().unwrap_or("balance unavailable")));
    }
    let info = body["balance_infos"].as_array().and_then(|list| list.iter().find(|b| b["currency"] == "USD").or_else(|| list.first())).ok_or("no balance in the reply")?;
    let amount = info["total_balance"].as_str().and_then(|v| v.parse::<f64>().ok()).or_else(|| info["total_balance"].as_f64()).ok_or("unreadable balance")?;
    Ok(Balance { amount, currency: info["currency"].as_str().unwrap_or("USD").to_string() })
}
