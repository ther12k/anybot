use super::*;
use serde_json::json;
use std::fs;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    log: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("audit.jsonl");
        Self { _temp: temp, log }
    }

    fn append(&self, row: Value) {
        audit_into(&self.log, row).unwrap();
    }

    fn append_three_reads(&self) -> Vec<String> {
        for n in 1..=3 {
            self.append(json!({"tool": "read_file", "outcome": "completed", "n": n}));
        }
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn verify(&self) -> AuditVerification {
        verify_audit_file(&self.log)
    }
}

#[test]
fn missing_empty_and_unreadable_logs_are_distinct() {
    let fixture = Fixture::new();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Missing);
    assert_eq!(report.total_rows, 0);
    assert!(!fixture.log.exists());
    for contents in ["", " \n\t\r\n"] {
        fs::write(&fixture.log, contents).unwrap();
        let report = fixture.verify();
        assert_eq!(report.status, AuditStatus::Empty);
        assert_eq!(report.total_rows, 0);
        assert!(report.recent.is_empty());
    }

    fs::remove_file(&fixture.log).unwrap();
    fs::create_dir(&fixture.log).unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Unreadable);
    assert_eq!(report.first_break, None);
    assert!(report.recent.is_empty());
}

#[test]
fn audit_chain_links_and_verifies() {
    let fixture = Fixture::new();
    let lines = fixture.append_three_reads();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.total_rows, 3);
    assert_eq!(report.hashed_rows, 3);
    assert_eq!(report.legacy_rows, 0);
    let first: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(first["prev_hash"], AUDIT_GENESIS);
    assert!(is_audit_timestamp(first["ts"].as_str().unwrap()));
    let tail: Value = serde_json::from_str(&lines[2]).unwrap();
    assert_eq!(report.tip_hash.as_deref(), tail["hash"].as_str());
}

#[test]
fn previously_hashed_records_still_verify_and_can_be_extended() {
    let fixture = Fixture::new();
    // Expected SHA-256 from the original canonical JSON payload format.
    let old_hash = "99af17472e6a05e15322c5de64503575669fde7e0c5165a1508803e19cb6c811";
    fs::write(&fixture.log, format!(r#"{{"ts":"2026-11-21T09:15:32.123Z","decision":"auto_safe","hash":"{old_hash}","tool":"read_file","prev_hash":"GENESIS","outcome":"completed"}}"#)).unwrap();
    assert_eq!(fixture.verify().status, AuditStatus::Consistent);
    fixture.append(json!({"tool": "write_file", "outcome": "completed"}));
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.hashed_rows, 2);
}

#[test]
fn changed_middle_row_breaks_chain_and_hides_activity() {
    let fixture = Fixture::new();
    let mut lines = fixture.append_three_reads();
    lines[1] = lines[1].replace("\"n\":2", "\"n\":9");
    fs::write(&fixture.log, lines.join("\n") + "\n").unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Broken);
    assert_eq!(report.first_break, Some(2));
    assert_eq!(report.hashed_rows, 1);
    assert!(report.recent.is_empty());
}

#[test]
fn deleted_middle_row_breaks_chain() {
    let fixture = Fixture::new();
    let lines = fixture.append_three_reads();
    fs::write(&fixture.log, format!("{}\n{}\n", lines[0], lines[2])).unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Broken);
    assert_eq!(report.first_break, Some(2));
}

#[test]
fn malformed_records_are_not_missing_or_legacy() {
    let fixture = Fixture::new();
    for contents in [
        b"{invalid JSON\n".as_slice(),
        b"{\"ts\":\"\xff\"}\n",
        b"[]\n",
        b"{\"hash\":null}\n",
        b"{\"prev_hash\":\"GENESIS\"}\n",
    ] {
        fs::write(&fixture.log, contents).unwrap();
        let report = fixture.verify();
        assert_eq!(report.status, AuditStatus::Broken);
        assert_eq!(report.first_break, Some(1));
        assert_eq!(report.legacy_rows, 0);
        assert!(report.recent.is_empty());
    }
}

#[test]
fn legacy_prefix_is_counted_but_not_shown_as_checked_activity() {
    let fixture = Fixture::new();
    // Also support an intact legacy record without a final newline.
    fs::write(
        &fixture.log,
        b"{\"tool\":\"read_file\",\"outcome\":\"completed\"}",
    )
    .unwrap();
    let legacy = fixture.verify();
    assert_eq!(legacy.status, AuditStatus::LegacyOnly);
    assert_eq!(legacy.legacy_rows, 1);
    assert_eq!(legacy.hashed_rows, 0);
    assert!(legacy.recent.is_empty());

    fixture.append(json!({"tool": "write_file", "outcome": "completed"}));
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.total_rows, 2);
    assert_eq!(report.legacy_rows, 1);
    assert_eq!(report.hashed_rows, 1);
    assert_eq!(
        report
            .recent
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [2]
    );
}

#[test]
fn legacy_row_after_chain_is_a_break() {
    let fixture = Fixture::new();
    let lines = fixture.append_three_reads();
    fs::write(
        &fixture.log,
        format!("{}\n{{\"tool\":\"read_file\"}}\n", lines[0]),
    )
    .unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Broken);
    assert_eq!(report.first_break, Some(2));
}

