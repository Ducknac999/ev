use std::collections::HashMap;
use std::sync::Mutex;
use tokio::task::AbortHandle;

/// Tracks cancellable background work (CLI processes, HTTP streams) by caller-supplied id.
#[derive(Default)]
pub struct TaskRegistry {
    handles: Mutex<HashMap<String, AbortHandle>>,
}

impl TaskRegistry {
    pub fn insert(&self, id: &str, handle: AbortHandle) {
        if let Some(previous) = self.handles.lock().unwrap().insert(id.to_string(), handle) {
            previous.abort();
        }
    }

    pub fn remove(&self, id: &str) {
        self.handles.lock().unwrap().remove(id);
    }

    pub fn abort(&self, id: &str) -> bool {
        match self.handles.lock().unwrap().remove(id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }
}
