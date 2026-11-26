//! Isolated fixtures shared by every module that enforces workspace scope,
//! and the registry's own tests.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;

pub(crate) struct TestRegistry {
    pub _temp: tempfile::TempDir,
    pub path: PathBuf,
    pub first: String,
    pub second: String,
    /// Writable folder of the first workspace.
    pub folder: PathBuf,
    /// Read-only folder of the first workspace.
    pub notes: PathBuf,
    /// Writable folder of the second workspace.
    pub outside: PathBuf,
    pub developer: String,
    pub reader: String,
    /// A developer installed in the second workspace only.
    pub outsider: String,
    handles: RefCell<Vec<String>>,
}

impl TestRegistry {
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().expect("create isolated test root");
        let root = temp.path().canonicalize().expect("resolve test root");
        let (folder, notes, outside) =
            (root.join("project"), root.join("notes"), root.join("other"));
        for dir in [&folder, &notes, &outside] {
            fs::create_dir(dir).expect("create fixture folder");
        }
        let path = root.join("registry").join("workspaces.json");
        use_registry(&path);

        let registry = create_initial(&path).expect("create registry");
        let first = registry.workspaces[0].id.clone();
        add_workspace_resource_at(&path, &first, &text(&folder), Access::ReadWrite)
            .expect("add writable folder");
        add_workspace_resource_at(&path, &first, &text(&notes), Access::Read)
            .expect("add read-only folder");
        let second = create_workspace_at(&path, "Second", Some(&text(&outside)), Access::ReadWrite)
            .expect("create second workspace")
            .workspaces
            .into_iter()
            .find(|workspace| workspace.name == "Second")
            .expect("second workspace")
            .id;
        let developer = install(&path, &first, "tmpl_developer", "developer");
        let reader = install(&path, &first, "tmpl_reader", "reader");
        let outsider = install(&path, &second, "tmpl_developer", "outsider");
        Self {
            _temp: temp,
            path,
            first,
            second,
            folder,
            notes,
            outside,
            developer,
            reader,
            outsider,
            handles: RefCell::default(),
        }
    }

    pub(crate) fn start(&self, workspace_id: &str, installation_id: &str) -> String {
        let handle =
            start_run_at(&self.path, workspace_id, installation_id).expect("start fixture run");
        self.handles.borrow_mut().push(handle.clone());
        handle
    }

    fn read_path(&self, handle: &str, path: &str) -> Result<PathBuf, String> {
        with_run_grant(&self.path, handle, Tool::ReadFile, |_, grant, _| {
            grant.check_read_path(&expand_tilde(path)?)
        })
    }

    fn check_destination(&self, handle: &str, path: &Path, access: Access) -> Result<(), String> {
        with_run_grant(&self.path, handle, Tool::WriteFile, |_, grant, _| {
            grant.check_resolved_path(path, access)
        })
    }

    pub(crate) fn installed(&self, persona: &str) -> String {
        load_registry(&self.path)
            .expect("reload registry")
            .installations
            .iter()
            .find(|installation| installation.persona_id == persona)
            .expect("installed fixture bot")
            .id
            .clone()
    }
}

impl Drop for TestRegistry {
    fn drop(&mut self) {
        for handle in self.handles.get_mut() {
            let _ = end_run(handle);
        }
    }
}

/// Point this thread's Tauri command wrappers at a private registry. A test
/// that reaches a wrapper by mistake then uses this file, never the real one.
pub(crate) fn use_registry(path: &Path) {
    TEST_REGISTRY.with(|slot| *slot.borrow_mut() = Some(path.to_path_buf()));
}

pub(crate) fn text(path: &Path) -> String {
    path.to_str()
        .expect("fixture path must be UTF-8")
        .to_owned()
}

pub(crate) fn write(path: &Path, contents: &str) -> String {
    fs::write(path, contents).expect("write fixture file");
    text(path)
}

