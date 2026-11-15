//! Backups to a folder the user picks: `<folder>/E.V Backups`. No AI, just files.
//!
//! Layout:
//! - `files/<ab>/<sha256>.gz`: every distinct file content, stored once, compressed, and read
//!   back after writing to check it.
//! - `snapshots/<millis>.json.gz`: one per backup, the list of what every file looked like then.
//!   A backup where nothing changed adds no snapshot, only updates `last-checked`.
//! - `deleted-chats/<chat id>.json.gz`: chats that were deleted, kept when the user asked for it.
//! - Files over 4 MB are stored as 4 MB pieces, so a conversation that only grew adds just its
//!   last piece. API keys and the memory key go in only when the user turned that on, locked with
//!   their backup password (PBKDF2 + ChaCha20-Poly1305); the password itself is never stored there.
//!
//! Old snapshots thin out (all from the last day, one a day for a week, one a week for a month)
//! unless "never delete" is on; the newest snapshot and the deleted chats are never removed.

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const ROOT_NAME: &str = "E.V Backups";
const LOCAL_STATE: &str = "local-storage.json";
const DAY_MS: u64 = 86_400_000;
const CHUNK: usize = 4 * 1024 * 1024;
const SECRETS: &str = "secrets.bin";
const SECRETS_MAGIC: &[u8; 4] = b"EVS1";
const PBKDF2_ROUNDS: u32 = 600_000;
const PASSWORD_SERVICE: &str = "E.V Backup Password";

