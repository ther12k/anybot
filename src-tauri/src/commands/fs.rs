use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use crate::models::{DirEntryInfo, FileReadResult, FileWriteResult, SystemInfo};
use crate::policy::audit;

fn audit_fs(tool: &str, outcome: &str, path: &str, decision: &str, error: Option<&str>) {
    audit(serde_json::json!({
        "tool": tool,
        "decision": decision,
        "outcome": outcome,
        "path": path,
        "error": error,
    }));
}

#[tauri::command]
pub async fn read_file_content(
    path: String,
    max_lines: Option<usize>,
) -> Result<FileReadResult, String> {
    let result = read_file_inner(&path, max_lines).await;
    match &result {
        Ok(_) => audit_fs("read_file", "completed", &path, "auto_safe", None),
        Err(e) => audit_fs("read_file", "failed", &path, "auto_safe", Some(e)),
    }
    result
}

async fn read_file_inner(path: &str, max_lines: Option<usize>) -> Result<FileReadResult, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("File does not exist: {path}"));
    }

    let meta = fs::metadata(p).await.map_err(|e| e.to_string())?;
    let size_bytes = meta.len();

    let text = fs::read_to_string(p).await.map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    let content = if let Some(limit) = max_lines {
        if limit < total_lines {
            lines[..limit].join("\n")
        } else {
            text
        }
    } else {
        text
    };

    Ok(FileReadResult {
        content,
        total_lines,
        size_bytes,
    })
}

#[tauri::command]
pub async fn write_file_content(
    path: String,
    content: String,
    decision: Option<String>,
) -> Result<FileWriteResult, String> {
    // Trust boundary: a write without a recorded "approved" decision is
    // refused at the native layer, not defaulted to approved.
    let decision = match decision.as_deref() {
        Some("approved") => "approved",
        _ => {
            audit_fs(
                "write_file",
                "blocked",
                &path,
                decision.as_deref().unwrap_or("none"),
                Some("write without recorded approval"),
            );
            return Err(
                "Blocked by policy: file writes require a recorded user approval decision."
                    .to_string(),
            );
        }
    };

    let result = write_file_inner(&path, &content).await;
    match &result {
        Ok(r) => audit(serde_json::json!({
            "tool": "write_file",
            "decision": decision,
            "outcome": "completed",
            "path": r.path,
            "size_bytes": r.size_bytes,
        })),
        Err(e) => audit_fs("write_file", "failed", &path, decision, Some(e)),
    }
    result
}

async fn write_file_inner(path: &str, content: &str) -> Result<FileWriteResult, String> {
    let p = Path::new(path);

    // Create parent directories if missing
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
    }

    // Atomic write: write to temp file then rename
    let tmp_path = format!("{path}.tmp.{}", std::process::id());
    let file_result: Result<(), String> = async {
        let mut file = fs::File::create(&tmp_path).await.map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&tmp_path, p).await.map_err(|e| e.to_string())
    }
    .await;

    file_result?;

    Ok(FileWriteResult {
        path: path.to_string(),
        success: true,
        size_bytes: content.len(),
    })
}

#[tauri::command]
pub async fn list_dir_entries(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let result = list_dir_inner(&path).await;
    match &result {
        Ok(entries) => audit(serde_json::json!({
            "tool": "list_directory",
            "decision": "auto_safe",
            "outcome": "completed",
            "path": path,
            "entry_count": entries.len(),
        })),
        Err(e) => audit_fs("list_directory", "failed", &path, "auto_safe", Some(e)),
    }
    result
}

async fn list_dir_inner(path: &str) -> Result<Vec<DirEntryInfo>, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Directory does not exist: {path}"));
    }

    let mut entries = Vec::new();
    let mut dir = fs::read_dir(p).await.map_err(|e| e.to_string())?;

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        let is_dir = meta.is_dir();
        let is_file = meta.is_file();
        let size = meta.len();
        let entry_path = entry.path().to_string_lossy().to_string();

        entries.push(DirEntryInfo {
            name,
            path: entry_path,
            is_dir,
            is_file,
            size,
        });
    }

    // Sort directories first, then alphabetical
    entries.sort_by(|a, b| {
        if a.is_dir && !b.is_dir {
            std::cmp::Ordering::Less
        } else if !a.is_dir && b.is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(entries)
}

#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let home_dir = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());

    Ok(SystemInfo {
        os,
        arch,
        username,
        cwd,
        home_dir,
    })
}
