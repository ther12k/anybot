use std::path::PathBuf;
use keyring::Entry;
use serde_json::Value;
use tokio::fs;

const SERVICE_NAME: &str = "anybot";

const SENSITIVE_KEYS: &[(&str, &str)] = &[
    ("anthropicApiKey", "anthropic_api_key"),
    ("openaiApiKey", "openai_api_key"),
    ("grokApiKey", "grok_api_key"),
];

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

#[tauri::command]
pub async fn load_vault_config() -> Result<String, String> {
    let path = get_config_path();
    let mut config_val: Value = if path.exists() {
        let content = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let mut keychain_active = false;
    let mut needs_resave = false;

    // Check each sensitive key
    if let Some(obj) = config_val.as_object_mut() {
        for (json_field, account) in SENSITIVE_KEYS {
            // 1. Check if plaintext key exists in config.json (legacy migration)
            if let Some(val_str) = obj.get(*json_field).and_then(|v| v.as_str()) {
                if !val_str.is_empty() && val_str != "[STORED_IN_OS_KEYCHAIN]" {
                    // Migrate to OS keychain
                    if store_secret_in_keychain(account, val_str) {
                        keychain_active = true;
                        obj.insert(
                            json_field.to_string(),
                            Value::String("[STORED_IN_OS_KEYCHAIN]".to_string()),
                        );
                        needs_resave = true;
                    }
                }
            }

            // 2. Retrieve from OS keychain
            if let Some(secret) = retrieve_secret_from_keychain(account) {
                keychain_active = true;
                obj.insert(json_field.to_string(), Value::String(secret));
            } else if let Some(val_str) = obj.get(*json_field).and_then(|v| v.as_str()) {
                if val_str == "[STORED_IN_OS_KEYCHAIN]" {
                    // Stored in keychain placeholder, but keychain had no value: clear it
                    obj.insert(json_field.to_string(), Value::String("".to_string()));
                }
            }
        }

        obj.insert(
            "keychainStorageActive".to_string(),
            Value::Bool(keychain_active),
        );
    }

    if needs_resave {
        // Save cleaned config with permissions 0600
        let mut scrubbed = config_val.clone();
        if let Some(obj) = scrubbed.as_object_mut() {
            for (json_field, _) in SENSITIVE_KEYS {
                if obj.get(*json_field).is_some() {
                    obj.insert(
                        json_field.to_string(),
                        Value::String("[STORED_IN_OS_KEYCHAIN]".to_string()),
                    );
                }
            }
        }
        if let Ok(json_text) = serde_json::to_string_pretty(&scrubbed) {
            let _ = fs::write(&path, json_text).await;
            secure_file_permissions(&path);
        }
    }

    serde_json::to_string(&config_val).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_vault_config(json_data: String) -> Result<bool, String> {
    let mut parsed: Value = serde_json::from_str(&json_data).map_err(|e| e.to_string())?;
    let mut scrubbed = parsed.clone();

    let mut keychain_active = false;

    if let (Some(parsed_obj), Some(scrubbed_obj)) =
        (parsed.as_object_mut(), scrubbed.as_object_mut())
    {
        for (json_field, account) in SENSITIVE_KEYS {
            if let Some(val_str) = parsed_obj.get(*json_field).and_then(|v| v.as_str()) {
                if store_secret_in_keychain(account, val_str) {
                    keychain_active = true;
                    if !val_str.is_empty() {
                        scrubbed_obj.insert(
                            json_field.to_string(),
                            Value::String("[STORED_IN_OS_KEYCHAIN]".to_string()),
                        );
                    } else {
                        scrubbed_obj.insert(json_field.to_string(), Value::String("".to_string()));
                    }
                }
            }
        }
        scrubbed_obj.insert(
            "keychainStorageActive".to_string(),
            Value::Bool(keychain_active),
        );
    }

    let path = get_config_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
    }

    let save_text = serde_json::to_string_pretty(&scrubbed).map_err(|e| e.to_string())?;
    fs::write(&path, save_text).await.map_err(|e| e.to_string())?;
    secure_file_permissions(&path);

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
