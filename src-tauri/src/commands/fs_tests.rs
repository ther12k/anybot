use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::{read_file_with_audit, write_file_with_audit};
use crate::audit::{AUDIT_GENESIS, AuditStatus, has_audit_recording_failure, verify_audit_file};
use crate::models::FileWriteResult;
use crate::proposal::{ProposalStatus, WriteProposalView, approve_proposal, create_write_proposal};

struct Fixture {
    _temp: TempDir,
    workspace: PathBuf,
    log: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("create isolated test root");
        let root = temp.path().canonicalize().expect("resolve test root");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).expect("create test workspace");
        let log = root.join("audit.jsonl");
        Self {
            _temp: temp,
            workspace,
            log,
        }
    }
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("fixture path must be UTF-8")
}

async fn approve_edit(path: &Path, before: &str, after: &str) -> WriteProposalView {
    let proposal = create_write_proposal(path_str(path).into(), after.into(), None)
        .await
        .expect("prepare native review");
    assert_eq!(proposal.status, ProposalStatus::Pending);
    assert!(proposal.existed);
    assert_eq!(proposal.path, path_str(path));
    assert_eq!(proposal.before.as_bytes(), before.as_bytes());
    assert_eq!(proposal.after.as_bytes(), after.as_bytes());
    assert!(approve_proposal(proposal.id.clone()).expect("approve native review"));
    proposal
}

async fn apply(proposal: &WriteProposalView, log: &Path) -> Result<FileWriteResult, String> {
    write_file_with_audit(
        &proposal.path,
        &proposal.after,
        None,
        Some(&proposal.id),
        log,
    )
    .await
}

fn verified_rows(log: &Path, expected_count: usize) -> Vec<Value> {
    let contents = fs::read_to_string(log).expect("read persisted native audit log");
    let rows: Vec<Value> = contents
        .lines()
        .map(|line| serde_json::from_str(line).expect("audit row must be valid JSON"))
        .collect();
    assert_eq!(
        rows.len(),
        expected_count,
        "unexpected audit rows: {rows:?}"
    );

    let verification = verify_audit_file(log);
    assert_eq!(verification.status, AuditStatus::Consistent);
    assert_eq!(verification.total_rows, expected_count);
    assert_eq!(verification.hashed_rows, expected_count);
    assert_eq!(verification.legacy_rows, 0);
    assert_eq!(rows[0]["prev_hash"], AUDIT_GENESIS);
    assert_eq!(
        verification.tip_hash.as_deref(),
        rows.last().and_then(|row| row["hash"].as_str()),
    );
    rows
}

fn assert_event(row: &Value, tool: &str, outcome: &str, path: &Path) {
    assert_eq!(row["tool"], tool, "unexpected audit row: {row}");
    assert_eq!(row["outcome"], outcome, "unexpected audit row: {row}");
    assert_eq!(row["path"], path_str(path), "unexpected audit row: {row}");
}

fn assert_conflict(row: &Value, path: &Path, proposal_id: &str, error: &str) {
    assert!(
        error.starts_with("Conflict:"),
        "expected a conflict, got {error}"
    );
    assert_event(row, "write_file", "failed", path);
    assert_eq!(row["proposal_id"], proposal_id);
    assert_eq!(row["error"], error);
}

#[tokio::test]
async fn approved_edit_is_visible_on_disk_in_files_and_in_audit_then_cannot_be_replayed() {
    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let before = "Résumé\r\nDraft notes\r\n";
    let after = "Résumé\r\nRévision finale\r\n";
    fs::write(&path, before).unwrap();

    // The UI displays the resolved path but submits the original request.
    #[cfg(unix)]
    let requested = format!("{}/./notes.txt", path_str(&fixture.workspace));
    #[cfg(not(unix))]
    let requested = path_str(&path).to_owned();
    let proposal = create_write_proposal(requested.clone(), after.into(), None)
        .await
        .expect("prepare native review");
    assert_eq!(proposal.path, path_str(&path));
    assert_eq!(proposal.before.as_bytes(), before.as_bytes());
    assert_eq!(proposal.after.as_bytes(), after.as_bytes());
    assert!(approve_proposal(proposal.id.clone()).unwrap());
    assert_eq!(fs::read(&path).unwrap(), before.as_bytes());

    let result = write_file_with_audit(&requested, after, None, Some(&proposal.id), &fixture.log)
        .await
        .expect("apply approved review");
    assert!(result.success);
    assert_eq!(result.path, path_str(&path));
    assert_eq!(result.size_bytes, after.len());
    assert_eq!(fs::read(&path).unwrap(), after.as_bytes());

    // The Files page uses this native reader with a line limit.
    let preview = read_file_with_audit(path_str(&path), Some(2), &fixture.log)
        .await
        .expect("read applied bytes through Files reader");
    assert_eq!(preview.content.as_bytes(), after.as_bytes());
    assert_eq!(preview.total_lines, 2);
    assert_eq!(preview.size_bytes, after.len() as u64);

    let initial = verified_rows(&fixture.log, 2);
    assert_event(&initial[0], "write_file", "completed", &path);
    assert_eq!(initial[0]["proposal_id"], proposal.id.as_str());
    assert_eq!(initial[0]["size_bytes"].as_u64(), Some(after.len() as u64));
    assert_event(&initial[1], "read_file", "completed", &path);

    let replay = write_file_with_audit(&requested, after, None, Some(&proposal.id), &fixture.log)
        .await
        .expect_err("replaying the same approval must be blocked");
    assert!(replay.contains("Consumed"), "{replay}");
    assert_eq!(fs::read(&path).unwrap(), after.as_bytes());
    let rows = verified_rows(&fixture.log, 3);
    assert_eq!(&rows[..2], initial.as_slice());
    assert_event(&rows[2], "write_file", "blocked", Path::new(&requested));
    assert_eq!(rows[2]["proposal_id"], proposal.id.as_str());
}

