use std::{fs, io::Cursor};

use super::{
    is_protected_file_in, list_target_with_audit, read_file_with_audit, read_workspace_text,
    workspace_list_directory_at, workspace_read_file_at, workspace_write_file_at,
    write_file_with_audit,
};
use crate::proposal::{approve_proposal_by_id, create_write_proposal, workspace_write_proposal_at};
use crate::workspace::test_support::{TestRegistry, text, write};
use crate::workspace::{self, Access, MAX_DIRECTORY_ENTRIES, MAX_TEXT_BYTES, Tool};

#[tokio::test]
async fn workspace_reader_never_consumes_more_than_the_limit_plus_one() {
    let mut reader = Cursor::new(vec![b'x'; MAX_TEXT_BYTES + 32]);
    let error = read_workspace_text(&mut reader).await.unwrap_err();
    assert!(error.contains("1 MiB workspace read limit"), "{error}");
    assert_eq!(reader.position(), (MAX_TEXT_BYTES + 1) as u64);
}

#[tokio::test]
async fn scoped_read_rejects_oversize_even_with_a_line_limit_but_legacy_does_not() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.reader);
    let log = fixture._temp.path().join("audit.jsonl");
    let file = fixture.notes.join("large.txt");
    let exact = "é".repeat(MAX_TEXT_BYTES / 2);
    let path = write(&file, &exact);
    let result = workspace_read_file_at(&fixture.path, &run, &path, None, &log)
        .await
        .unwrap();
    assert_eq!(result.content, exact);

    write(&file, &format!("{exact}\n"));
    let error = workspace_read_file_at(&fixture.path, &run, &path, Some(0), &log)
        .await
        .unwrap_err();
    assert!(error.contains("1 MiB workspace read limit"), "{error}");
    let legacy = read_file_with_audit(&path, None, &log).await.unwrap();
    assert_eq!(legacy.content.len(), MAX_TEXT_BYTES + 1);
}

#[tokio::test]
async fn scoped_listing_rejects_entry_limit_plus_one_but_legacy_lists_all() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.reader);
    let log = fixture._temp.path().join("audit.jsonl");
    let path = text(&fixture.notes);
    for index in 0..MAX_DIRECTORY_ENTRIES {
        fs::File::create(fixture.notes.join(format!("file-{index}"))).unwrap();
    }
    let entries = workspace_list_directory_at(&fixture.path, &run, &path, &log)
        .await
        .unwrap();
    assert_eq!(entries.len(), MAX_DIRECTORY_ENTRIES);

    fs::create_dir(fixture.notes.join("extra-subfolder")).unwrap();
    let error = workspace_list_directory_at(&fixture.path, &run, &path, &log)
        .await
        .unwrap_err();
    assert!(error.contains("listing limit of 2000 entries"), "{error}");
    let legacy = list_target_with_audit(&path, &fixture.notes, None, &log)
        .await
        .unwrap();
    assert_eq!(legacy.len(), MAX_DIRECTORY_ENTRIES + 1);
}

#[tokio::test]
async fn scoped_review_caps_both_texts_and_apply_caps_input_without_affecting_legacy() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.developer);
    let log = fixture._temp.path().join("audit.jsonl");
    let file = fixture.folder.join("large.txt");
    let exact = "é".repeat(MAX_TEXT_BYTES / 2);
    let larger = format!("{exact}x");
    let path = write(&file, &larger);
    let propose = |content: &str| {
        workspace_write_proposal_at(&fixture.path, &run, path.clone(), content.to_owned(), &log)
    };
    let apply = |content: &str, id: &str| {
        workspace_write_file_at(&fixture.path, &run, &path, content, id, &log)
    };
    let error = propose("short replacement").unwrap_err();
    assert!(error.contains("1 MiB workspace review limit"), "{error}");
    let legacy = create_write_proposal(path.clone(), larger.clone(), None)
        .await
        .unwrap();
    assert_eq!(legacy.before, larger);
    assert_eq!(legacy.after, larger);
    approve_proposal_by_id(legacy.id.clone()).unwrap();
    write_file_with_audit(&path, &larger, None, Some(&legacy.id), &log)
        .await
        .unwrap();

    write(&file, &exact);
    let error = propose(&larger).unwrap_err();
    assert!(error.contains("1 MiB workspace write limit"), "{error}");
    let replacement = "z".repeat(MAX_TEXT_BYTES);
    let proposal = propose(&replacement).unwrap();
    assert_eq!(proposal.before, exact);
    assert_eq!(proposal.after, replacement);
    approve_proposal_by_id(proposal.id.clone()).unwrap();
    let error = apply(&larger, &proposal.id).unwrap_err();
    assert!(error.contains("1 MiB workspace write limit"), "{error}");
    assert_eq!(fs::read_to_string(&file).unwrap(), exact);
    assert!(apply(&replacement, &proposal.id).unwrap().success);
    assert_eq!(fs::read_to_string(&file).unwrap(), replacement);
}

