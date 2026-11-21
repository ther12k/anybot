use std::collections::HashMap;
use std::path::{Path, PathBuf};
use keyring::Entry;
use serde_json::Value;
use tokio::fs;

const SERVICE_NAME: &str = "anybot";

const SENSITIVE_KEYS: &[(&str, &str)] = &[
    ("anthropicApiKey", "anthropic_api_key"),
    ("openaiApiKey", "openai_api_key"),
    ("grokApiKey", "grok_api_key"),
];

const KEYCHAIN_PLACEHOLDER: &str = "[STORED_IN_OS_KEYCHAIN]";

/// Injectable keychain operations so failure paths are unit-testable.
type StoreFn = fn(&str, &str) -> bool;
type RetrieveFn = fn(&str) -> Option<String>;

fn get_config_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            return PathBuf::from(app_data).join("anybot").join("config.json");
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("anybot").join("config.json")
}

/// Store secret key into OS keychain. Returns true if keychain succeeded.
/// An empty secret deletes the credential (absence is also a success).
fn store_secret_in_keychain(account: &str, secret: &str) -> bool {
    if secret.trim().is_empty() {
        if let Ok(entry) = Entry::new(SERVICE_NAME, account) {
            let _ = entry.delete_credential();
        }
        return true;
    }

    if let Ok(entry) = Entry::new(SERVICE_NAME, account) {
        if entry.set_password(secret).is_ok() {
            return true;
        }
    }
    false
}

/// Retrieve secret key from OS keychain.
fn retrieve_secret_from_keychain(account: &str) -> Option<String> {
    if let Ok(entry) = Entry::new(SERVICE_NAME, account) {
        if let Ok(password) = entry.get_password() {
            if !password.is_empty() {
                return Some(password);
            }
        }
    }
    None
}

/// Secure the file permissions on Unix so only the current user can read/write it.
fn secure_file_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Previous on-disk string values, used for save rollback.
fn previous_disk_values(path: &Path) -> HashMap<String, Option<String>> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| v.as_object().map(|o| o.clone()))
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(String::from)))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn load_vault_config() -> Result<String, String> {
    load_vault_config_at(
        &get_config_path(),
        store_secret_in_keychain,
        retrieve_secret_from_keychain,
    )
    .await
}