#[tokio::test]
async fn an_unrecorded_write_still_reports_the_applied_edit() {
    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let before = "status: draft\n";
    let after = "status: reviewed\n";
    fs::write(&path, before).unwrap();
    let proposal = approve_edit(&path, before, after).await;

    // A directory at the log path makes append fail regardless of uid.
    fs::create_dir(&fixture.log).unwrap();
    let result = apply(&proposal, &fixture.log)
        .await
        .expect("edit still applied");
    assert!(result.success);
    assert_eq!(fs::read(&path).unwrap(), after.as_bytes());
    assert!(has_audit_recording_failure());
    assert_eq!(
        verify_audit_file(&fixture.log).status,
        AuditStatus::Unreadable
    );
}

#[tokio::test]
async fn external_save_before_apply_is_preserved_and_audited_as_a_conflict() {
    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let before = "status: draft\n";
    fs::write(&path, before).unwrap();
    let proposal = approve_edit(&path, before, "status: reviewed\n").await;

    // An ordinary save with different bytes but the same size as the reviewed file.
    let external = "status: local\n";
    fs::write(&path, external).unwrap();

    let error = apply(&proposal, &fixture.log)
        .await
        .expect_err("a stale approved edit must not overwrite the saved file");
    assert_eq!(fs::read(&path).unwrap(), external.as_bytes());
    let rows = verified_rows(&fixture.log, 1);
    assert_conflict(&rows[0], &path, &proposal.id, &error);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_one_concurrent_approval_for_the_same_snapshot_applies() {
    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let before = "Shared review base\n";
    fs::write(&path, before).unwrap();
    let first = approve_edit(&path, before, "First reviewed change\n").await;
    let second = approve_edit(&path, before, "Second reviewed change\n").await;
    assert_ne!(first.id, second.id);

    // Both approvals exist before either write can start. Neither winner nor
    // audit ordering is prescribed by how the tasks are scheduled.
    let start = Arc::new(Barrier::new(2));
    let launch = |proposal: WriteProposalView| {
        let start = Arc::clone(&start);
        let log = fixture.log.clone();
        tokio::spawn(async move {
            start.wait().await;
            apply(&proposal, &log).await
        })
    };
    let first_task = launch(first.clone());
    let second_task = launch(second.clone());
    let (first_result, second_result) = tokio::join!(first_task, second_task);
    let (winner, loser, written, conflict) = match (first_result.unwrap(), second_result.unwrap()) {
        (Ok(written), Err(conflict)) => (&first, &second, written, conflict),
        (Err(conflict), Ok(written)) => (&second, &first, written, conflict),
        (first_result, second_result) => {
            panic!(
                "expected one applied edit and one conflict, got {first_result:?} and {second_result:?}"
            );
        }
    };
    assert!(written.success);
    assert_eq!(fs::read(&path).unwrap(), winner.after.as_bytes());

    let rows = verified_rows(&fixture.log, 2);
    let completed = rows
        .iter()
        .find(|row| row["outcome"] == "completed")
        .expect("winning write must appear in audit");
    assert_event(completed, "write_file", "completed", &path);
    assert_eq!(completed["proposal_id"], winner.id.as_str());
    let failed = rows
        .iter()
        .find(|row| row["outcome"] != "completed")
        .expect("conflicting write must appear in audit");
    assert_conflict(failed, &path, &loser.id, &conflict);
}

#[tokio::test]
async fn directory_is_not_reviewable_or_readable_as_a_file() {
    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes");
    fs::create_dir(&path).unwrap();

    create_write_proposal(path_str(&path).into(), "new notes\n".into(), None)
        .await
        .expect_err("write proposals must not target directories");
    read_file_with_audit(path_str(&path), None, &fixture.log)
        .await
        .expect_err("file preview must not treat a directory as a file");
    assert!(path.is_dir());

    let rows = verified_rows(&fixture.log, 1);
    assert_event(&rows[0], "read_file", "failed", &path);
}

#[cfg(unix)]
#[tokio::test]
async fn ordinary_symlink_is_refused_for_write_review() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let link = fixture.workspace.join("shortcut.txt");
    fs::write(&path, b"original notes\n").unwrap();
    symlink(&path, &link).unwrap();

    create_write_proposal(path_str(&link).into(), "new notes\n".into(), None)
        .await
        .expect_err("a symlink is not a regular file for write review");
    assert_eq!(fs::read_link(&link).unwrap(), path);
    assert_eq!(fs::read(&path).unwrap(), b"original notes\n");
}

#[cfg(unix)]
#[tokio::test]
async fn read_only_file_is_refused_for_write_review() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    fs::write(&path, b"original notes\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

    create_write_proposal(path_str(&path).into(), "new notes\n".into(), None)
        .await
        .expect_err("read-only files must not be offered for overwrite");
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    assert_eq!(fs::read(&path).unwrap(), b"original notes\n");
}

#[cfg(unix)]
#[tokio::test]
async fn approved_edit_preserves_unix_file_mode() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let path = fixture.workspace.join("notes.txt");
    let before = "draft\n";
    let after = "revised\n";
    fs::write(&path, before).unwrap();
    let mode = 0o750;
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();

    let proposal = approve_edit(&path, before, after).await;
    apply(&proposal, &fixture.log)
        .await
        .expect("apply approved edit to regular file");

    assert_eq!(fs::read(&path).unwrap(), after.as_bytes());
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        mode
    );
}