#[tokio::test]
async fn scoped_reads_and_lists_require_the_right_handle_tool_and_folder() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.reader);
    let log = fixture._temp.path().join("audit.jsonl");
    let path = write(&fixture.notes.join("plan.md"), "first\nsecond\n");
    let other = write(&fixture.outside.join("secret.txt"), "other workspace");
    let traversal = format!("{}/../other/secret.txt", text(&fixture.folder));

    let file = workspace_read_file_at(&fixture.path, &run, &path, Some(1), &log)
        .await
        .unwrap();
    assert_eq!(file.content, "first");
    assert_eq!(file.total_lines, 2);
    let entries = workspace_list_directory_at(&fixture.path, &run, &text(&fixture.notes), &log)
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "plan.md");

    for denied in [other.as_str(), traversal.as_str(), "plan.md"] {
        assert!(
            workspace_read_file_at(&fixture.path, &run, denied, None, &log)
                .await
                .is_err()
        );
    }
    assert!(
        workspace_list_directory_at(&fixture.path, &run, &text(&fixture.outside), &log)
            .await
            .is_err()
    );
    assert!(
        workspace_read_file_at(&fixture.path, &fixture.reader, &path, None, &log)
            .await
            .is_err()
    );
    workspace::update_bot_tools_at(&fixture.path, &fixture.reader, vec![Tool::ListDirectory])
        .unwrap();
    assert!(
        workspace_read_file_at(&fixture.path, &run, &path, None, &log)
            .await
            .is_err()
    );
    assert!(
        workspace_list_directory_at(&fixture.path, &run, &text(&fixture.notes), &log)
            .await
            .is_ok()
    );

    let rows = fs::read_to_string(&log).unwrap();
    let first: serde_json::Value = serde_json::from_str(rows.lines().next().unwrap()).unwrap();
    assert_eq!(first["installation_id"], fixture.reader);
    assert!(!rows.contains(&run));
}

#[tokio::test]
async fn approved_scoped_write_is_exact_single_use_and_bound_to_its_run_and_namespace() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.developer);
    let other_run = fixture.start(&fixture.first, &fixture.developer);
    let outside_run = fixture.start(&fixture.second, &fixture.outsider);
    let log = fixture._temp.path().join("audit.jsonl");
    let path = write(&fixture.folder.join("draft.md"), "draft");
    let propose = || {
        workspace_write_proposal_at(&fixture.path, &run, path.clone(), "reviewed".into(), &log)
            .unwrap()
    };
    let apply = |handle: &str, content: &str, id: &str| {
        workspace_write_file_at(&fixture.path, handle, &path, content, id, &log)
    };
    let proposal = propose();
    assert_eq!(proposal.before, "draft");
    assert!(
        apply(&run, "reviewed", &proposal.id)
            .unwrap_err()
            .contains("Pending")
    );
    approve_proposal_by_id(proposal.id.clone()).unwrap();
    for invalid_run in [&other_run, &outside_run] {
        assert!(
            apply(invalid_run, "reviewed", &proposal.id)
                .unwrap_err()
                .contains("different run")
        );
    }
    assert!(
        write_file_with_audit(&path, "reviewed", None, Some(&proposal.id), &log)
            .await
            .unwrap_err()
            .contains("different run")
    );
    assert!(
        apply(&run, "changed", &proposal.id)
            .unwrap_err()
            .contains("content does not match")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "draft");

    let legacy = create_write_proposal(path.clone(), "legacy".into(), None)
        .await
        .unwrap();
    approve_proposal_by_id(legacy.id.clone()).unwrap();
    assert!(
        apply(&run, "legacy", &legacy.id)
            .unwrap_err()
            .contains("tool namespace")
    );
    let proposal = propose();
    approve_proposal_by_id(proposal.id.clone()).unwrap();
    assert!(apply(&run, "reviewed", &proposal.id).unwrap().success);
    assert_eq!(fs::read_to_string(&path).unwrap(), "reviewed");
    assert!(
        apply(&run, "reviewed", &proposal.id)
            .unwrap_err()
            .contains("Consumed")
    );
}