/// Load the config, migrating legacy plaintext secrets into the keychain.
/// Migration is per-field and non-destructive: a field whose keychain store
/// fails keeps its plaintext on disk — that plaintext is the only remaining
/// copy and must never be replaced with a placeholder. Only fields migrated
/// in this pass (or already placeholder-backed by a live keychain value) are
/// scrubbed in the on-disk rewrite.
pub async fn load_vault_config_at(
    path: &Path,
    store: StoreFn,
    retrieve: RetrieveFn,
) -> Result<String, String> {
    let mut config_val: Value = if path.exists() {
        let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let mut keychain_active = false;
    let mut needs_resave = false;
    // (field, replacement) pairs for the on-disk rewrite.
    let mut disk_rewrite: Vec<(String, String)> = Vec::new();

    if let Some(obj) = config_val.as_object_mut() {
        for &(json_field, account) in SENSITIVE_KEYS {
            let on_disk = obj.get(json_field).and_then(|v| v.as_str()).map(String::from);

            // 1. Legacy plaintext → migrate to the keychain, per field.
            if let Some(val_str) = &on_disk {
                if !val_str.is_empty() && val_str != KEYCHAIN_PLACEHOLDER && store(account, val_str) {
                    keychain_active = true;
                    disk_rewrite.push((json_field.to_string(), KEYCHAIN_PLACEHOLDER.to_string()));
                    needs_resave = true;
                }
                // A failed migration leaves the plaintext untouched on disk.
            }

            // 2. Retrieve from the keychain for the running app.
            if let Some(secret) = retrieve(account) {
                keychain_active = true;
                if on_disk.as_deref() == Some(KEYCHAIN_PLACEHOLDER) {
                    // The disk copy is a pointer at a live keychain value:
                    // keep pointing at it in the rewrite.
                    disk_rewrite.push((json_field.to_string(), KEYCHAIN_PLACEHOLDER.to_string()));
                    needs_resave = true;
                }
                obj.insert(json_field.to_string(), Value::String(secret));
            } else if on_disk.as_deref() == Some(KEYCHAIN_PLACEHOLDER) {
                // Placeholder with no keychain value behind it: clear it.
                obj.insert(json_field.to_string(), Value::String(String::new()));
                disk_rewrite.push((json_field.to_string(), String::new()));
                needs_resave = true;
            }
        }

        obj.insert(
            "keychainStorageActive".to_string(),
            Value::Bool(keychain_active),
        );
    }

    if needs_resave {
        let mut scrubbed = config_val.clone();
        if let Some(obj) = scrubbed.as_object_mut() {
            for (field, replacement) in &disk_rewrite {
                obj.insert(field.clone(), Value::String(replacement.clone()));
            }
        }
        if let Ok(json_text) = serde_json::to_string_pretty(&scrubbed) {
            let _ = fs::write(path, json_text).await;
            secure_file_permissions(path);
        }
    }

    serde_json::to_string(&config_val).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_vault_config(json_data: String) -> Result<bool, String> {
    save_vault_config_at(&get_config_path(), &json_data, store_secret_in_keychain).await
}

/// Fail-closed vault save: every non-empty secret must be stored in the OS
/// keychain BEFORE anything is written. On any keychain failure nothing is
/// persisted, already-stored entries are rolled back to their previous
/// values, and the caller gets an error — plaintext is never silently saved
/// to config.json as a fallback.
pub async fn save_vault_config_at(
    path: &Path,
    json_data: &str,
    store: StoreFn,
) -> Result<bool, String> {
    let mut parsed: Value = serde_json::from_str(json_data).map_err(|e| e.to_string())?;
    let mut scrubbed = parsed.clone();

    let previous = previous_disk_values(path);

    let mut keychain_active = false;
    // Accounts stored in this pass, with their previous on-disk value for
    // rollback if a later field fails.
    let mut stored: Vec<(&'static str, String)> = Vec::new();
    let mut failures: Vec<&'static str> = Vec::new();

    {
        let parsed_obj = parsed
            .as_object_mut()
            .ok_or_else(|| "Vault config must be a JSON object.".to_string())?;
        let scrubbed_obj = scrubbed
            .as_object_mut()
            .ok_or_else(|| "Vault config must be a JSON object.".to_string())?;

        for &(json_field, account) in SENSITIVE_KEYS {
            let Some(val_str) = parsed_obj.get(json_field).and_then(|v| v.as_str()) else {
                continue;
            };
            if store(account, val_str) {
                if !val_str.is_empty() {
                    keychain_active = true;
                    scrubbed_obj.insert(
                        json_field.to_string(),
                        Value::String(KEYCHAIN_PLACEHOLDER.to_string()),
                    );
                    let prior = previous.get(json_field).cloned().flatten().unwrap_or_default();
                    stored.push((account, prior));
                } else {
                    // Cleared key: record the empty value on disk.
                    scrubbed_obj.insert(json_field.to_string(), Value::String(String::new()));
                }
            } else if !val_str.is_empty() {
                // Fail closed: a keychain failure for any secret aborts the
                // whole save. Plaintext is never persisted as a fallback.
                failures.push(account);
            }
        }
    }

    if !failures.is_empty() {
        // Roll back so the keychain does not keep values from a save the
        // user was told failed. Best effort: an empty prior deletes.
        for (account, prior) in stored {
            let _ = store(account, &prior);
        }
        return Err(format!(
            "Could not store {} in the OS keychain. Nothing was saved and no API keys were written to config.json.",
            failures.join(", ")
        ));
    }

    if let Some(scrubbed_obj) = scrubbed.as_object_mut() {
        scrubbed_obj.insert(
            "keychainStorageActive".to_string(),
            Value::Bool(keychain_active),
        );
    }

    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
    }

    let save_text = serde_json::to_string_pretty(&scrubbed).map_err(|e| e.to_string())?;
    fs::write(path, save_text).await.map_err(|e| e.to_string())?;
    secure_file_permissions(path);

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        static CALLS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
        static FAIL_ACCOUNT: std::cell::RefCell<Option<&'static str>> =
            const { std::cell::RefCell::new(None) };
    }

    fn test_store(account: &str, secret: &str) -> bool {
        CALLS.with(|c| c.borrow_mut().push(format!("{account}={secret}")));
        FAIL_ACCOUNT.with(|f| f.borrow().map(|a| a != account).unwrap_or(true))
    }

    fn test_retrieve(_account: &str) -> Option<String> {
        None
    }

    fn temp_config(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("anybot-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("config.json")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    fn reset() {
        CALLS.with(|c| c.borrow_mut().clear());
        FAIL_ACCOUNT.with(|f| f.borrow_mut().take());
    }

    #[test]
    fn test_keyring_api() {
        let entry = keyring::Entry::new("anybot-test", "sample_account").unwrap();
        let _ = entry.get_password();
        let _ = entry.set_password("sample");
        let _ = entry.delete_credential();
    }

    #[tokio::test]
    async fn test_secure_file_permissions() {
        let temp_dir = std::env::temp_dir().join(format!("anybot-vault-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let test_file = temp_dir.join("config.json");
        std::fs::write(&test_file, "{}").unwrap();

        secure_file_permissions(&test_file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&test_file).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "file mode must be 0600 (owner rw only)");
        }

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn save_fails_closed_without_persisting_plaintext() {
        reset();
        FAIL_ACCOUNT.with(|f| *f.borrow_mut() = Some("openai_api_key"));
        let path = temp_config("save-closed");
        let json = r#"{"anthropicApiKey":"sk-ant-1","openaiApiKey":"sk-oai-1","grokApiKey":"","autoApproveSafeTools":true}"#;

        let res = save_vault_config_at(&path, json, test_store).await;
        assert!(res.is_err(), "a keychain failure must fail the save");
        assert!(
            res.unwrap_err().contains("openai_api_key"),
            "the error must name the failing credential"
        );
        assert!(!path.exists(), "nothing may be written when a store fails");

        let calls = CALLS.with(|c| c.borrow().clone());
        assert!(calls.contains(&"anthropic_api_key=sk-ant-1".to_string()));
        // Rollback: the already-stored anthropic entry returned to its
        // (absent) previous value.
        assert!(
            calls.contains(&"anthropic_api_key=".to_string()),
            "stored entries must be rolled back, got {calls:?}"
        );
        cleanup(&path);
    }

    #[tokio::test]
    async fn save_success_scrubs_all_placeholders() {
        reset();
        let path = temp_config("save-ok");
        let json = r#"{"anthropicApiKey":"sk-ant-2","openaiApiKey":"","ollamaBaseUrl":"http://localhost:11434"}"#;

        save_vault_config_at(&path, json, test_store)
            .await
            .expect("all stores succeeded");

        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["anthropicApiKey"], KEYCHAIN_PLACEHOLDER);
        assert_eq!(on_disk["openaiApiKey"], "");
        assert_eq!(on_disk["ollamaBaseUrl"], "http://localhost:11434");
        assert_eq!(on_disk["keychainStorageActive"], true);
        cleanup(&path);
    }

    #[tokio::test]
    async fn load_keeps_failed_migration_plaintext() {
        reset();
        FAIL_ACCOUNT.with(|f| *f.borrow_mut() = Some("openai_api_key"));
        let path = temp_config("load-migrate");
        std::fs::write(
            &path,
            r#"{"anthropicApiKey":"sk-ant-old","openaiApiKey":"sk-oai-old"}"#,
        )
        .unwrap();

        let loaded = load_vault_config_at(&path, test_store, test_retrieve)
            .await
            .unwrap();
        let in_memory: Value = serde_json::from_str(&loaded).unwrap();
        // The running app still receives both secrets.
        assert_eq!(in_memory["anthropicApiKey"], "sk-ant-old");
        assert_eq!(in_memory["openaiApiKey"], "sk-oai-old");

        // On disk: migrated field becomes a placeholder; the failed field
        // keeps its only remaining copy as plaintext.
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["anthropicApiKey"], KEYCHAIN_PLACEHOLDER);
        assert_eq!(
            on_disk["openaiApiKey"], "sk-oai-old",
            "a failed migration must not destroy the only copy"
        );
        cleanup(&path);
    }
}
