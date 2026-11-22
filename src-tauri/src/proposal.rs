use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::reviewed_file::ReviewedFile;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let bytes = hasher.finalize();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Process-global monotonic counter: proposal ids must never collide.
/// Two proposals created in the same millisecond previously produced the
/// same id, silently overwriting each other in the registry — one review
/// could then authorize the other's action.
static PROPOSAL_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone)]
enum ProposalAction {
    WriteFile {
        path: String,
        content_sha256: String,
        reviewed: ReviewedFile,
    },
    ExecuteShell {
        command: String,
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct Proposal {
    pub id: String,
    pub run_id: Option<String>,
    action: ProposalAction,
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
    let requested = PathBuf::from(&path);
    let (reviewed, before) = tokio::task::spawn_blocking(move || ReviewedFile::inspect(&requested))
        .await.map_err(|e| format!("Review worker failed: {e}"))??;
    let display_path = reviewed.path().display().to_string();
    let existed = reviewed.existed();
    let content_sha256 = sha256_hex(content.as_bytes());
    let id = format!(
        "prop_w_{}_{:x}_{}",
        now_ms(),
        now_ms() ^ 0x5a5a,
        PROPOSAL_COUNTER.fetch_add(1, Ordering::Relaxed)
    );

    let proposal = Proposal {
        id: id.clone(),
        run_id,
        action: ProposalAction::WriteFile { path, content_sha256, reviewed },
        status: ProposalStatus::Pending,
        created_at: now_ms(),
    };

    PROPOSALS.lock().map_err(|_| "Cannot register write proposal.")?.insert(id.clone(), proposal);

    Ok(WriteProposalView {
        id,
        path: display_path,
        before,
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
    let id = format!(
        "prop_s_{}_{:x}_{}",
        now_ms(),
        now_ms() ^ 0xa5a5,
        PROPOSAL_COUNTER.fetch_add(1, Ordering::Relaxed)
    );

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

/// Consume authorization, then hand the native snapshot to the writer for
/// the disk conflict check after staging. Failed writes need a fresh review.
pub(crate) fn consume_write_proposal(
    proposal_id: &str,
    path: &str,
    content: &str,
) -> Result<ReviewedFile, String> {
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
        ProposalAction::WriteFile { path: p_path, content_sha256: p_sha, reviewed } => {
            if p_path != path {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: write target path does not match reviewed proposal.".to_string());
            }
            if &sha256_hex(content.as_bytes()) != p_sha {
                prop.status = ProposalStatus::Cancelled;
                return Err("Blocked: write content does not match reviewed proposal.".to_string());
            }
            prop.status = ProposalStatus::Consumed;
            Ok(reviewed.clone())
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
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
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

        // Disk conflicts are checked by the writer rather than by the registry.
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
