//! What's making sound on the Mac right now, so E.V doesn't talk over music or a video.
//! Core Audio lists every process sending audio to an output (macOS 14.2+); E.V's own
//! processes (its web view plays E.V's voice) don't count.

use std::ffi::c_void;

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32) -> i32;
    fn AudioObjectGetPropertyData(object: u32, address: *const Address, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
}

const fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

const SYSTEM_OBJECT: u32 = 1;
const GLOBAL: u32 = code(b"glob");
const PROCESS_LIST: u32 = code(b"prs#");
const PROCESS_PID: u32 = code(b"ppid");
const RUNNING_OUTPUT: u32 = code(b"piro");

fn property<T: Default + Copy>(object: u32, selector: u32) -> Option<T> {
    let address = Address { selector, scope: GLOBAL, element: 0 };
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(object, &address, 0, std::ptr::null(), &mut size, &mut value as *mut T as *mut c_void) };
    (status == 0).then_some(value)
}

fn processes() -> Vec<u32> {
    let address = Address { selector: PROCESS_LIST, scope: GLOBAL, element: 0 };
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size) } != 0 || size == 0 {
        return Vec::new();
    }
    let mut ids = vec![0u32; size as usize / 4];
    let status = unsafe { AudioObjectGetPropertyData(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / 4);
    ids
}

/// The app responsible for a helper process (a web view's audio process belongs to its app).
fn responsible(pid: i32) -> i32 {
    type Responsible = unsafe extern "C" fn(i32) -> i32;
    static FN: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let f = *FN.get_or_init(|| unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) as usize });
    if f == 0 {
        return pid;
    }
    let owner = unsafe { std::mem::transmute::<usize, Responsible>(f)(pid) };
    if owner > 0 { owner } else { pid }
}

fn app_name(pid: i32) -> String {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let Some(class) = AnyClass::get(c"NSRunningApplication") else { return String::new() };
        let app: *mut AnyObject = msg_send![class, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return String::new();
        }
        let name: *mut AnyObject = msg_send![app, localizedName];
        if name.is_null() {
            return String::new();
        }
        let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
        if utf8.is_null() { String::new() } else { std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned() }
    }
}

/// Names of the apps playing sound right now, E.V itself left out.
#[tauri::command]
pub fn audio_playing() -> Vec<String> {
    let own = std::process::id() as i32;
    let mut names: Vec<String> = processes()
        .into_iter()
        .filter(|&object| property::<u32>(object, RUNNING_OUTPUT).unwrap_or(0) != 0)
        .filter_map(|object| property::<i32>(object, PROCESS_PID))
        .map(responsible)
        .filter(|&pid| pid != own)
        .map(app_name)
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}
