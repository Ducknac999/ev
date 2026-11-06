//! Reminders mirrored into the Mac's Calendar (helpers/calendarlib.swift, EventKit), so macOS
//! rings them even when E.V is closed or updating.

type CalendarFn = unsafe extern "C" fn(*const std::ffi::c_char) -> *mut std::ffi::c_char;
type FreeFn = unsafe extern "C" fn(*mut std::ffi::c_char);

fn lib() -> Option<(CalendarFn, FreeFn)> {
    static LIB: std::sync::OnceLock<Option<(usize, usize)>> = std::sync::OnceLock::new();
    let (call, free) = (*LIB.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let path = exe.parent()?.join("../Resources/libgideoncapture.dylib");
        let c_path = std::ffi::CString::new(path.display().to_string()).ok()?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return None;
        }
        let call = unsafe { libc::dlsym(handle, c"gideon_calendar".as_ptr()) };
        let free = unsafe { libc::dlsym(handle, c"gideon_free_string".as_ptr()) };
        (!call.is_null() && !free.is_null()).then_some((call as usize, free as usize))
    }))?;
    Some(unsafe { (std::mem::transmute::<usize, CalendarFn>(call), std::mem::transmute::<usize, FreeFn>(free)) })
}

/// Adds or replaces (action "upsert") or removes (action "delete") one E.V reminder in Calendar.
#[tauri::command]
pub async fn calendar_sync(request: serde_json::Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (call, free) = lib().ok_or("the calendar helper isn't available")?;
        let input = std::ffi::CString::new(request.to_string()).map_err(|e| e.to_string())?;
        let raw = unsafe { call(input.as_ptr()) };
        if raw.is_null() {
            return Err("no answer from Calendar".into());
        }
        let text = unsafe { std::ffi::CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { free(raw) };
        let reply: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if reply["ok"] == true {
            Ok(())
        } else {
            Err(reply["error"].as_str().unwrap_or("Calendar didn't save it").to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