#[test]
fn partial_tail_breaks_chain_but_whole_removed_records_are_not_detected() {
    let fixture = Fixture::new();
    let lines = fixture.append_three_reads();
    fs::write(
        &fixture.log,
        format!("{}\n{}\n{}", lines[0], lines[1], &lines[2][..16]),
    )
    .unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Broken);
    assert_eq!(report.first_break, Some(3));
    assert!(report.recent.is_empty());
    fs::write(&fixture.log, format!("{}\n{}\n", lines[0], lines[1])).unwrap();
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.hashed_rows, 2);
}

#[test]
fn rotation_restarts_from_genesis_not_the_stale_tip() {
    let fixture = Fixture::new();
    fixture.append(json!({"tool": "read_file", "outcome": "completed"}));
    fs::rename(&fixture.log, fixture.log.with_extension("old")).unwrap();
    fixture.append(json!({"tool": "read_file", "outcome": "failed"}));
    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.hashed_rows, 1);
}

#[test]
fn append_reports_unwritable_storage_and_does_not_extend_a_broken_log() {
    let fixture = Fixture::new();
    let blocked_parent = fixture.log.with_extension("file");
    fs::write(&blocked_parent, b"not a directory").unwrap();
    let log_inside_file = blocked_parent.join("audit.jsonl");
    let event = json!({"tool": "read_file", "outcome": "failed"});
    assert!(audit_into(&log_inside_file, event.clone()).is_err());
    assert_eq!(
        verify_audit_file(&log_inside_file).status,
        AuditStatus::Unreadable
    );
    assert_eq!(fs::read(&blocked_parent).unwrap(), b"not a directory");

    fs::create_dir(&fixture.log).unwrap();
    assert!(audit_into(&fixture.log, event.clone()).is_err());
    fs::remove_dir(&fixture.log).unwrap();
    fs::write(&fixture.log, b"{incomplete").unwrap();
    assert!(audit_into(&fixture.log, event).is_err());
    assert_eq!(fs::read(&fixture.log).unwrap(), b"{incomplete");
}

#[test]
fn oversize_row_does_not_verify_or_get_appended() {
    let fixture = Fixture::new();
    let bounded_row = vec![b' '; MAX_ROW_BYTES];
    fs::write(&fixture.log, &bounded_row).unwrap();
    assert_eq!(fixture.verify().status, AuditStatus::Empty);
    let event =
        json!({"tool": "read_file", "outcome": "failed", "error": "a".repeat(MAX_ROW_BYTES)});
    assert!(audit_into(&fixture.log, event).is_err());
    assert_eq!(fs::read(&fixture.log).unwrap(), bounded_row);
    fixture.append(json!({"tool": "write_file", "outcome": "completed"}));
    assert_eq!(fixture.verify().status, AuditStatus::Consistent);

    fs::write(&fixture.log, vec![b' '; MAX_ROW_BYTES + 1]).unwrap();
    assert_eq!(fixture.verify().status, AuditStatus::Unreadable);
}

#[test]
fn recent_activity_is_bounded_allowlisted_and_newest_first() {
    let fixture = Fixture::new();
    for _ in 0..30 {
        fixture.append(json!({
            "tool": "write_file", "outcome": "completed", "ts": "2026-11-21T09:15:32.123Z",
            "path": "FIXTURE_SECRET_PATH", "proposal_id": "FIXTURE_SECRET_ID", "content": "FIXTURE_SECRET_CONTENT",
        }));
    }
    fixture.append(json!({"tool": "FIXTURE_SECRET_TOOL", "outcome": "completed"}));
    fixture.append(json!({"tool": "read_file", "outcome": "FIXTURE_SECRET_OUTCOME"}));
    fixture.append(json!({"tool": "execute_shell", "outcome": "proposal_invalid", "ts": "FIXTURE_SECRET_TIME", "command": "FIXTURE_SECRET_COMMAND"}));
    fixture.append(json!({"tool": "execute_shell", "outcome": "spawn_error", "ts": 13, "error": "FIXTURE_SECRET_ERROR"}));

    let report = fixture.verify();
    assert_eq!(report.status, AuditStatus::Consistent);
    assert_eq!(report.total_rows, 34);
    assert_eq!(report.recent.len(), RECENT_LIMIT);
    assert_eq!(report.recent.first().unwrap().record, 34);
    assert_eq!(report.recent.last().unwrap().record, 8);
    let response = serde_json::to_value(report).unwrap();
    assert!(!response.to_string().contains("FIXTURE_SECRET"));
    assert!(!response.as_object().unwrap().contains_key("tip_hash"));
    assert_eq!(
        response["recent"][0],
        json!({"record": 34, "tool": "execute_shell", "outcome": "failed", "timestamp": null})
    );
    assert_eq!(
        response["recent"][1],
        json!({"record": 33, "tool": "execute_shell", "outcome": "blocked", "timestamp": null})
    );
    assert_eq!(
        response["recent"][2],
        json!({"record": 30, "tool": "write_file", "outcome": "completed", "timestamp": "2026-11-21T09:15:32.123Z"})
    );
}
