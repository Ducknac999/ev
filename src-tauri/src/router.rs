//! The instant router (helpers/routerlib.swift): Apple's on-device model decides whether one of
//! E.V's instant actions does the whole request, with no tokens. Loaded into E.V's own process.

type RouteFn = unsafe extern "C" fn(*const std::ffi::c_char) -> *mut std::ffi::c_char;
type FreeFn = unsafe extern "C" fn(*mut std::ffi::c_char);
type WarmFn = unsafe extern "C" fn() -> bool;

fn lib() -> Option<(RouteFn, FreeFn, WarmFn)> {
    static LIB: std::sync::OnceLock<Option<(usize, usize, usize)>> = std::sync::OnceLock::new();
    let (route, free, warm) = (*LIB.get_or_init(|| {
        let path = crate::doc::lib_path()?;
        let c_path = std::ffi::CString::new(path.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return None;
        }
        let route = unsafe { libc::dlsym(handle, c"ev_route".as_ptr()) };
        let free = unsafe { libc::dlsym(handle, c"ev_route_free".as_ptr()) };
        let warm = unsafe { libc::dlsym(handle, c"ev_route_prewarm".as_ptr()) };
        (!route.is_null() && !free.is_null() && !warm.is_null()).then_some((route as usize, free as usize, warm as usize))
    }))?;
    Some(unsafe { (std::mem::transmute::<usize, RouteFn>(route), std::mem::transmute::<usize, FreeFn>(free), std::mem::transmute::<usize, WarmFn>(warm)) })
}

/// `request`: {tools, learned, text}. Returns {available, tool ("none" = the AI), values, ms, reason}.
#[tauri::command]
pub async fn route_request(request: serde_json::Value) -> serde_json::Value {
    tokio::task::spawn_blocking(move || {
        let Some((route, free, _)) = lib() else { return serde_json::json!({ "available": false, "tool": "none", "reason": "router missing" }) };
        let Ok(input) = std::ffi::CString::new(request.to_string()) else { return serde_json::json!({ "available": false, "tool": "none" }) };
        let raw = unsafe { route(input.as_ptr()) };
        if raw.is_null() {
            return serde_json::json!({ "available": false, "tool": "none" });
        }
        let text = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { free(raw) };
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "available": false, "tool": "none" }))
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "available": false, "tool": "none" }))
}

/// Loads the on-device model ahead of the first request. False when this Mac doesn't have it.
#[tauri::command]
pub async fn route_prewarm() -> bool {
    tokio::task::spawn_blocking(|| lib().map(|(_, _, warm)| unsafe { warm() }).unwrap_or(false)).await.unwrap_or(false)
}

#[cfg(test)]
mod bench {
    /// `cargo test --lib router -- --ignored --nocapture`: the router on every phrase in
    /// src/services/routerPhrases.json, with the real on-device model. Prints the score.
    #[test]
    #[ignore]
    fn score() {
        let tools: serde_json::Value = serde_json::from_str(include_str!("../../src/services/routerTools.json")).unwrap();
        let phrases: Vec<(String, String)> = serde_json::from_str(include_str!("../../src/services/routerPhrases.json")).unwrap();
        let (route, free, warm) = super::lib().expect("helper library");
        unsafe { warm() };
        let (mut ok, mut wrong, mut missed, mut ms) = (0, 0, 0, 0u64);
        for (text, want) in &phrases {
            let input = std::ffi::CString::new(serde_json::json!({ "tools": tools, "learned": [], "text": text }).to_string()).unwrap();
            let raw = unsafe { route(input.as_ptr()) };
            let reply: serde_json::Value = serde_json::from_str(&unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy()).unwrap();
            unsafe { free(raw) };
            let got = reply["tool"].as_str().unwrap_or("none");
            ms += reply["ms"].as_u64().unwrap_or(0);
            if got == want {
                ok += 1;
            } else if got != "none" {
                wrong += 1;
                println!("✗ WRONG  {text:?} → {got} {} (want {want})", reply["values"]);
            } else {
                missed += 1;
                println!("✗ to AI  {text:?} (want {want}) {}", reply["reason"]);
            }
        }
        println!("score {ok}/{} · wrong instant actions {wrong} · sent to AI unnecessarily {missed} · avg {} ms", phrases.len(), ms / phrases.len() as u64);
    }
}
