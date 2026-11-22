use std::path::Path;
use tokio::fs;
use crate::audit::{record_audit, record_audit_at};
use crate::models::{DirEntryInfo, FileReadResult, FileWriteResult, SystemInfo};
use crate::policy::{audit_path, config_dir};
use crate::proposal::consume_write_proposal;

#[cfg(test)]
#[path = "fs_tests.rs"]
mod tests;

fn audit_fs(log: &Path, tool: &str, outcome: &str, path: &str, decision: &str, error: Option<&str>) {
    let _ = record_audit_at(log, serde_json::json!({
        "tool": tool,
        "decision": decision,
        "outcome": outcome,
        "path": path,
        "error": error,
    }));
}

/// Best-effort screen of a shell command for literal references to the
/// protected governance files, so the shell route cannot read what
/// `read_file_content` refuses. Splits on whitespace, strips quotes, and
/// expands a leading `~`. String screening, not a sandbox: compound or
/// obfuscated forms already require approval scrutiny elsewhere.
pub fn command_touches_protected_path(command: &str) -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    for raw in command.split_whitespace() {
        let token = raw.trim_matches(|c| c == '\'' || c == '"' || c == '`');
        let candidate = if let Some(rest) = token.strip_prefix("~/") {
            format!("{home}/{rest}")
        } else if token == "~" {
            home.clone()
        } else {
            token.to_string()
        };
        if is_protected_path(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// The app's own governance files (API keys, policy, grants, audit log)
/// must never enter model context or be writable by tools — an unrestricted
/// read would otherwise exfiltrate stored credentials, and a write could
/// rewrite the permission boundary itself.
pub fn is_protected_path(path: &str) -> bool {
    is_protected_file(Path::new(path))
}

pub(crate) fn is_protected_file(path: &Path) -> bool {
    let protected = ["config.json", "policy.json", "standing-grants.json", "audit.jsonl"];
    let cfg = config_dir();
    let resolved_cfg = std::fs::canonicalize(&cfg).ok();
    let is_config_file = |candidate: &Path| {
        let (Some(parent), Some(name)) = (candidate.parent(), candidate.file_name()) else {
            return false;
        };
        (parent == cfg || Some(parent) == resolved_cfg.as_deref()) &&
            protected.iter().any(|p| name.eq_ignore_ascii_case(p))
    };
    is_config_file(path) || std::fs::canonicalize(path).is_ok_and(|resolved| is_config_file(&resolved))
}

#[tauri::command]
pub async fn read_file_content(
    path: String,
    max_lines: Option<usize>,
) -> Result<FileReadResult, String> {
    read_file_with_audit(&path, max_lines, &audit_path()).await
}

async fn read_file_with_audit(
    path: &str,
    max_lines: Option<usize>,
    log: &Path,
) -> Result<FileReadResult, String> {
    if is_protected_path(path) {
        let msg = "PROTECTED: this file is part of AnyBot's own configuration and cannot be read by tools.".to_string();
        audit_fs(log, "read_file", "blocked", path, "auto_safe", Some(&msg));
        return Err(msg);
    }
    let result = read_file_inner(path, max_lines).await;
    match &result {
        Ok(_) => audit_fs(log, "read_file", "completed", path, "auto_safe", None),
        Err(e) => audit_fs(log, "read_file", "failed", path, "auto_safe", Some(e)),
    }
    result
}

async fn read_file_inner(path: &str, max_lines: Option<usize>) -> Result<FileReadResult, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("NOT_FOUND: {path}"));
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
    proposal_id: Option<String>,
) -> Result<FileWriteResult, String> {
    write_file_with_audit(&path, &content, decision.as_deref(), proposal_id.as_deref(), &audit_path()).await
}

async fn write_file_with_audit(
    path: &str,
    content: &str,
    _decision: Option<&str>,
    proposal_id: Option<&str>,
    log: &Path,
) -> Result<FileWriteResult, String> {
    // Only a single-use native proposal authorizes an exact write. The
    // renderer's decision string is neither authorization nor audit proof.
    let Some(id) = proposal_id else {
        let error = "Blocked by policy: file writes require an approved single-use proposal token.";
        audit_fs(log, "write_file", "blocked", path, "none", Some(error));
        return Err(error.into());
    };
    let reviewed = consume_write_proposal(id, path, content).inspect_err(|e| {
        let _ = record_audit_at(log, serde_json::json!({
            "tool": "write_file", "decision": "proposal_invalid", "proposal_id": id,
            "outcome": "blocked", "path": path, "error": e,
        }));
    })?;

    let actual_path = reviewed.path().display().to_string();
    let requested = path.to_owned();
    let content = content.to_owned();
    let size_bytes = content.len();
    let result = tokio::task::spawn_blocking(move || reviewed.apply(Path::new(&requested), &content))
        .await.map_err(|e| format!("Reviewed write worker failed: {e}")).and_then(|result| result);
    let _ = record_audit_at(log, serde_json::json!({
        "tool": "write_file",
        "decision": "approved",
        "proposal_id": id,
        "outcome": if result.is_ok() { "completed" } else { "failed" },
        "path": actual_path,
        "size_bytes": result.is_ok().then_some(size_bytes),
        "error": result.as_ref().err(),
    }));
    result.map(|()| FileWriteResult { path: actual_path, success: true, size_bytes })
}

#[tauri::command]
pub async fn list_dir_entries(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let result = list_dir_inner(&path).await;
    match &result {
        Ok(entries) => {
            let _ = record_audit(serde_json::json!({
                "tool": "list_directory",
                "decision": "auto_safe",
                "outcome": "completed",
                "path": path,
                "entry_count": entries.len(),
            }));
        }
        Err(e) => audit_fs(&audit_path(), "list_directory", "failed", &path, "auto_safe", Some(e)),
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