fn request(template_id: &str, persona_id: &str, tools: Option<Vec<Tool>>) -> InstallRequest {
    InstallRequest {
        template_id: template_id.to_owned(),
        persona_id: persona_id.to_owned(),
        tools,
    }
}

/// Install a persona with every tool its template offers.
fn install(path: &Path, workspace_id: &str, template_id: &str, persona_id: &str) -> String {
    let tools = template(template_id)
        .expect("built-in template")
        .capabilities
        .to_vec();
    install_bots_at(
        path,
        workspace_id,
        vec![request(template_id, persona_id, Some(tools))],
    )
    .expect("install fixture bot");
    load_registry(path)
        .expect("reload registry")
        .installations
        .iter()
        .find(|installation| installation.persona_id == persona_id)
        .expect("installed fixture bot")
        .id
        .clone()
}

// ---- Registry ----

#[test]
fn first_start_creates_an_empty_workspace_and_never_changes_existing_grants() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("nested").join("workspaces.json");
    let registry = create_initial(&path).unwrap();
    assert_eq!(registry.version, REGISTRY_VERSION);
    assert_eq!(registry.workspaces.len(), 1);
    assert!(registry.workspaces[0].resources.is_empty());
    assert!(registry.installations.is_empty());

    let granted = add_workspace_resource_at(
        &path,
        &registry.workspaces[0].id,
        &text(&root.join(".")),
        Access::ReadWrite,
    )
    .unwrap();
    assert_eq!(granted.workspaces[0].resources[0].path, text(&root));
    assert_eq!(create_initial(&path).unwrap(), granted);
}

#[test]
fn a_missing_or_damaged_registry_is_an_error_and_is_never_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("workspaces.json");
    assert!(load_registry(&path).unwrap_err().contains("Cannot read"));

    for damaged in [
        "",
        "not json",
        "{\"version\":1,\"workspaces\":[],\"installations\":[]}",
        "{\"version\":2,\"workspaces\":[],\"installations\":[]}",
    ] {
        fs::write(&path, damaged).unwrap();
        assert!(load_registry(&path).is_err(), "accepted {damaged:?}");
        assert!(create_initial(&path).is_err(), "replaced {damaged:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), damaged);
    }
}

#[test]
fn the_registry_rejects_what_enforcement_would_have_to_guess_at() {
    let registry = TestRegistry::new();
    let valid = serde_json::to_value(load_registry(&registry.path).unwrap()).unwrap();
    assert_eq!(valid["installations"][0]["persona_id"], "developer");

    let with_installation = |change: fn(&mut Value)| {
        let mut json = valid.clone();
        let mut one = valid["installations"][0].clone();
        change(&mut one);
        json["installations"] = json!([one]);
        json
    };
    let reader_with_every_tool = {
        let mut json = valid.clone();
        let reader = json["installations"]
            .as_array()
            .unwrap()
            .iter()
            .position(|one| one["template_id"] == "tmpl_reader")
            .unwrap();
        json["installations"][reader]["tools"] = json!([
            "delegate_task",
            "execute_shell",
            "list_directory",
            "read_file"
        ]);
        json
    };
    let cases: [(&str, Value); 7] = [
        (
            "missing workspace",
            with_installation(|one| one["workspace_id"] = json!("ws_gone")),
        ),
        (
            "unknown template",
            with_installation(|one| one["template_id"] = json!("tmpl_wizard")),
        ),
        ("tool above the template", reader_with_every_tool),
        (
            "unknown tool",
            with_installation(|one| one["tools"] = json!(["teleport"])),
        ),
        (
            "tools out of order",
            with_installation(|one| one["tools"] = json!(["write_file", "read_file"])),
        ),
        (
            "unknown field",
            with_installation(|one| one["budget"] = json!(99)),
        ),
        ("no workspace at all", {
            let mut json = valid.clone();
            json["workspaces"] = json!([]);
            json
        }),
    ];
    for (name, json) in cases {
        fs::write(&registry.path, serde_json::to_string(&json).unwrap()).unwrap();
        assert!(load_registry(&registry.path).is_err(), "accepted {name}");
    }

    let mut duplicated = valid.clone();
    duplicated["installations"] = json!([valid["installations"][0], valid["installations"][0]]);
    fs::write(&registry.path, serde_json::to_string(&duplicated).unwrap()).unwrap();
    assert!(
        load_registry(&registry.path).is_err(),
        "accepted one persona installed twice"
    );
}