#[test]
fn apply_requires_current_tools_and_folder_grants_and_end_discards_proposals() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.developer);
    let log = fixture._temp.path().join("audit.jsonl");
    let file = fixture.folder.join("new.md");
    let path = text(&file);
    let propose = || {
        workspace_write_proposal_at(&fixture.path, &run, path.clone(), "new".into(), &log).unwrap()
    };
    let apply = |id: &str| workspace_write_file_at(&fixture.path, &run, &path, "new", id, &log);
    let approved = propose();
    let pending = propose();
    approve_proposal_by_id(approved.id.clone()).unwrap();

    workspace::update_bot_tools_at(&fixture.path, &fixture.developer, vec![Tool::ReadFile])
        .unwrap();
    assert!(apply(&approved.id).unwrap_err().contains("may not write"));
    workspace::update_bot_tools_at(&fixture.path, &fixture.developer, vec![Tool::WriteFile])
        .unwrap();
    let registry = workspace::load_registry(&fixture.path).unwrap();
    let old = registry.workspaces[0]
        .resources
        .iter()
        .find(|res| res.path == text(&fixture.folder))
        .unwrap();
    workspace::remove_workspace_resource_at(&fixture.path, &fixture.first, &old.id).unwrap();
    workspace::add_workspace_resource_at(&fixture.path, &fixture.first, &old.path, Access::Read)
        .unwrap();
    assert!(apply(&approved.id).unwrap_err().contains("not changing it"));
    assert!(!file.exists());

    assert!(workspace::end_run(&run).unwrap());
    assert!(
        apply(&approved.id)
            .unwrap_err()
            .contains("ended workspace run")
    );
    assert!(
        approve_proposal_by_id(pending.id)
            .unwrap_err()
            .contains("not found")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn scoped_links_cannot_cross_grants_and_write_review_never_follows_a_final_link() {
    use std::os::unix::fs::symlink;

    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.developer);
    let log = fixture._temp.path().join("audit.jsonl");
    let inside = write(&fixture.folder.join("inside.txt"), "inside");
    let outside = write(&fixture.outside.join("outside.txt"), "outside");
    let leaf = fixture.folder.join("leaf.txt");
    let gate = fixture.folder.join("alias");
    symlink(&inside, &leaf).unwrap();
    assert!(
        workspace_write_proposal_at(&fixture.path, &run, text(&leaf), "modified".into(), &log)
            .unwrap_err()
            .contains("Symbolic links")
    );
    assert_eq!(
        workspace_read_file_at(&fixture.path, &run, &text(&leaf), None, &log)
            .await
            .unwrap()
            .content,
        "inside"
    );

    symlink(&fixture.outside, &gate).unwrap();
    let outside_alias = text(&gate.join("outside.txt"));
    assert!(
        workspace_list_directory_at(&fixture.path, &run, &text(&gate), &log)
            .await
            .is_err()
    );
    assert!(
        workspace_read_file_at(&fixture.path, &run, &outside_alias, None, &log)
            .await
            .is_err()
    );
    assert!(
        workspace_write_proposal_at(&fixture.path, &run, outside_alias, "modified".into(), &log)
            .unwrap_err()
            .starts_with("Outside workspace scope")
    );

    fs::remove_file(&gate).unwrap();
    symlink(&fixture.folder, &gate).unwrap();
    let moved_alias = text(&gate.join("inside.txt"));
    let proposal = workspace_write_proposal_at(
        &fixture.path,
        &run,
        moved_alias.clone(),
        "modified".into(),
        &log,
    )
    .unwrap();
    approve_proposal_by_id(proposal.id.clone()).unwrap();
    fs::remove_file(&gate).unwrap();
    symlink(&fixture.outside, &gate).unwrap();
    assert!(
        workspace_write_file_at(
            &fixture.path,
            &run,
            &moved_alias,
            "modified",
            &proposal.id,
            &log
        )
        .unwrap_err()
        .starts_with("Conflict:")
    );
    assert_eq!(fs::read_to_string(inside).unwrap(), "inside");
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    assert!(!fixture.outside.join("inside.txt").exists());
}

#[cfg(unix)]
#[test]
fn configuration_paths_stay_protected_through_symlinks() {
    use std::os::unix::fs::symlink;

    let fixture = TestRegistry::new();
    let cfg = fixture.path.parent().unwrap();
    let registry_alias = fixture.folder.join("registry.json");
    symlink(&fixture.path, &registry_alias).unwrap();
    assert!(is_protected_file_in(&registry_alias, cfg));

    let public = fixture.folder.join("notes.txt");
    fs::write(&public, "test contents").unwrap();
    symlink(&public, cfg.join("config.json")).unwrap();
    let cfg_alias = fixture.folder.join("cfg");
    symlink(cfg, &cfg_alias).unwrap();
    assert!(is_protected_file_in(&cfg_alias.join("config.json"), cfg));
    assert!(!is_protected_file_in(&public, cfg));
}

#[cfg(unix)]
#[tokio::test]
async fn tilde_resolution_matches_for_read_review_and_apply() {
    let fixture = TestRegistry::new();
    let run = fixture.start(&fixture.first, &fixture.developer);
    let log = fixture._temp.path().join("audit.jsonl");
    let path = fixture.folder.join("plan.md");
    // Reach the disposable fixture from ~ without writing to the user's home.
    let home = workspace::expand_tilde("~")
        .unwrap()
        .canonicalize()
        .unwrap();
    let from_home = "../".repeat(home.components().count().saturating_sub(1));
    let requested = format!("~/{from_home}{}", text(path.strip_prefix("/").unwrap()));
    let proposal = workspace_write_proposal_at(
        &fixture.path,
        &run,
        requested.clone(),
        "approved".into(),
        &log,
    )
    .unwrap();
    assert_eq!(proposal.path, text(&path));
    approve_proposal_by_id(proposal.id.clone()).unwrap();
    workspace_write_file_at(
        &fixture.path,
        &run,
        &requested,
        "approved",
        &proposal.id,
        &log,
    )
    .unwrap();
    assert_eq!(
        workspace_read_file_at(&fixture.path, &run, &requested, None, &log)
            .await
            .unwrap()
            .content,
        "approved"
    );
}
