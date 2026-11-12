use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::commands::fs::is_protected_path;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let bytes = hasher.finalize();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Consumed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProposalAction {
    WriteFile {
        path: String,
        content_sha256: String,
        original_sha256: Option<String>,
        existed: bool,
        before_content: String,
        after_content: String,
    },
    ExecuteShell {
        command: String,
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub run_id: Option<String>,
    pub action: ProposalAction,
    pub status: ProposalStatus,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteProposalView {
    pub id: String,
    pub path: String,
    pub before: String,
    pub after: String,
    pub existed: bool,
    pub status: ProposalStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellProposalView {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub status: ProposalStatus,
}

static PROPOSALS: LazyLock<Mutex<HashMap<String, Proposal>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Create an immutable Write proposal managed by Rust.
/// Reads the disk content natively, computes hashes, and checks protected paths.
#[tauri::command]
pub async fn create_write_proposal(
    path: String,
    content: String,
    run_id: Option<String>,
) -> Result<WriteProposalView, String> {
    if is_protected_path(&path) {
        return Err("PROTECTED: this file is part of AnyBot's own configuration and cannot be modified by tools.".to_string());
    }

    let p = Path::new(&path);
    let (existed, original_sha256, before_content) = if p.exists() {
        let bytes = tokio::fs::read(p).await.map_err(|e| format!("Cannot read file: {e}"))?;
        let hash = sha256_hex(&bytes);
        let text = match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => return Err("Cannot read current file (binary or unreadable encoding). Refusing to propose change.".to_string()),
        };
        (true, Some(hash), text)
    } else {
        (false, None, String::new())
    };

    let content_sha256 = sha256_hex(content.as_bytes());
    let id = format!("prop_w_{}_{:x}", now_ms(), now_ms() ^ 0x5a5a);

    let proposal = Proposal {
        id: id.clone(),
        run_id,
        action: ProposalAction::WriteFile {
            path: path.clone(),
            content_sha256,
            original_sha256,
            existed,
            before_content: before_content.clone(),
            after_content: content.clone(),
        },
        status: ProposalStatus::Pending,
        created_at: now_ms(),
    };

    if let Ok(mut map) = PROPOSALS.lock() {
        map.insert(id.clone(), proposal);
    }

    Ok(WriteProposalView {
        id,
        path,
        before: before_content,
        after: content,
        existed,
        status: ProposalStatus::Pending,
    })
}

/// Create an immutable Shell proposal managed by Rust.
#[tauri::command]
pub async fn create_shell_proposal(
    command: String,
    cwd: Option<String>,
    run_id: Option<String>,
) -> Result<ShellProposalView, String> {
    let id = format!("prop_s_{}_{:x}", now_ms(), now_ms() ^ 0xa5a5);

    let proposal = Proposal {
        id: id.clone(),
        run_id,
        action: ProposalAction::ExecuteShell {
            command: command.clone(),
            cwd: cwd.clone(),
        },
        status: ProposalStatus::Pending,
        created_at: now_ms(),
    };

    if let Ok(mut map) = PROPOSALS.lock() {
        map.insert(id.clone(), proposal);
    }

    Ok(ShellProposalView {
        id,
        command,
        cwd,
        status: ProposalStatus::Pending,
    })
}

/// User explicitly approves the proposal. Only Pending proposals can be approved.
#[tauri::command]
pub fn approve_proposal(proposal_id: String) -> Result<bool, String> {
    let mut map = PROPOSALS.lock().map_err(|e| e.to_string())?;
    let prop = map.get_mut(&proposal_id).ok_or_else(|| "Proposal not found".to_string())?;
    if prop.status != ProposalStatus::Pending {
        return Err(format!("Cannot approve proposal in {:?} status", prop.status));
    }
    prop.status = ProposalStatus::Approved;
    Ok(true)
}

/// User explicitly declines/rejects the proposal. Only Pending proposals can be rejected.
#[tauri::command]
pub fn reject_proposal(proposal_id: String) -> Result<bool, String> {
    let mut map = PROPOSALS.lock().map_err(|e| e.to_string())?;
    let prop = map.get_mut(&proposal_id).ok_or_else(|| "Proposal not found".to_string())?;
    if prop.status != ProposalStatus::Pending {
        return Err(format!("Cannot reject proposal in {:?} status", prop.status));
    }
    prop.status = ProposalStatus::Rejected;
    Ok(true)
}

/// Cancel proposal (e.g. on Stop or task abort).
#[tauri::command]
pub fn cancel_proposal(proposal_id: String) -> Result<bool, String> {
    let mut map = PROPOSALS.lock().map_err(|e| e.to_string())?;
    if let Some(prop) = map.get_mut(&proposal_id) {
        prop.status = ProposalStatus::Cancelled;
        return Ok(true);
    }
    Ok(false)
}

/// Validate and single-use consume an approved write proposal.
/// Checks:
///   1. Proposal exists and is Approved
///   2. Target path and content SHA256 match the proposal
///   3. Native disk conflict check: file still matches original_sha256
pub fn consume_write_proposal(
    proposal_id: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    let mut map = PROPOSALS.lock().map_err(|e| e.to_string())?;
    let prop = map.get_mut(proposal_id).ok_or_else(|| {
        "Blocked: proposal token not found in native registry.".to_string()
    })?;

    if prop.status != ProposalStatus::Approved {
        return Err(format!(
            "Blocked: proposal token is not in Approved status (status: {:?}).",
            prop.status
        ));
    }

    match &prop.action {
        ProposalAction::WriteFile {
            path: p_path,
            content_sha256: p_sha,
            original_sha256,
            existed,
            ..
        } => {
            if p_path != path {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: write target path does not match reviewed proposal.".to_string());
            }
            let given_sha = sha256_hex(content.as_bytes());
            if &given_sha != p_sha {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: write content does not match reviewed proposal.".to_string());
            }

            // Disk conflict check natively:
            let disk_path = Path::new(path);
            if *existed {
                if !disk_path.exists() {
                    prop.status = ProposalStatus::Cancelled;
                    return Err("Conflict: file was deleted on disk after review. Proposal cancelled.".to_string());
                }
                let current_bytes = std::fs::read(disk_path).map_err(|e| e.to_string())?;
                let current_sha = sha256_hex(&current_bytes);
                if Some(&current_sha) != original_sha256.as_ref() {
                    prop.status = ProposalStatus::Cancelled;
                    return Err("Conflict: file was modified on disk after review. Proposal cancelled to prevent overwriting changes.".to_string());
                }
            } else if disk_path.exists() {
                prop.status = ProposalStatus::Cancelled;
                return Err("Conflict: file was created on disk after proposal was prepared. Proposal cancelled.".to_string());
            }

            // Single use: mark consumed
            prop.status = ProposalStatus::Consumed;
            Ok(())
        }
        _ => Err("Blocked: proposal action mismatch (expected WriteFile).".to_string()),
    }
}

/// Validate and single-use consume an approved shell proposal.
pub fn consume_shell_proposal(
    proposal_id: &str,
    command: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    let mut map = PROPOSALS.lock().map_err(|e| e.to_string())?;
    let prop = map.get_mut(proposal_id).ok_or_else(|| {
        "Blocked: proposal token not found in native registry.".to_string()
    })?;

    if prop.status != ProposalStatus::Approved {
        return Err(format!(
            "Blocked: proposal token is not in Approved status (status: {:?}).",
            prop.status
        ));
    }

    match &prop.action {
        ProposalAction::ExecuteShell {
            command: p_cmd,
            cwd: p_cwd,
        } => {
            if p_cmd.trim() != command.trim() {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: command does not match reviewed proposal.".to_string());
            }
            if p_cwd.as_deref() != cwd {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: working directory does not match reviewed proposal.".to_string());
            }

            // Single use: mark consumed
            prop.status = ProposalStatus::Consumed;
            Ok(())
        }
        _ => Err("Blocked: proposal action mismatch (expected ExecuteShell).".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_proposal_lifecycle() {
        let dir = std::env::temp_dir().join(format!("anybot-prop-test-{}", now_ms()));
        let _ = std::fs::create_dir_all(&dir);
        let file_path = dir.join("test.txt");
        let path_str = file_path.to_string_lossy().to_string();

        // 1. Initial write proposal (file doesn't exist)
        let prop = create_write_proposal(path_str.clone(), "hello world".to_string(), None)
            .await
            .unwrap();
        assert_eq!(prop.existed, false);
        assert_eq!(prop.status, ProposalStatus::Pending);

        // Cannot consume before approval
        let err = consume_write_proposal(&prop.id, &path_str, "hello world").unwrap_err();
        assert!(err.contains("not in Approved status"));

        // Approve
        assert!(approve_proposal(prop.id.clone()).unwrap());

        // Tampered content cannot be consumed
        let err = consume_write_proposal(&prop.id, &path_str, "tampered content").unwrap_err();
        assert!(err.contains("content does not match"));

        // Re-create proposal for valid consume
        let prop2 = create_write_proposal(path_str.clone(), "hello world".to_string(), None)
            .await
            .unwrap();
        approve_proposal(prop2.id.clone()).unwrap();

        // Valid consume succeeds
        assert!(consume_write_proposal(&prop2.id, &path_str, "hello world").is_ok());

        // Single-use: second consume fails
        let err = consume_write_proposal(&prop2.id, &path_str, "hello world").unwrap_err();
        assert!(err.contains("not in Approved status"));

        // Conflict check: now write file on disk
        std::fs::write(&file_path, "modified on disk by another process").unwrap();
        let prop3 = create_write_proposal(path_str.clone(), "next write".to_string(), None)
            .await
            .unwrap();
        approve_proposal(prop3.id.clone()).unwrap();

        // Change disk content again before consume
        std::fs::write(&file_path, "modified again secretly").unwrap();
        let err = consume_write_proposal(&prop3.id, &path_str, "next write").unwrap_err();
        assert!(err.contains("Conflict: file was modified on disk after review"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_shell_proposal_lifecycle() {
        let prop = create_shell_proposal("npm install".to_string(), Some("/tmp".to_string()), None)
            .await
            .unwrap();
        assert_eq!(prop.status, ProposalStatus::Pending);

        // Cannot consume while pending
        assert!(consume_shell_proposal(&prop.id, "npm install", Some("/tmp")).is_err());

        // Approve
        approve_proposal(prop.id.clone()).unwrap();

        // Cwd or cmd mismatch fails
        assert!(consume_shell_proposal(&prop.id, "npm install", Some("/var")).is_err());

        // Re-create and consume
        let prop2 = create_shell_proposal("npm test".to_string(), None, None).await.unwrap();
        approve_proposal(prop2.id.clone()).unwrap();
        assert!(consume_shell_proposal(&prop2.id, "npm test", None).is_ok());

        // Cannot re-use
        assert!(consume_shell_proposal(&prop2.id, "npm test", None).is_err());
    }
}