#[cfg(unix)]
#[test]
fn the_saved_registry_is_readable_by_its_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let registry = TestRegistry::new();
    let mode = fs::metadata(&registry.path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn folders_must_exist_be_absolute_and_not_be_listed_twice() {
    let registry = TestRegistry::new();
    let (path, first) = (&registry.path, registry.first.as_str());
    assert!(add_workspace_resource_at(path, first, "relative/path", Access::Read).is_err());
    assert!(
        add_workspace_resource_at(
            path,
            first,
            &text(&registry.folder.join("missing")),
            Access::Read
        )
        .unwrap_err()
        .contains("not an available folder")
    );
    let again =
        add_workspace_resource_at(path, first, &text(&registry.folder), Access::Read).unwrap_err();
    assert!(again.contains("already a folder"), "{again}");
    assert_eq!(
        load_registry(path).unwrap().workspaces[0].resources.len(),
        2
    );

    // Removing a folder takes effect at once and cannot be repeated.
    let run = registry.start(first, &registry.developer);
    let id = load_registry(path).unwrap().workspaces[0].resources[0]
        .id
        .clone();
    remove_workspace_resource_at(path, first, &id).unwrap();
    assert!(remove_workspace_resource_at(path, first, &id).is_err());
    assert!(registry.read_path(&run, &text(&registry.folder)).is_err());
}

#[test]
fn creating_a_workspace_checks_its_name_and_folder_before_writing_anything() {
    let registry = TestRegistry::new();
    let path = &registry.path;
    assert!(create_workspace_at(path, "   ", None, Access::Read).is_err());
    assert!(create_workspace_at(path, "Notes", Some("/no/such/folder"), Access::Read).is_err());
    assert_eq!(
        load_registry(path).unwrap().workspaces.len(),
        2,
        "a failed create must not add a workspace"
    );

    let created = create_workspace_at(path, "  Notes  ", None, Access::Read).unwrap();
    assert_eq!(created.workspaces.len(), 3);
    assert_eq!(created.workspaces[2].name, "Notes");
    assert!(created.workspaces[2].resources.is_empty());
}

#[test]
fn installing_checks_every_bot_before_any_is_written_and_the_template_ceiling_holds() {
    let registry = TestRegistry::new();
    let (path, first) = (&registry.path, registry.first.as_str());
    let before = load_registry(path).unwrap().installations.len();
    let fine = request("tmpl_reader", "fine", None);

    for bad in [
        vec![
            fine.clone(),
            request("tmpl_reader", "broken", Some(vec![Tool::WriteFile])),
        ],
        vec![fine.clone(), request("tmpl_wizard", "broken", None)],
        vec![fine.clone(), request("tmpl_reader", "bad persona!", None)],
        vec![fine.clone(), request("tmpl_reader", "developer", None)],
    ] {
        assert!(!install_bots_at(path, first, bad).unwrap_err().is_empty());
        assert_eq!(
            load_registry(path).unwrap().installations.len(),
            before,
            "a failed batch must not install any bot"
        );
    }
    assert!(install_bots_at(path, "ws_missing", vec![request("tmpl_chat", "x", None)]).is_err());

    // Omitted tools mean none: an installation starts with only what was asked for.
    install_bots_at(path, first, vec![fine]).unwrap();
    let fine = registry.start(first, &registry.installed("fine"));
    assert!(
        load_registry(path)
            .unwrap()
            .installations
            .iter()
            .find(|installation| installation.persona_id == "fine")
            .unwrap()
            .tools
            .is_empty()
    );
    assert!(
        registry
            .read_path(&fine, &text(&registry.folder))
            .unwrap_err()
            .contains("may not read files")
    );
}

#[test]
fn a_persona_is_installed_once_per_workspace_and_its_tools_can_change() {
    let registry = TestRegistry::new();
    let path = &registry.path;
    let run = registry.start(&registry.first, &registry.reader);

    // The same persona may serve another workspace as a separate installation.
    install_bots_at(
        path,
        &registry.second,
        vec![request("tmpl_reader", "reader", None)],
    )
    .unwrap();
    assert_eq!(
        load_registry(path)
            .unwrap()
            .installations
            .iter()
            .filter(|installation| installation.persona_id == "reader")
            .count(),
        2
    );

    let reader = registry.installed("reader");
    let error = update_bot_tools_at(path, &reader, vec![Tool::ExecuteShell]).unwrap_err();
    assert!(
        error.contains("does not offer to run shell commands"),
        "{error}"
    );
    assert!(with_run_grant(path, &run, Tool::ExecuteShell, |_, _, _| Ok(())).is_err());

    update_bot_tools_at(
        path,
        &reader,
        vec![Tool::ListDirectory, Tool::ListDirectory],
    )
    .unwrap();
    assert!(with_run_grant(path, &run, Tool::ListDirectory, |_, _, _| Ok(())).is_ok());
    assert!(
        registry.read_path(&run, &text(&registry.folder)).is_err(),
        "tools are replaced, not added"
    );

    remove_bot_at(path, &reader).unwrap();
    assert!(with_run_grant(path, &run, Tool::ListDirectory, |_, _, _| Ok(())).is_err());
    assert_eq!(
        load_registry(path)
            .unwrap()
            .installations
            .iter()
            .filter(|installation| installation.persona_id == "reader")
            .count(),
        1
    );
    assert!(remove_bot_at(path, "inst_missing").is_err());
}

#[test]
fn the_registry_view_contains_the_owner_registry_and_builtin_templates() {
    let registry = TestRegistry::new();
    let before = load_registry(&registry.path).unwrap().workspaces.len();
    let view =
        view(create_workspace_at(&registry_path(), "Owner workspace", None, Access::Read).unwrap());
    assert_eq!(view.registry.workspaces.len(), before + 1);
    assert_eq!(
        load_registry(&registry.path).unwrap().workspaces.len(),
        before + 1,
        "the owner edit wrote the declared file"
    );
    assert_eq!(view.templates.len(), builtin_templates().len());
}

#[test]
#[should_panic(expected = "reached the real workspace registry")]
fn a_test_that_never_declared_a_registry_cannot_reach_the_real_one() {
    let _ = registry_path();
}

#[test]
fn built_in_templates_are_distinct_and_nested() {
    let templates = builtin_templates();
    let ids: HashSet<&str> = templates.iter().map(|template| template.id).collect();
    assert_eq!(ids.len(), templates.len());
    assert!(templates.iter().all(|template| template.version == 1));
    for pair in templates.windows(2) {
        let (lower, higher) = (&pair[0].capabilities, &pair[1].capabilities);
        assert!(
            lower.iter().all(|tool| higher.contains(tool)),
            "{} ⊄ {}",
            pair[0].id,
            pair[1].id
        );
    }
    assert_eq!(templates.last().unwrap().capabilities.len(), 4);
    assert!(
        templates
            .iter()
            .all(|t| !t.capabilities.contains(&Tool::ExecuteShell))
    );
}

// ---- Run authentication and filesystem grants ----

#[test]
fn start_validates_membership_and_rejects_invalid_or_ended_handles() {
    let registry = TestRegistry::new();
    assert!(start_run_at(&registry.path, &registry.second, &registry.developer).is_err());
    assert!(start_run_at(&registry.path, "missing", &registry.developer).is_err());
    assert!(start_run_at(&registry.path, &registry.first, "missing").is_err());
    let first = registry.start(&registry.first, &registry.developer);
    let second = registry.start(&registry.first, &registry.developer);
    assert_ne!(first, second);
    assert_eq!(Uuid::parse_str(&first).unwrap().get_version_num(), 4);

    for invalid in [
        registry.developer.as_str(),
        "not a handle",
        "00000000-0000-0000-0000-000000000000",
    ] {
        assert!(
            registry
                .read_path(invalid, &text(&registry.folder))
                .is_err()
        );
        assert!(!end_run(invalid).unwrap());
    }
    assert!(end_run(&first).unwrap());
    assert!(!end_run(&first).unwrap());
    assert!(registry.read_path(&first, &text(&registry.folder)).is_err());
    assert!(registry.read_path(&second, &text(&registry.folder)).is_ok());
}

#[test]
fn unreadable_registry_denies_existing_runs_and_new_starts() {
    let registry = TestRegistry::new();
    let run = registry.start(&registry.first, &registry.developer);
    fs::write(&registry.path, "broken").unwrap();
    assert!(registry.read_path(&run, &text(&registry.folder)).is_err());
    assert!(start_run_at(&registry.path, &registry.first, &registry.developer).is_err());
}

#[test]
fn delegation_requires_a_current_tool_and_target_in_the_same_workspace() {
    let registry = TestRegistry::new();
    let run = registry.start(&registry.first, &registry.developer);
    assert!(verify_delegate_at(&registry.path, &run, &registry.reader).unwrap());
    assert!(verify_delegate_at(&registry.path, &run, &registry.outsider).is_err());
    remove_bot_at(&registry.path, &registry.reader).unwrap();
    assert!(verify_delegate_at(&registry.path, &run, &registry.reader).is_err());
    update_bot_tools_at(&registry.path, &registry.developer, vec![Tool::ReadFile]).unwrap();
    let error = verify_delegate_at(&registry.path, &run, &registry.developer).unwrap_err();
    assert!(error.contains("may not ask other bots"));
}

#[test]
fn draft_shell_grants_are_readable_but_never_usable_or_newly_grantable() {
    let registry = TestRegistry::new();
    let mut draft = load_registry(&registry.path).unwrap();
    let developer = draft
        .installations
        .iter_mut()
        .find(|bot| bot.id == registry.developer)
        .unwrap();
    developer.tools.insert(0, Tool::ExecuteShell);
    save_registry(&registry.path, &draft).unwrap();
    assert_eq!(load_registry(&registry.path).unwrap(), draft);
    let run = registry.start(&registry.first, &registry.developer);
    assert!(with_run_grant(&registry.path, &run, Tool::ExecuteShell, |_, _, _| Ok(())).is_err());
    assert!(
        update_bot_tools_at(
            &registry.path,
            &registry.developer,
            vec![Tool::ExecuteShell]
        )
        .is_err()
    );
}

#[test]
fn the_most_specific_folder_decides_the_access() {
    let registry = TestRegistry::new();
    let run = registry.start(&registry.first, &registry.developer);
    let drafts = registry.notes.join("drafts");
    fs::create_dir(&drafts).unwrap();
    add_workspace_resource_at(
        &registry.path,
        &registry.first,
        &text(&drafts),
        Access::ReadWrite,
    )
    .unwrap();

    assert!(
        registry
            .check_destination(&run, &drafts.join("new.md"), Access::ReadWrite)
            .is_ok()
    );
    assert!(
        registry
            .check_destination(&run, &registry.notes.join("new.md"), Access::ReadWrite)
            .is_err()
    );
    assert!(
        registry
            .check_destination(&run, &registry.notes.join("plan.md"), Access::Read)
            .is_ok()
    );

    // Adding a broader folder later does not weaken the narrower one.
    let root = registry.notes.parent().unwrap();
    add_workspace_resource_at(
        &registry.path,
        &registry.first,
        &text(root),
        Access::ReadWrite,
    )
    .unwrap();
    let error = registry
        .check_destination(&run, &registry.notes.join("new.md"), Access::ReadWrite)
        .unwrap_err();
    assert!(error.contains("not changing it"), "{error}");
}
