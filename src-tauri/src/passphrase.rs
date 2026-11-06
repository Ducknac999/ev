//! Spoken approval passphrase. Only a salted, stretched hash is kept, in the login Keychain; the
//! phrase itself never touches disk, settings or the AI.

use sha2::{Digest, Sha256};
use std::io::Read;
use tokio::process::Command;

const SERVICE: &str = if cfg!(test) { "E.V Voice Approval (test)" } else { "E.V Voice Approval" };
const ACCOUNT: &str = "passphrase";
const ROUNDS: u32 = 100_000;

const NUMBER_WORDS: &[&str] = &[
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/// Lower-case words with punctuation removed and number words as digits, so "Copper, Lantern
/// nine." and "copper lantern 9" match — speech recognition writes numbers either way.
pub fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|word| match NUMBER_WORDS.iter().position(|n| *n == word) {
            Some(i) => i.to_string(),
            None => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `heard` contains `phrase` as whole words (people often add "uh" or "okay").
pub fn contains_phrase(heard: &str, phrase: &str) -> bool {
    let (heard, phrase) = (normalize(heard), normalize(phrase));
    !phrase.is_empty() && format!(" {heard} ").contains(&format!(" {phrase} "))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn stretch(salt: &str, normalized: &str) -> String {
    let mut digest = Sha256::digest(format!("{salt}:{normalized}").as_bytes()).to_vec();
    for _ in 0..ROUNDS {
        let mut hasher = Sha256::new();
        hasher.update(salt.as_bytes());
        hasher.update(&digest);
        digest = hasher.finalize().to_vec();
    }
    hex(&digest)
}

fn random_salt() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("could not create a salt: {e}"))?;
    Ok(hex(&bytes))
}

/// Saved as `salt:word count:hash`.
async fn stored() -> Option<(String, usize, String)> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = value.splitn(3, ':');
    let salt = parts.next()?.to_string();
    let words = parts.next()?.parse().ok()?;
    Some((salt, words, parts.next()?.to_string()))
}

/// Constant-time comparison so timing never hints at how close an attempt was.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[tauri::command]
pub async fn passphrase_status() -> bool {
    stored().await.is_some()
}

#[tauri::command]
pub async fn passphrase_set(phrase: String) -> Result<(), String> {
    let normalized = normalize(&phrase);
    if normalized.split(' ').count() < 2 {
        return Err("Use at least two words.".into());
    }
    let salt = random_salt()?;
    let words = normalized.split(' ').count();
    let hash = tokio::task::spawn_blocking({
        let salt = salt.clone();
        move || stretch(&salt, &normalized)
    })
    .await
    .map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", &format!("{salt}:{words}:{hash}")])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not save the passphrase to the Keychain.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn passphrase_clear() -> Result<(), String> {
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// True when what was heard contains the saved passphrase.
#[tauri::command]
pub async fn passphrase_check(heard: String) -> bool {
    let Some((salt, count, hash)) = stored().await else { return false };
    tokio::task::spawn_blocking(move || {
        let normalized = normalize(&heard);
        let words: Vec<&str> = normalized.split(' ').collect();
        // Try each run of the right length, so extra words around the phrase don't matter.
        words.len() >= count && words.windows(count).take(40).any(|run| same(&stretch(&salt, &run.join(" ")), &hash))
    })
    .await
    .unwrap_or(false)
}

/// Used while setting up: does what was heard match the phrase just typed?
#[tauri::command]
pub fn passphrase_matches(heard: String, phrase: String) -> bool {
    contains_phrase(&heard, &phrase)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_speech() {
        assert_eq!(normalize("Copper, Lantern nine."), "copper lantern 9");
        assert_eq!(normalize("  copper   lantern 9 "), "copper lantern 9");
    }

    #[test]
    fn matches_with_extra_words() {
        assert!(contains_phrase("Uh, copper lantern nine.", "copper lantern 9"));
        assert!(!contains_phrase("copper lanterns nine", "copper lantern 9"));
        assert!(!contains_phrase("anything", ""));
    }

    #[tokio::test]
    async fn round_trips_through_the_keychain() {
        passphrase_clear().await.unwrap();
        assert!(!passphrase_status().await);
        assert!(passphrase_set("one".into()).await.is_err());
        passphrase_set("Copper lantern nine".into()).await.unwrap();
        assert!(passphrase_status().await);
        assert!(passphrase_check("okay, copper lantern 9.".into()).await);
        assert!(!passphrase_check("copper lantern".into()).await);
        assert!(!passphrase_check("brass lantern nine".into()).await);
        passphrase_clear().await.unwrap();
        assert!(!passphrase_status().await);
    }

    #[test]
    fn hashes_are_salted() {
        assert_eq!(stretch("a", "x y"), stretch("a", "x y"));
        assert_ne!(stretch("a", "x y"), stretch("b", "x y"));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