static RUNNING: Mutex<()> = Mutex::new(());
/// The last config the app sent, so quitting can take one more backup.
static CONFIG: Mutex<Option<BackupConfig>> = Mutex::new(None);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub folder: String,
    pub keep_deleted: bool,
    pub keep_forever: bool,
    pub include_agents: bool,
    /// API keys and the memory key, locked with the backup password.
    #[serde(default)]
    pub include_secrets: bool,
    /// 0 = no limit.
    pub limit_mb: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    source: String,
    path: String,
    /// The whole file's SHA-256.
    hash: String,
    size: u64,
    mtime: u64,
    /// Pieces of a big file, in order (absent: stored whole under `hash`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chunks: Option<Vec<String>>,
    /// Locked secrets: what was locked (so unchanged secrets aren't locked again).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plain: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    at: u64,
    app_version: String,
    chats: usize,
    files: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    /// False when nothing had changed since the last backup.
    pub saved: bool,
    pub at: u64,
    pub new_files: usize,
    pub bytes_added: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub at: u64,
    pub app_version: String,
    pub chats: usize,
    pub files: usize,
    /// Holds API keys and the memory key (restoring them needs the backup password).
    pub has_secrets: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedChat {
    pub id: String,
    pub title: String,
    pub deleted_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub root: String,
    pub snapshots: Vec<SnapshotInfo>,
    /// Newest backup or check, whichever is later (0 = never).
    pub last_run: u64,
    pub total_bytes: u64,
    pub deleted_chats: Vec<DeletedChat>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn expand(folder: &str) -> PathBuf {
    match folder.strip_prefix("~/") {
        Some(rest) => crate::shell_env::home_dir().join(rest),
        None => PathBuf::from(folder),
    }
}

/// The backup root for a chosen folder (picking the "E.V Backups" folder itself works too).
fn root_of(folder: &str) -> PathBuf {
    let path = expand(folder.trim_end_matches('/'));
    if path.file_name().is_some_and(|n| n == ROOT_NAME) {
        path
    } else {
        path.join(ROOT_NAME)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn gz(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(bytes).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

fn blob_path(root: &Path, hash: &str) -> PathBuf {
    root.join("files").join(&hash[..2]).join(format!("{hash}.gz"))
}

/// Stores one file's content (once), then reads it back to make sure it matches.
fn store(root: &Path, hash: &str, bytes: &[u8]) -> Result<u64, String> {
    let path = blob_path(root, hash);
    if path.exists() {
        return Ok(0);
    }
    let packed = gz(bytes)?;
    write_synced(&path, &packed)?;
    let check = fs::read(&path).map_err(|e| e.to_string()).and_then(|b| gunzip(&b));
    if !matches!(check, Ok(ref back) if sha(back) == hash) {
        let _ = fs::remove_file(&path);
        return Err(format!("A backup copy didn't read back correctly ({})", path.display()));
    }
    Ok(packed.len() as u64)
}

/// Stores a file whole, or in pieces when it's big. Returns (pieces, bytes added).
fn store_file(root: &Path, hash: &str, bytes: &[u8]) -> Result<(Option<Vec<String>>, u64), String> {
    if bytes.len() <= CHUNK {
        return Ok((None, store(root, hash, bytes)?));
    }
    let mut pieces = Vec::new();
    let mut added = 0;
    for piece in bytes.chunks(CHUNK) {
        let h = sha(piece);
        added += store(root, &h, piece)?;
        pieces.push(h);
    }
    Ok((Some(pieces), added))
}

fn is_stored(root: &Path, entry: &Entry) -> bool {
    match &entry.chunks {
        Some(pieces) => pieces.iter().all(|h| blob_path(root, h).exists()),
        None => blob_path(root, &entry.hash).exists(),
    }
}

/// A file's content from the backup, checked against its hash.
fn load_entry(root: &Path, entry: &Entry) -> Result<Vec<u8>, String> {
    let Some(pieces) = &entry.chunks else { return load_blob(root, &entry.hash) };
    let mut out = Vec::with_capacity(entry.size as usize);
    for h in pieces {
        out.extend(load_blob(root, h)?);
    }
    if sha(&out) != entry.hash {
        return Err("A backup file is damaged.".into());
    }
    Ok(out)
}

fn load_blob(root: &Path, hash: &str) -> Result<Vec<u8>, String> {
    let bytes = gunzip(&fs::read(blob_path(root, hash)).map_err(|e| format!("A backup file is missing: {e}"))?)?;
    if sha(&bytes) != hash {
        return Err("A backup file is damaged.".into());
    }
    Ok(bytes)
}

fn snapshot_ids(root: &Path) -> Vec<u64> {
    let mut ids: Vec<u64> = fs::read_dir(root.join("snapshots"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json.gz")?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

fn snapshot_path(root: &Path, id: u64) -> PathBuf {
    root.join("snapshots").join(format!("{id}.json.gz"))
}

fn read_snapshot(root: &Path, id: u64) -> Result<Snapshot, String> {
    let bytes = gunzip(&fs::read(snapshot_path(root, id)).map_err(|e| e.to_string())?)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn mtime_of(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Every regular file under `dir` (symlinks skipped), as paths relative to `dir`.
fn walk(dir: &Path, rel: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir.join(rel)) else { return };
    for e in rd.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        let child = rel.join(e.file_name());
        if kind.is_dir() {
            walk(dir, &child, out);
        } else if kind.is_file() {
            out.push(child);
        }
    }
}

/// Settings without API keys: keys stay in this Mac's settings file, never in a backup folder.
fn settings_without_keys(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if let Some(providers) = value.get_mut("providers").and_then(|p| p.as_object_mut()) {
        for provider in providers.values_mut() {
            if let Some(obj) = provider.as_object_mut() {
                obj.insert("keys".into(), serde_json::json!([]));
            }
        }
    }
    serde_json::to_vec_pretty(&value).ok()
}

struct Source {
    name: &'static str,
    dir: PathBuf,
    /// None = everything under `dir`.
    only: Option<&'static [&'static str]>,
}

fn sources(app: &AppHandle, include_agents: bool) -> Vec<Source> {
    let mut list = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        list.push(Source { name: "attachments", dir: dir.join("attachments"), only: None });
        list.push(Source { name: "app", dir, only: Some(&["chats/workspace.json", "settings.json", "vault.bin"]) });
    }
    if include_agents {
        let home = crate::shell_env::home_dir();
        list.push(Source { name: "claude", dir: home.join(".claude/projects"), only: None });
        list.push(Source { name: "codex", dir: home.join(".codex/sessions"), only: None });
    }
    list
}

fn chat_list(bytes: &[u8]) -> Vec<serde_json::Value> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("state")?.get("chats")?.as_array().cloned())
        .unwrap_or_default()
}

/// Chats in the last backup that are gone now go to `deleted-chats/`.
fn keep_deleted(root: &Path, previous: Option<&Snapshot>, now_chats: &[serde_json::Value]) {
    let Some(prev) = previous else { return };
    let Some(old) = prev.files.iter().find(|e| e.source == "app" && e.path == "chats/workspace.json") else { return };
    let Ok(old_bytes) = load_entry(root, old) else { return };
    let current: HashSet<&str> = now_chats.iter().filter_map(|c| c.get("id")?.as_str()).collect();
    for chat in chat_list(&old_bytes) {
        let Some(id) = chat.get("id").and_then(|v| v.as_str()) else { continue };
        if current.contains(id) || id.contains('/') || id.contains("..") {
            continue;
        }
        let path = root.join("deleted-chats").join(format!("{id}.json.gz"));
        if path.exists() {
            continue;
        }
        let record = serde_json::json!({ "deletedAt": now_ms(), "chat": chat });
        if let Ok(bytes) = serde_json::to_vec(&record).map_err(|e| e.to_string()).and_then(|b| gz(&b)) {
            let _ = write_synced(&path, &bytes);
        }
    }
}

fn dir_size(dir: &Path) -> u64 {
    let mut files = Vec::new();
    walk(dir, Path::new(""), &mut files);
    files.iter().filter_map(|f| fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum()
}

/// Removes stored contents no remaining snapshot uses.
fn collect_garbage(root: &Path) {
    let mut used = HashSet::new();
    for id in snapshot_ids(root) {
        match read_snapshot(root, id) {
            Ok(s) => {
                for e in s.files {
                    match e.chunks {
                        Some(pieces) => used.extend(pieces),
                        None => {
                            used.insert(e.hash);
                        }
                    }
                }
            }
            // An unreadable snapshot: delete nothing rather than guess.
            Err(_) => return,
        }
    }
    let mut files = Vec::new();
    walk(&root.join("files"), Path::new(""), &mut files);
    for f in files {
        let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(hash) = name.strip_suffix(".gz") {
            if !used.contains(hash) {
                let _ = fs::remove_file(root.join("files").join(&f));
            }
        }
    }
}

/// Which snapshots to keep: the newest always, everything from the last day, the newest of each
/// day for a week, the newest of each week for a month.
fn to_keep(ids: &[u64], now: u64) -> HashSet<u64> {
    let mut keep = HashSet::new();
    let mut days = HashSet::new();
    let mut weeks = HashSet::new();
    for (i, &id) in ids.iter().enumerate() {
        let age = now.saturating_sub(id);
        if i == 0 || age < DAY_MS {
            keep.insert(id);
        } else if age < 7 * DAY_MS {
            if days.insert(id / DAY_MS) {
                keep.insert(id);
            }
        } else if age < 35 * DAY_MS && weeks.insert(id / (7 * DAY_MS)) {
            keep.insert(id);
        }
    }
    keep
}

fn tidy(root: &Path, config: &BackupConfig) {
    if config.keep_forever {
        return;
    }
    let ids = snapshot_ids(root);
    let keep = to_keep(&ids, now_ms());
    let mut removed = false;
    for id in ids.iter().filter(|id| !keep.contains(id)) {
        removed |= fs::remove_file(snapshot_path(root, *id)).is_ok();
    }
    if removed {
        collect_garbage(root);
    }
    if config.limit_mb > 0 {
        let limit = config.limit_mb * 1024 * 1024;
        loop {
            let ids = snapshot_ids(root);
            if ids.len() <= 1 || dir_size(root) <= limit {
                break;
            }
            let _ = fs::remove_file(snapshot_path(root, *ids.last().unwrap()));
            collect_garbage(root);
        }
    }
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn derive(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ROUNDS, &mut key);
    key
}

/// The saved (salt, key) for locking secrets, from the Keychain; None until a password is set.
fn password_key() -> Option<(Vec<u8>, [u8; 32])> {
    let out = std::process::Command::new("/usr/bin/security").args(["find-generic-password", "-s", PASSWORD_SERVICE, "-a", "backup", "-w"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let bytes = unhex(String::from_utf8_lossy(&out.stdout).trim())?;
    if bytes.len() != 48 {
        return None;
    }
    Some((bytes[..16].to_vec(), bytes[16..].try_into().ok()?))
}

/// Locks the API keys and memory key with the backup password's key (reused when unchanged).
fn lock_secrets(app: &AppHandle, root: &Path, previous: Option<&Entry>) -> Result<Option<Entry>, String> {
    let Some((salt, key)) = password_key() else { return Ok(None) };
    let settings = crate::settings::load_settings(app.clone())?.unwrap_or(serde_json::Value::Null);
    let mut providers = serde_json::Map::new();
    if let Some(all) = settings.get("providers").and_then(|p| p.as_object()) {
        for (name, p) in all {
            if let Some(keys) = p.get("keys").filter(|k| k.as_array().is_some_and(|a| !a.is_empty())) {
                providers.insert(name.clone(), keys.clone());
            }
        }
    }
    let vault_key = crate::vault::key_for_backup().map(|k| hex(&k));
    let plain = serde_json::to_vec(&serde_json::json!({ "providers": providers, "vaultKey": vault_key })).map_err(|e| e.to_string())?;
    let fingerprint = sha(&[plain.as_slice(), &salt].concat());
    if let Some(old) = previous.filter(|o| o.plain.as_deref() == Some(fingerprint.as_str()) && is_stored(root, o)) {
        return Ok(Some(old.clone()));
    }
    let sealed = crate::vault::encrypt(&key, &plain)?;
    let blob = [SECRETS_MAGIC.as_slice(), &salt, &sealed].concat();
    let hash = sha(&blob);
    store(root, &hash, &blob)?;
    Ok(Some(Entry { source: "secrets".into(), path: SECRETS.into(), size: blob.len() as u64, hash, mtime: 0, chunks: None, plain: Some(fingerprint) }))
}

fn unlock_secrets(blob: &[u8], password: &str) -> Result<serde_json::Value, String> {
    if blob.len() < 4 + 16 + 28 || &blob[..4] != SECRETS_MAGIC {
        return Err("The locked keys in this backup are damaged.".into());
    }
    let key = derive(password, &blob[4..20]);
    let plain = crate::vault::decrypt(&key, &blob[20..]).map_err(|_| "That backup password isn't right. Nothing was changed.".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

/// Sets (or changes) the backup password. Only a key made from it is kept, in the Keychain.
#[tauri::command]
pub async fn backup_set_password(password: String) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("Use at least 8 characters.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let salt = random::<16>()?;
        let key = derive(&password, &salt);
        let status = std::process::Command::new("/usr/bin/security")
            .args(["add-generic-password", "-U", "-s", PASSWORD_SERVICE, "-a", "backup", "-w", &hex(&[salt.as_slice(), &key].concat())])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Couldn't save the backup password in the Keychain.".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether a backup password is set on this Mac.
#[tauri::command]
pub fn backup_password_set() -> bool {
    password_key().is_some()
}

const README: &str = "This folder holds E.V's backups: your chats, attached files, layout, settings and connections, and, if you chose so, your Claude Code and Codex conversations. API keys and the memory key are only in it if you turned that on, locked with your backup password.\n\n\
To restore: open E.V → Settings → Backups, pick a time and click Restore.\n\
If E.V won't open: install E.V again. During setup, choose this folder and E.V offers to restore from it.\n\n\
The files inside are compressed copies; you don't need to open them yourself.\n";

fn run_inner(app: &AppHandle, config: &BackupConfig, local_state: Option<String>) -> Result<RunReport, String> {
    let _guard = RUNNING.try_lock().map_err(|_| "A backup is already running.".to_string())?;
    let root = root_of(&config.folder);
    fs::create_dir_all(root.join("snapshots")).map_err(|e| format!("Can't write to the backup folder: {e}"))?;
    if !root.join("README.txt").exists() {
        let _ = fs::write(root.join("README.txt"), README);
    }
    let previous = snapshot_ids(&root).first().and_then(|id| read_snapshot(&root, *id).ok());
    let known: HashMap<(String, String), Entry> = previous
        .as_ref()
        .map(|s| s.files.iter().map(|e| ((e.source.clone(), e.path.clone()), e.clone())).collect())
        .unwrap_or_default();

    let mut files = Vec::new();
    let mut new_files = 0;
    let mut bytes_added = 0;
    let mut chats = 0;

    for source in sources(app, config.include_agents) {
        let paths: Vec<PathBuf> = match source.only {
            Some(list) => list.iter().map(PathBuf::from).collect(),
            None => {
                let mut all = Vec::new();
                walk(&source.dir, Path::new(""), &mut all);
                all
            }
        };
        for rel in paths {
            let full = source.dir.join(&rel);
            let Ok(meta) = fs::metadata(&full) else { continue };
            if !meta.is_file() {
                continue;
            }
            let rel_str = rel.to_string_lossy().to_string();
            let mtime = mtime_of(&meta);
            let key = (source.name.to_string(), rel_str.clone());
            // Unchanged since the last backup (same size and time): reuse it without reading it.
            if let Some(old) = known.get(&key).filter(|o| o.size == meta.len() && o.mtime == mtime && is_stored(&root, o)) {
                if rel_str == "chats/workspace.json" {
                    chats = load_entry(&root, old).map(|b| chat_list(&b).len()).unwrap_or(0);
                }
                files.push(old.clone());
                continue;
            }
            let Ok(raw) = fs::read(&full) else { continue };
            let bytes = if source.name == "app" && rel_str == "settings.json" { settings_without_keys(&raw).unwrap_or_default() } else { raw };
            if bytes.is_empty() && rel_str == "settings.json" {
                continue;
            }
            if rel_str == "chats/workspace.json" {
                let list = chat_list(&bytes);
                chats = list.len();
                if config.keep_deleted {
                    keep_deleted(&root, previous.as_ref(), &list);
                }
            }
            let hash = sha(&bytes);
            let (chunks, added) = store_file(&root, &hash, &bytes)?;
            if added > 0 {
                new_files += 1;
                bytes_added += added;
            }
            files.push(Entry { source: source.name.into(), path: rel_str, hash, size: meta.len(), mtime, chunks, plain: None });
        }
    }

    // The app's own saved state (layout, drafts, preferences): sent by the window, or kept from the last backup.
    match local_state {
        Some(text) => {
            let bytes = text.into_bytes();
            let hash = sha(&bytes);
            let added = store(&root, &hash, &bytes)?;
            if added > 0 {
                new_files += 1;
                bytes_added += added;
            }
            files.push(Entry { source: "local".into(), path: LOCAL_STATE.into(), size: bytes.len() as u64, hash, mtime: 0, chunks: None, plain: None });
        }
        None => {
            if let Some(old) = known.get(&("local".to_string(), LOCAL_STATE.to_string())) {
                files.push(old.clone());
            }
        }
    }

    if config.include_secrets {
        if let Some(entry) = lock_secrets(app, &root, known.get(&("secrets".to_string(), SECRETS.to_string())))? {
            if known.get(&("secrets".to_string(), SECRETS.to_string())).map_or(true, |o| o.hash != entry.hash) {
                new_files += 1;
                bytes_added += entry.size;
            }
            files.push(entry);
        }
    }

    let at = now_ms();
    let same = previous.as_ref().is_some_and(|p| {
        let a: HashSet<(&str, &str, &str)> = p.files.iter().map(|e| (e.source.as_str(), e.path.as_str(), e.hash.as_str())).collect();
        let b: HashSet<(&str, &str, &str)> = files.iter().map(|e| (e.source.as_str(), e.path.as_str(), e.hash.as_str())).collect();
        a == b
    });
    if same {
        let _ = fs::write(root.join("last-checked"), at.to_string());
        tidy(&root, config);
        return Ok(RunReport { saved: false, at, new_files: 0, bytes_added: 0 });
    }

    let snapshot = Snapshot { at, app_version: app.package_info().version.to_string(), chats, files };
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    write_synced(&snapshot_path(&root, at), &gz(&bytes)?)?;
    let _ = fs::write(root.join("last-checked"), at.to_string());
    tidy(&root, config);
    Ok(RunReport { saved: true, at, new_files, bytes_added })
}

/// Takes a backup now. `local_state`: the window's saved preferences (JSON).
#[tauri::command]
pub async fn backup_run(app: AppHandle, config: BackupConfig, local_state: Option<String>) -> Result<RunReport, String> {
    *CONFIG.lock().unwrap() = Some(config.clone());
    tauri::async_runtime::spawn_blocking(move || run_inner(&app, &config, local_state)).await.map_err(|e| e.to_string())?
}

/// Remembers the settings so quitting E.V takes a last backup (None = backups off).
#[tauri::command]
pub fn backup_configure(config: Option<BackupConfig>) {
    *CONFIG.lock().unwrap() = config;
}

/// Called when E.V quits normally: one more backup of the files (quick: only changes are copied).
pub fn on_quit(app: &AppHandle) {
    let config = CONFIG.lock().unwrap().clone();
    if let Some(config) = config {
        let _ = run_inner(app, &config, None);
    }
}

#[tauri::command]
pub fn backup_status(folder: String) -> Result<BackupStatus, String> {
    let root = root_of(&folder);
    let ids = snapshot_ids(&root);
    let snapshots: Vec<SnapshotInfo> = ids
        .iter()
        .filter_map(|id| read_snapshot(&root, *id).ok().map(|s| (id, s)))
        .map(|(id, s)| SnapshotInfo {
            id: id.to_string(),
            at: s.at,
            app_version: s.app_version,
            chats: s.chats,
            files: s.files.len(),
            has_secrets: s.files.iter().any(|e| e.source == "secrets"),
        })
        .collect();
    let checked = fs::read_to_string(root.join("last-checked")).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    let mut deleted_chats: Vec<DeletedChat> = fs::read_dir(root.join("deleted-chats"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let bytes = gunzip(&fs::read(e.path()).ok()?).ok()?;
                    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                    let chat = v.get("chat")?;
                    Some(DeletedChat {
                        id: chat.get("id")?.as_str()?.to_string(),
                        title: chat.get("title").and_then(|t| t.as_str()).unwrap_or("Chat").to_string(),
                        deleted_at: v.get("deletedAt").and_then(|t| t.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    deleted_chats.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(BackupStatus {
        root: root.display().to_string(),
        last_run: ids.first().copied().unwrap_or(0).max(checked),
        snapshots,
        total_bytes: if root.exists() { dir_size(&root) } else { 0 },
        deleted_chats,
    })
}

/// The suggested place for backups (Documents), and whether backups already sit there.
#[tauri::command]
pub fn backup_default_folder() -> String {
    crate::shell_env::home_dir().join("Documents").display().to_string()
}

/// A deleted chat kept in the backup, as JSON, to put back in the Closed Chats drawer.
#[tauri::command]
pub fn backup_deleted_chat(folder: String, id: String) -> Result<String, String> {
    if id.contains('/') || id.contains("..") {
        return Err("Not a chat id.".into());
    }
    let bytes = gunzip(&fs::read(root_of(&folder).join("deleted-chats").join(format!("{id}.json.gz"))).map_err(|e| e.to_string())?)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    serde_json::to_string(v.get("chat").ok_or("Not a saved chat.")?).map_err(|e| e.to_string())
}

/// Removes this one chat from the kept deleted chats (after it was brought back).
#[tauri::command]
pub fn backup_forget_deleted_chat(folder: String, id: String) -> Result<(), String> {
    if id.contains('/') || id.contains("..") {
        return Err("Not a chat id.".into());
    }
    fs::remove_file(root_of(&folder).join("deleted-chats").join(format!("{id}.json.gz"))).map_err(|e| e.to_string())
}

/// Deletes every backup: the whole "E.V Backups" folder (only if it really is one).
#[tauri::command]
pub fn backup_delete_all(folder: String) -> Result<(), String> {
    let _guard = RUNNING.lock().unwrap();
    let root = root_of(&folder);
    if !root.join("snapshots").is_dir() || root.file_name().map_or(true, |n| n != ROOT_NAME) {
        return Err("That folder doesn't hold E.V backups.".into());
    }
    fs::remove_dir_all(&root).map_err(|e| e.to_string())
}

/// Puts a backup back: chats, settings (your current API keys and backup choices are kept),
/// connections, and any Claude Code / Codex conversation that's missing or shorter than in the
/// backup. A backup of how things are right now is taken first, so a restore can be undone.
/// Returns the window's saved preferences to write back before E.V restarts.
#[tauri::command]
pub async fn backup_restore(app: AppHandle, config: BackupConfig, id: String, local_state: Option<String>, password: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id: u64 = id.parse().map_err(|_| "Not a backup.".to_string())?;
        let root = root_of(&config.folder);
        let snapshot = read_snapshot(&root, id)?;
        // Check every file first, so a damaged backup changes nothing.
        let mut contents = Vec::new();
        let mut secrets: Option<serde_json::Value> = None;
        for entry in &snapshot.files {
            let bytes = load_entry(&root, entry)?;
            if entry.source == "secrets" {
                // Without the password the keys stay as they are now; a wrong one changes nothing.
                if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
                    secrets = Some(unlock_secrets(&bytes, pw)?);
                }
                continue;
            }
            contents.push((entry.clone(), bytes));
        }
        run_inner(&app, &BackupConfig { keep_forever: true, ..config.clone() }, local_state)?;
        crate::chat_store::block_saves();

        let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let home = crate::shell_env::home_dir();
        let mut local = None;
        for (entry, bytes) in contents {
            if entry.path.contains("..") {
                continue;
            }
            match entry.source.as_str() {
                "local" => local = Some(String::from_utf8_lossy(&bytes).to_string()),
                "app" if entry.path == "settings.json" => restore_settings(&app, &bytes, secrets.as_ref().and_then(|s| s.get("providers")))?,
                "attachments" => {
                    let target = app_dir.join("attachments").join(&entry.path);
                    if fs::metadata(&target).map_or(true, |m| m.len() != bytes.len() as u64) {
                        write_synced(&target, &bytes)?;
                    }
                }
                "app" => write_synced(&app_dir.join(&entry.path), &bytes)?,
                "claude" | "codex" => {
                    let base = if entry.source == "claude" { home.join(".claude/projects") } else { home.join(".codex/sessions") };
                    let target = base.join(&entry.path);
                    let shorter = fs::metadata(&target).map_or(true, |m| m.len() < bytes.len() as u64);
                    if shorter {
                        write_synced(&target, &bytes)?;
                    }
                }
                _ => {}
            }
        }
        if let Some(key) = secrets.as_ref().and_then(|s| s.get("vaultKey")?.as_str().map(String::from)).and_then(|h| unhex(&h)).and_then(|k| <[u8; 32]>::try_from(k).ok()) {
            crate::vault::restore_key(&key)?;
        }
        Ok(local)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `backup_keys`: API keys unlocked from the backup ({provider: keys}); otherwise today's keys stay.
fn restore_settings(app: &AppHandle, bytes: &[u8], backup_keys: Option<&serde_json::Value>) -> Result<(), String> {
    let mut restored: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let current = crate::settings::load_settings(app.clone())?.unwrap_or(serde_json::Value::Null);
    if let Some(r) = restored.get_mut("providers").and_then(|p| p.as_object_mut()) {
        for (name, provider) in r.iter_mut() {
            let from_backup = backup_keys.and_then(|k| k.get(name)).filter(|k| k.as_array().is_some_and(|a| !a.is_empty()));
            let keys = from_backup.or_else(|| current.get("providers")?.get(name)?.get("keys"));
            if let (Some(obj), Some(keys)) = (provider.as_object_mut(), keys) {
                obj.insert("keys".into(), keys.clone());
            }
        }
    }
    if let Some(obj) = restored.as_object_mut() {
        for field in ["backup", "whatsNewSeen"] {
            match current.get(field) {
                Some(v) => obj.insert(field.into(), v.clone()),
                None => obj.remove(field),
            };
        }
        obj.insert("onboarded".into(), serde_json::json!(true));
    }
    crate::settings::save_settings(app.clone(), restored)
}

/// Restarts E.V after a restore.
#[tauri::command]
pub fn backup_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinning_keeps_newest_recent_daily_and_weekly() {
        let now = 100 * DAY_MS;
        let ids = vec![now - 1000, now - 2 * 3_600_000, now - DAY_MS - 10, now - DAY_MS - 20, now - 3 * DAY_MS, now - 10 * DAY_MS, now - 11 * DAY_MS, now - 60 * DAY_MS];
        let keep = to_keep(&ids, now);
        assert!(keep.contains(&ids[0]) && keep.contains(&ids[1]));
        assert!(keep.contains(&ids[2]) && !keep.contains(&ids[3]));
        assert!(keep.contains(&ids[4]));
        assert!(!keep.contains(&ids[7]));
        assert_eq!(to_keep(&[now - 90 * DAY_MS], now).len(), 1);
    }

    #[test]
    fn locked_secrets_open_only_with_the_password() {
        let salt = [7u8; 16];
        let key = derive("correct horse", &salt);
        let sealed = crate::vault::encrypt(&key, br#"{"providers":{}}"#).unwrap();
        let blob = [SECRETS_MAGIC.as_slice(), &salt, &sealed].concat();
        assert!(unlock_secrets(&blob, "correct horse").is_ok());
        assert!(unlock_secrets(&blob, "wrong").is_err());
    }

    #[test]
    fn strips_api_keys() {
        let out = settings_without_keys(br#"{"providers":{"openai":{"keys":[{"key":"sk-x"}]}}}"#).unwrap();
        assert!(!String::from_utf8(out).unwrap().contains("sk-x"));
    }
}
