//! Encrypted store for E.V memory and schedules. The file holds a random nonce followed by
//! ChaCha20-Poly1305 ciphertext; the 256-bit key lives only in the login Keychain. The frontend
//! owns the JSON shape; this module only encrypts, decrypts and writes atomically.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;

const SERVICE: &str = if cfg!(test) { "E.V Vault Key (test)" } else { "E.V Vault Key" };
const ACCOUNT: &str = "vault";

pub fn vault_path() -> PathBuf {
    let name = if cfg!(test) { "vault-test.bin" } else { "vault.bin" };
    crate::shell_env::home_dir().join("Library/Application Support/com.ducknac.ev").join(name)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("could not read random bytes: {e}"))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

fn read_key() -> Option<[u8; 32]> {
    let output = Command::new("/usr/bin/security").args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    unhex(String::from_utf8_lossy(&output.stdout).trim())?.try_into().ok()
}

/// The vault key, created on first use. Refuses to make a new key while an encrypted file exists:
/// that file could then never be opened again.
fn key(create: bool) -> Result<[u8; 32], String> {
    if let Some(key) = read_key() {
        return Ok(key);
    }
    if !create || vault_path().exists() {
        return Err("The memory key is missing from the Keychain, so saved memory can't be opened.".into());
    }
    let key = random_bytes::<32>()?;
    let status = Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", &hex(&key)])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not store the memory key in the Keychain.".into());
    }
    Ok(key)
}

pub fn encrypt(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = random_bytes::<12>()?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), plain).map_err(|_| "encryption failed".to_string())?;
    Ok([nonce.as_slice(), &sealed].concat())
}

pub fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 + 16 {
        return Err("the memory file is damaged".into());
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "the memory file is damaged or was encrypted with another key".into())
}

/// Decrypted vault JSON, or an empty string when nothing has been saved yet.
pub fn load() -> Result<String, String> {
    let path = vault_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let plain = decrypt(&key(false)?, &data)?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

pub fn save(json: &str) -> Result<(), String> {
    let path = vault_path();
    let sealed = encrypt(&key(true)?, json.as_bytes())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write-then-rename so a crash mid-save never leaves a half-written vault.
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, sealed).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_load() -> Result<String, String> {
    tokio::task::spawn_blocking(load).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_save(json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save(&json)).await.map_err(|e| e.to_string())?
}

/// macOS notification banner (used for schedule reminders).
#[tauri::command]
pub async fn show_notification(title: String, body: String) -> Result<(), String> {
    let quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display notification \"{}\" with title \"{}\" sound name \"Glass\"", quote(&body), quote(&title));
    tokio::process::Command::new("/usr/bin/osascript").args(["-e", &script]).status().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// `gideon --print-memory`: prints E.V memory as plain text for Claude Code's SessionStart
/// hook, so Claude Code sessions know what the user taught E.V. Chat memory stays private.
pub fn print_memory() -> i32 {
    let Ok(json) = load() else { return 0 };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else { return 0 };
    let items: Vec<String> = value
        .get("memories")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter(|m| m.get("scope").and_then(|s| s.as_str()) == Some("gideon"))
        .filter_map(|m| {
            let text = m.get("text")?.as_str()?;
            let kind = m.get("kind").and_then(|k| k.as_str()).unwrap_or("note");
            Some(format!("- [{kind}] {text}"))
        })
        .collect();
    if !items.is_empty() {
        println!("# E.V memory — what the user has taught their AI assistants (follow it)\n{}", items.join("\n"));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_and_rejects_tampering() {
        let key = [7u8; 32];
        let sealed = encrypt(&key, b"I live in Springfield").unwrap();
        assert!(!sealed.windows(7).any(|w| w == b"Springfield"));
        assert_eq!(decrypt(&key, &sealed).unwrap(), b"I live in Springfield");
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &tampered).is_err());
        assert!(decrypt(&[8u8; 32], &sealed).is_err());
    }

    #[test]
    fn round_trips_through_the_keychain() {
        let _ = std::fs::remove_file(vault_path());
        let _ = Command::new("/usr/bin/security").args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).output();
        assert_eq!(load().unwrap(), "");
        save(r#"{"memories":[{"scope":"gideon","kind":"about","text":"Lives in Springfield"}]}"#).unwrap();
        assert!(load().unwrap().contains("Lives in Springfield"));
        assert!(!std::fs::read(vault_path()).unwrap().windows(7).any(|w| w == b"Springfield"));
        let _ = std::fs::remove_file(vault_path());
        let _ = Command::new("/usr/bin/security").args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).output();
    }
}
