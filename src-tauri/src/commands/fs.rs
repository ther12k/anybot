use std::path::{Path, PathBuf};
use tauri::WebviewWindow;
use tokio::{fs, io::AsyncReadExt};
use crate::audit::record_audit_at;
use crate::models::{DirEntryInfo, FileReadResult, FileWriteResult, SystemInfo};
use crate::policy::{audit_path, config_dir};
use crate::proposal::consume_write_proposal;
use crate::workspace::{self, Access, Grant, RunScope, Tool};

#[cfg(test)]
#[path = "fs_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "workspace_fs_tests.rs"]
mod workspace_tests;

/// One audit row for a file tool. An installation is named so the log shows
/// which bot acted; the owner's own browsing carries none.
fn audit_fs(log: &Path, installation_id: Option<&str>, tool: &str, outcome: &str, path: &str, decision: &str, error: Option<&str>) {
    let _ = record_audit_at(log, serde_json::json!({
        "tool": tool,
        "decision": decision,
        "outcome": outcome,
        "path": path,
        "error": error,
        "installation_id": installation_id,
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

/// The app's own governance files (API keys, policy, grants, audit log, and
/// the workspaces that say what bots may touch) must never enter model
/// context or be writable by tools — an unrestricted read would otherwise
/// exfiltrate stored credentials, and a write could rewrite the permission
/// boundary itself.
pub fn is_protected_path(path: &str) -> bool {
    is_protected_file(Path::new(path))
}

pub(crate) fn is_protected_file(path: &Path) -> bool {
    is_protected_file_in(path, &config_dir())
}

fn is_protected_file_in(path: &Path, cfg: &Path) -> bool {
    let protected = [
        "config.json", "policy.json", "standing-grants.json", "audit.jsonl", "workspaces.json",
    ];
    let resolved_cfg = std::fs::canonicalize(cfg).ok();
    let is_config_file = |candidate: &Path| {
        let (Some(parent), Some(name)) = (candidate.parent(), candidate.file_name()) else {
            return false;
        };
        protected.iter().any(|p| name.eq_ignore_ascii_case(p)) &&
            (parent == cfg || resolved_cfg.as_ref().is_some_and(|resolved_cfg| {
                parent == resolved_cfg || std::fs::canonicalize(parent).is_ok_and(|dir| dir == *resolved_cfg)
            }))
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

#[tauri::command]
pub async fn workspace_read_file(
    window: WebviewWindow,
    handle: String,
    path: String,
    max_lines: Option<usize>,
) -> Result<FileReadResult, String> {
    workspace::require_owner_window(&window)?;
    workspace_read_file_at(&workspace::registry_path(), &handle, &path, max_lines, &audit_path()).await
}

fn scoped_read_target(
    registry: &Path,
    handle: &str,
    requested: &str,
    capability: Tool,
    log: &Path,
    tool_name: &str,
) -> Result<(PathBuf, String), String> {
    workspace::with_run_grant(registry, handle, capability, |scope, grant, _| {
        let installation_id = scope.installation_id();
        let expanded = workspace::expand_tilde(requested)?;
        let target = grant.check_read_path(&expanded).inspect_err(|error| {
            audit_fs(log, Some(installation_id), tool_name, "blocked", requested, "blocked_scope", Some(error));
        })?;
        if capability == Tool::ReadFile && is_protected_file(&expanded) {
            audit_fs(log, Some(installation_id), tool_name, "blocked", requested, "auto_safe", Some(PROTECTED_READ));
            return Err(PROTECTED_READ.into());
        }
        Ok((target, installation_id.to_owned()))
    })
}

async fn workspace_read_file_at(
    registry: &Path,
    handle: &str,
    path: &str,
    max_lines: Option<usize>,
    log: &Path,
) -> Result<FileReadResult, String> {
    let (target, installation_id) = scoped_read_target(registry, handle, path, Tool::ReadFile, log, "read_file")?;
    read_target_with_audit(path, &target, max_lines, Some(&installation_id), log).await
}

async fn read_file_with_audit(path: &str, max_lines: Option<usize>, log: &Path) -> Result<FileReadResult, String> {
    read_target_with_audit(path, Path::new(path), max_lines, None, log).await
}

const PROTECTED_READ: &str = "PROTECTED: this file is part of AnyBot's own configuration and cannot be read by tools.";

async fn read_target_with_audit(
    requested: &str,
    target: &Path,
    max_lines: Option<usize>,
    installation_id: Option<&str>,
    log: &Path,
) -> Result<FileReadResult, String> {
    // Check the resolved target, not only the renderer's spelling (which
    // might contain ~ or a symlink). Canonicalization is not an OS sandbox.
    if is_protected_file(target) {
        audit_fs(log, installation_id, "read_file", "blocked", requested, "auto_safe", Some(PROTECTED_READ));
        return Err(PROTECTED_READ.into());
    }
    let result = read_file_inner(target, max_lines, installation_id.is_some()).await;
    match &result {
        Ok(_) => audit_fs(log, installation_id, "read_file", "completed", requested, "auto_safe", None),
        Err(e) => audit_fs(log, installation_id, "read_file", "failed", requested, "auto_safe", Some(e)),
    }
    result
}

async fn read_file_inner(path: &Path, max_lines: Option<usize>, scoped: bool) -> Result<FileReadResult, String> {
    if !path.exists() {
        return Err(format!("NOT_FOUND: {}", path.display()));
    }

    let meta = fs::metadata(path).await.map_err(|e| e.to_string())?;
    if scoped && !meta.is_file() {
        return Err("Only regular files can be read by workspace tools.".into());
    }
    let size_bytes = meta.len();

    let text = if scoped {
        let file = fs::File::open(path).await.map_err(|e| e.to_string())?;
        read_workspace_text(file).await?
    } else {
        fs::read_to_string(path).await.map_err(|e| e.to_string())?
    };
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

async fn read_workspace_text(reader: impl tokio::io::AsyncRead + Unpin) -> Result<String, String> {
    let mut bytes = Vec::new();
    // Read one extra byte to distinguish a full-size file from an oversized one.
    // The bound holds even if file size metadata understates the bytes available.
    reader
        .take(workspace::MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("Cannot read workspace file: {e}"))?;
    if bytes.len() > workspace::MAX_TEXT_BYTES {
        return Err(format!(
            "File exceeds the {} MiB workspace read limit. Open a smaller file.",
            workspace::MAX_TEXT_MIB
        ));
    }
    String::from_utf8(bytes).map_err(|_| "Workspace file reads require UTF-8 text.".into())
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

#[tauri::command]
pub async fn workspace_write_file(
    window: WebviewWindow,
    handle: String,
    path: String,
    content: String,
    proposal_id: String,
) -> Result<FileWriteResult, String> {
    workspace::require_owner_window(&window)?;
    let registry = workspace::registry_path();
    let log = audit_path();
    tokio::task::spawn_blocking(move || workspace_write_file_at(&registry, &handle, &path, &content, &proposal_id, &log))
        .await.map_err(|e| format!("Reviewed write worker failed: {e}"))?
}

fn workspace_write_file_at(
    registry: &Path,
    handle: &str,
    path: &str,
    content: &str,
    proposal_id: &str,
    log: &Path,
) -> Result<FileWriteResult, String> {
    workspace::with_run_grant(registry, handle, Tool::WriteFile, |scope, grant, _| {
        workspace::check_write_content_size(content).inspect_err(|error| {
            audit_fs(log, Some(scope.installation_id()), "write_file", "blocked", path, "blocked_limit", Some(error));
        })?;
        write_file_at(path, content, Some(proposal_id), Some((scope, grant)), log)
    })
}

async fn write_file_with_audit(
    path: &str,
    content: &str,
    _decision: Option<&str>,
    proposal_id: Option<&str>,
    log: &Path,
) -> Result<FileWriteResult, String> {
    let (path, content, proposal_id, log) = (path.to_owned(), content.to_owned(), proposal_id.map(str::to_owned), log.to_owned());
    tokio::task::spawn_blocking(move || write_file_at(&path, &content, proposal_id.as_deref(), None, &log))
        .await.map_err(|e| format!("Reviewed write worker failed: {e}"))?
}

fn write_file_at(
    path: &str,
    content: &str,
    proposal_id: Option<&str>,
    workspace_scope: Option<(&RunScope, &Grant<'_>)>,
    log: &Path,
) -> Result<FileWriteResult, String> {
    let installation_id = workspace_scope.map(|(scope, _)| scope.installation_id());
    // Only a single-use native proposal authorizes an exact write. The
    // legacy renderer decision is neither authorization nor audit proof.
    let Some(id) = proposal_id else {
        let error = "Blocked by policy: file writes require an approved single-use proposal token.";
        audit_fs(log, installation_id, "write_file", "blocked", path, "none", Some(error));
        return Err(error.into());
    };
    let reviewed = consume_write_proposal(id, path, content, workspace_scope.map(|(scope, _)| scope))
        .inspect_err(|error| {
            let _ = record_audit_at(log, serde_json::json!({
                "tool": "write_file", "decision": "proposal_invalid", "proposal_id": id,
                "outcome": "blocked", "path": path, "error": error, "installation_id": installation_id,
            }));
        })?;
    let requested = if let Some((_, grant)) = workspace_scope {
        grant.check_resolved_path(reviewed.path(), Access::ReadWrite).inspect_err(|error| {
            audit_fs(log, installation_id, "write_file", "blocked", path, "blocked_scope", Some(error));
        })?;
        workspace::expand_tilde(path)?
    } else {
        PathBuf::from(path)
    };

    // Apply resolves the same expanded request again and requires the exact
    // reviewed target/parent, while retaining final-component link checks.
    let actual_path = reviewed.path().display().to_string();
    let size_bytes = content.len();
    let result = reviewed.apply(&requested, content);
    let _ = record_audit_at(log, serde_json::json!({
        "tool": "write_file",
        "decision": "approved",
        "proposal_id": id,
        "outcome": if result.is_ok() { "completed" } else { "failed" },
        "path": actual_path,
        "size_bytes": result.is_ok().then_some(size_bytes),
        "error": result.as_ref().err(),
        "installation_id": installation_id,
    }));
    result.map(|()| FileWriteResult { path: actual_path, success: true, size_bytes })
}

#[tauri::command]
pub async fn list_dir_entries(path: String) -> Result<Vec<DirEntryInfo>, String> {
    list_target_with_audit(&path, Path::new(&path), None, &audit_path()).await
}

#[tauri::command]
pub async fn workspace_list_directory(window: WebviewWindow, handle: String, path: String) -> Result<Vec<DirEntryInfo>, String> {
    workspace::require_owner_window(&window)?;
    workspace_list_directory_at(&workspace::registry_path(), &handle, &path, &audit_path()).await
}

async fn workspace_list_directory_at(
    registry: &Path,
    handle: &str,
    path: &str,
    log: &Path,
) -> Result<Vec<DirEntryInfo>, String> {
    let (target, installation_id) = scoped_read_target(registry, handle, path, Tool::ListDirectory, log, "list_directory")?;
    list_target_with_audit(path, &target, Some(&installation_id), log).await
}

async fn list_target_with_audit(path: &str, target: &Path, installation_id: Option<&str>, log: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let result = list_dir_inner(target, installation_id.is_some()).await;
    match &result {
        Ok(entries) => {
            let _ = record_audit_at(log, serde_json::json!({
                "tool": "list_directory",
                "decision": "auto_safe",
                "outcome": "completed",
                "path": path,
                "entry_count": entries.len(),
                "installation_id": installation_id,
            }));
        }
        Err(e) => audit_fs(log, installation_id, "list_directory", "failed", path, "auto_safe", Some(e)),
    }
    result
}

async fn list_dir_inner(path: &Path, scoped: bool) -> Result<Vec<DirEntryInfo>, String> {
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", path.display()));
    }

    let mut entries = Vec::new();
    let mut dir = fs::read_dir(path).await.map_err(|e| e.to_string())?;

    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        if scoped && entries.len() == workspace::MAX_DIRECTORY_ENTRIES {
            return Err(format!(
                "Folder exceeds the workspace listing limit of {} entries. List a smaller subfolder.",
                workspace::MAX_DIRECTORY_ENTRIES
            ));
        }
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
