use std::path::PathBuf;
use tokio::fs;

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

#[tauri::command]
pub async fn load_vault_config() -> Result<String, String> {
    let path = get_config_path();
    if !path.exists() {
        return Ok("{}".to_string());
    }

    fs::read_to_string(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_vault_config(json_data: String) -> Result<bool, String> {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
    }

    fs::write(path, json_data).await.map_err(|e| e.to_string())?;
    Ok(true)
}
