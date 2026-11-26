//! Private workspaces and the bot installations that act inside them.
//!
//! A workspace lists the folders its bots may touch. The registry is owned by
//! the native side, stored beside the policy, and unreachable through tools,
//! so a model cannot widen its own scope. The owner client starts a run for
//! an installed bot; scoped tools resolve its identity from the native handle.
//! The main webview is trusted to keep handles and owner IPC out of model
//! context. This is not a sandbox or protection from a compromised webview.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use uuid::Uuid;

#[cfg(test)]
#[path = "workspace_tests.rs"]
pub(crate) mod test_support;

pub const REGISTRY_VERSION: u32 = 1;
const MAX_NAME_CHARS: usize = 80;
const MAX_RESOURCES: usize = 32;

pub(crate) const MAX_TEXT_MIB: usize = 1;
pub(crate) const MAX_TEXT_BYTES: usize = MAX_TEXT_MIB * 1024 * 1024;
pub(crate) const MAX_DIRECTORY_ENTRIES: usize = 2_000;

pub(crate) fn check_write_content_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "Proposed content exceeds the {MAX_TEXT_MIB} MiB workspace write limit. Use a smaller file."
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    ExecuteShell,
    ReadFile,
    WriteFile,
    ListDirectory,
    DelegateTask,
}

impl Tool {
    pub fn label(self) -> &'static str {
        match self {
            Tool::ExecuteShell => "run shell commands",
            Tool::ReadFile => "read files",
            Tool::WriteFile => "write files",
            Tool::ListDirectory => "list folders",
            Tool::DelegateTask => "ask other bots",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BotTemplate {
    pub id: &'static str,
    pub version: u32,
    pub name: &'static str,
    pub description: &'static str,
    pub capabilities: &'static [Tool],
}

/// Built-in templates live in code rather than in the registry file, so
/// editing that file cannot raise what a template allows.
pub fn builtin_templates() -> &'static [BotTemplate] {
    &[
        BotTemplate {
            id: "tmpl_chat",
            version: 1,
            name: "Chat only",
            description: "Converses only. It cannot read files, list folders, run commands, or ask other bots.",
            capabilities: &[],
        },
        BotTemplate {
            id: "tmpl_reader",
            version: 1,
            name: "Read-only analyst",
            description: "Reads the folders of its workspace and can ask other installed bots. It cannot change files or run commands.",
            capabilities: &[Tool::ReadFile, Tool::ListDirectory, Tool::DelegateTask],
        },
        BotTemplate {
            id: "tmpl_developer",
            version: 1,
            name: "Developer agent",
            description: "Reads files in granted folders and proposes changes for your approval. Workspace runs cannot use shell commands or local agent CLIs.",
            capabilities: &[
                Tool::ReadFile,
                Tool::ListDirectory,
                Tool::DelegateTask,
                Tool::WriteFile,
            ],
        },
    ]
}

fn template(id: &str) -> Option<&'static BotTemplate> {
    builtin_templates()
        .iter()
        .find(|template| template.id == id)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    /// Absolute path, with symbolic links resolved when the folder was added.
    pub path: String,
    pub access: Access,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub resources: Vec<Resource>,
    pub created_at: u64,
}

/// One bot installed in one workspace. A persona may be installed once per
/// workspace; the persona itself stays a separate, shared definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BotInstallation {
    pub id: String,
    pub workspace_id: String,
    pub template_id: String,
    pub persona_id: String,
    /// Sorted, unique, and always a subset of the template's capabilities.
    pub tools: Vec<Tool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    pub installations: Vec<BotInstallation>,
}

#[derive(Debug, Serialize)]
pub struct RegistryView {
    #[serde(flatten)]
    pub registry: Registry,
    pub templates: Vec<BotTemplate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallRequest {
    pub template_id: String,
    pub persona_id: String,
    /// Omitted: no tools. An installation starts with only what was asked for.
    pub tools: Option<Vec<Tool>>,
}

/// Where the real registry lives. A unit test can only reach a registry it
/// declared for its own thread; any other test that finds its way here stops
/// instead of touching the owner's workspaces.
pub fn registry_path() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_REGISTRY.with(|slot| slot.borrow().clone()) {
        return path;
    }
    #[cfg(test)]
    panic!(
        "A test reached the real workspace registry. Use the *_at functions with a private file."
    );
    #[cfg(not(test))]
    crate::policy::config_dir().join("workspaces.json")
}

#[cfg(test)]
thread_local! {
    static TEST_REGISTRY: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ids only need to be unique and hard to guess, not to be secrets: a scope
/// is resolved by looking the id up, never by knowing it.
fn new_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!(
        "{prefix}:{nanos}:{}:{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    format!(
        "{prefix}_{}",
        &crate::proposal::sha256_hex(seed.as_bytes())[..16]
    )
}

fn home_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    )
}

/// `~` and `~/…` become absolute. Bot routes require an absolute path
/// otherwise: a relative one would resolve against wherever AnyBot was
/// started, which is no workspace's business.
pub(crate) fn expand_tilde(requested: &str) -> Result<PathBuf, String> {
    let path = if requested == "~" || requested.starts_with("~/") {
        let home = home_dir();
        if !home.is_absolute() {
            return Err("Cannot resolve ~: no absolute home directory is configured.".into());
        }
        let relative = Path::new(requested.strip_prefix("~/").unwrap_or(""));
        if relative.has_root() || matches!(relative.components().next(), Some(Component::Prefix(_)))
        {
            return Err("Use a home-relative path after ~/.".into());
        }
        home.join(relative)
    } else {
        let path = PathBuf::from(requested);
        if !path.is_absolute() || requested.starts_with('~') {
            return Err(format!(
                "Use an absolute path, or one starting with ~, instead of {requested:?}."
            ));
        }
        path
    };
    #[cfg(windows)]
    if path.components().any(|component| match component {
        Component::Normal(part) => {
            let part = part.to_string_lossy();
            part.contains(':') || part.ends_with([' ', '.'])
        }
        _ => false,
    }) {
        return Err("Use a regular Windows path, not a stream or an ambiguous file name.".into());
    }
    Ok(path)
}

fn check_id(id: &str, prefix: &str) -> Result<(), String> {
    let tail = id
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('_'))
        .filter(|tail| !tail.is_empty() && tail.len() <= 32)
        .filter(|tail| {
            tail.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
    if tail.is_none() {
        return Err(format!("Invalid {prefix} id: {id}"));
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_NAME_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!(
            "Use a name of 1 to {MAX_NAME_CHARS} visible characters instead of {name:?}."
        ));
    }
    Ok(())
}

fn check_persona_id(persona_id: &str) -> Result<(), String> {
    let valid = !persona_id.is_empty()
        && persona_id.len() <= 64
        && persona_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_');
    if !valid {
        return Err(format!("Invalid persona id: {persona_id:?}"));
    }
    Ok(())
}

/// Reject anything the enforcement code would have to guess at. An
/// installation must point at a workspace and a template that exist, and it
/// cannot keep a tool its template does not offer.
fn validate(registry: &Registry) -> Result<(), String> {
    if registry.version != REGISTRY_VERSION {
        return Err(format!(
            "Workspace registry version {} is not supported (expected {REGISTRY_VERSION}).",
            registry.version
        ));
    }
    if registry.workspaces.is_empty() {
        return Err("The workspace registry has no workspace.".into());
    }
    let mut workspace_ids = HashSet::new();
    for workspace in &registry.workspaces {
        check_id(&workspace.id, "ws")?;
        if !workspace_ids.insert(workspace.id.as_str()) {
            return Err(format!("Workspace id {} appears twice.", workspace.id));
        }
        check_name(&workspace.name)?;
        if workspace.resources.len() > MAX_RESOURCES {
            return Err(format!(
                "Workspace {} lists more than {MAX_RESOURCES} folders.",
                workspace.name
            ));
        }
        let mut resource_ids = HashSet::new();
        let mut paths = HashSet::new();
        for resource in &workspace.resources {
            check_id(&resource.id, "res")?;
            if !resource_ids.insert(resource.id.as_str()) {
                return Err(format!("Folder id {} appears twice.", resource.id));
            }
            if resource.path.is_empty() || !Path::new(&resource.path).is_absolute() {
                return Err(format!("Folder {} is not an absolute path.", resource.path));
            }
            if !paths.insert(resource.path.as_str()) {
                return Err(format!(
                    "Workspace {} lists {} twice.",
                    workspace.name, resource.path
                ));
            }
        }
    }
    let mut installation_ids = HashSet::new();
    let mut personas = HashSet::new();
    for installation in &registry.installations {
        check_id(&installation.id, "inst")?;
        if !installation_ids.insert(installation.id.as_str()) {
            return Err(format!(
                "Installation id {} appears twice.",
                installation.id
            ));
        }
        if !workspace_ids.contains(installation.workspace_id.as_str()) {
            return Err(format!(
                "Installation {} refers to a missing workspace.",
                installation.id
            ));
        }
        let capabilities = template(&installation.template_id)
            .ok_or_else(|| format!("Unknown bot template {}.", installation.template_id))?
            .capabilities;
        check_persona_id(&installation.persona_id)?;
        let mut sorted = installation.tools.clone();
        sorted.sort();
        sorted.dedup();
        if sorted != installation.tools {
            return Err(format!(
                "Installation {} lists a tool twice or out of order.",
                installation.id
            ));
        }
        if installation.tools.iter().any(|tool| {
            // Keep draft v1 registries readable, but do not offer or run
            // the historical shell setting in the workspace gateway.
            !capabilities.contains(tool)
                && !(installation.template_id == "tmpl_developer" && *tool == Tool::ExecuteShell)
        }) {
            return Err(format!(
                "Installation {} keeps a tool its template does not offer.",
                installation.id
            ));
        }
        if !personas.insert((&installation.workspace_id, &installation.persona_id)) {
            return Err(format!(
                "Persona {} is installed twice in one workspace.",
                installation.persona_id
            ));
        }
    }
    Ok(())
}

/// Missing, unreadable, or malformed: all errors. A tool route that cannot
/// read the scope must not act, and a damaged registry is never replaced
/// automatically — that would silently restore access its owner removed.
pub fn load_registry(path: &Path) -> Result<Registry, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read the workspace registry: {e}"))?;
    let registry: Registry = serde_json::from_str(&text)
        .map_err(|e| format!("The workspace registry is not valid: {e}"))?;
    validate(&registry)?;
    Ok(registry)
}

fn save_registry(path: &Path, registry: &Registry) -> Result<(), String> {
    let folder = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(folder)
        .map_err(|e| format!("Cannot save the workspace registry: {e}"))?;
    let json = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    // Stage beside the target and rename over it, so a failed save leaves the
    // previous registry whole.
    let mut staged = tempfile::Builder::new()
        .prefix(".workspaces-")
        .tempfile_in(folder)
        .map_err(|e| format!("Cannot save the workspace registry: {e}"))?;
    staged
        .write_all(json.as_bytes())
        .map_err(|e| format!("Cannot save the workspace registry: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Cannot protect the workspace registry: {e}"))?;
    }
    staged
        .as_file()
        .sync_all()
        .map_err(|e| format!("Cannot save the workspace registry: {e}"))?;
    staged
        .persist(path)
        .map_err(|e| format!("Cannot save the workspace registry: {}", e.error))?;
    Ok(())
}

/// Serialize read-modify-write changes so two edits cannot lose each other.
fn update<T>(
    path: &Path,
    change: impl FnOnce(&mut Registry) -> Result<T, String>,
) -> Result<(Registry, T), String> {
    let _guard = lock_registry()?;
    let mut registry = load_registry(path)?;
    let value = change(&mut registry)?;
    validate(&registry)?;
    save_registry(path, &registry)?;
    Ok((registry, value))
}

static REGISTRY_WRITE: Mutex<()> = Mutex::new(());

fn lock_registry() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    REGISTRY_WRITE
        .lock()
        .map_err(|_| "Cannot access the workspace registry.".into())
}

fn view(registry: Registry) -> RegistryView {
    RegistryView {
        registry,
        templates: builtin_templates().to_vec(),
    }
}

/// Resolve a folder the owner is adding: it must exist and be a directory.
fn resolve_folder(requested: &str) -> Result<PathBuf, String> {
    let expanded = expand_tilde(requested.trim())?;
    let resolved = expanded
        .canonicalize()
        .map_err(|e| format!("{} is not an available folder: {e}", requested.trim()))?;
    if !resolved.is_dir() {
        return Err(format!("{} is not a folder.", requested.trim()));
    }
    Ok(resolved)
}

fn resource_in(workspace: &Workspace, requested: &str, access: Access) -> Result<Resource, String> {
    let resolved = resolve_folder(requested)?;
    let path = resolved
        .to_str()
        .ok_or("The folder path is not valid UTF-8.")?
        .to_owned();
    if workspace
        .resources
        .iter()
        .any(|resource| resource.path == path)
    {
        return Err(format!(
            "{} is already a folder of {}.",
            path, workspace.name
        ));
    }
    Ok(Resource {
        id: new_id("res"),
        path,
        access,
    })
}

fn workspace_mut<'a>(
    registry: &'a mut Registry,
    workspace_id: &str,
) -> Result<&'a mut Workspace, String> {
    registry
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| format!("Unknown workspace {workspace_id}."))
}

/// The tools an installation ends up with: sorted, unique, and each one
/// offered by its template.
fn checked_tools(requested: Vec<Tool>, template_id: &str) -> Result<Vec<Tool>, String> {
    let definition =
        template(template_id).ok_or_else(|| format!("Unknown bot template {template_id}."))?;
    let mut tools = requested;
    tools.sort();
    tools.dedup();
    if let Some(tool) = tools
        .iter()
        .find(|tool| !definition.capabilities.contains(tool))
    {
        return Err(format!(
            "The {} template does not offer to {}.",
            definition.name,
            tool.label()
        ));
    }
    Ok(tools)
}

/// Create an empty default workspace on first use. Existing registries are
/// returned unchanged; there is no implicit grant for the launch folder.
fn create_initial(path: &Path) -> Result<Registry, String> {
    let _guard = lock_registry()?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => return load_registry(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(format!("Cannot inspect the workspace registry: {error}")),
    }
    let registry = Registry {
        version: REGISTRY_VERSION,
        workspaces: vec![Workspace {
            id: new_id("ws"),
            name: "Default workspace".into(),
            resources: Vec::new(),
            created_at: now_ms(),
        }],
        installations: Vec::new(),
    };
    save_registry(path, &registry)?;
    Ok(registry)
}

/// Scope identity is native-only and includes the run, not just the bot.
/// Never serialize or log it: the UUID is a bearer handle.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RunScope {
    handle: Uuid,
    workspace_id: String,
    installation_id: String,
}

impl RunScope {
    pub(crate) fn installation_id(&self) -> &str {
        &self.installation_id
    }
}

static RUNS: std::sync::LazyLock<Mutex<HashMap<Uuid, RunScope>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_runs() -> Result<std::sync::MutexGuard<'static, HashMap<Uuid, RunScope>>, String> {
    RUNS.lock()
        .map_err(|_| "Cannot access workspace runs.".into())
}

fn parse_handle(handle: &str) -> Result<Uuid, String> {
    Uuid::parse_str(handle).map_err(|_| "Invalid or ended workspace run.".into())
}

fn check_membership<'a>(
    registry: &'a Registry,
    workspace_id: &str,
    installation_id: &str,
) -> Result<&'a BotInstallation, String> {
    registry
        .installations
        .iter()
        .find(|install| install.id == installation_id && install.workspace_id == workspace_id)
        .ok_or_else(|| "Blocked: the bot is not installed in this workspace.".into())
}

pub(crate) fn start_run_at(
    path: &Path,
    workspace_id: &str,
    installation_id: &str,
) -> Result<String, String> {
    let _registry_guard = lock_registry()?;
    let registry = load_registry(path)?;
    check_membership(&registry, workspace_id, installation_id)?;
    let mut runs = lock_runs()?;
    let handle = loop {
        let candidate = Uuid::new_v4();
        if !runs.contains_key(&candidate) {
            break candidate;
        }
    };
    runs.insert(
        handle,
        RunScope {
            handle,
            workspace_id: workspace_id.to_owned(),
            installation_id: installation_id.to_owned(),
        },
    );
    Ok(handle.to_string())
}

pub(crate) fn end_run(handle: &str) -> Result<bool, String> {
    let Ok(handle) = parse_handle(handle) else {
        return Ok(false);
    };
    let mut runs = lock_runs()?;
    let Some(scope) = runs.remove(&handle) else {
        return Ok(false);
    };
    crate::proposal::forget_run(&scope)?;
    Ok(true)
}

/// A fresh filesystem grant. Only owner-listed folders are in scope.
#[derive(Debug)]
pub(crate) struct Grant<'a> {
    workspace: &'a Workspace,
}

impl Grant<'_> {
    pub(crate) fn check_read_path(&self, requested: &Path) -> Result<PathBuf, String> {
        let resolved = requested
            .canonicalize()
            .map_err(|e| format!("Cannot resolve {}: {e}", requested.display()))?;
        self.check_resolved_path(&resolved, Access::Read)?;
        Ok(resolved)
    }

    /// Check a target whose parent (or entire path, for reads) was already
    /// canonicalized. The most specific matching folder decides its access.
    pub(crate) fn check_resolved_path(&self, resolved: &Path, need: Access) -> Result<(), String> {
        let access = self
            .workspace
            .resources
            .iter()
            .filter(|resource| resolved.starts_with(&resource.path))
            .max_by_key(|resource| Path::new(&resource.path).components().count())
            .map(|resource| resource.access);
        match access {
            None => Err(format!(
                "Outside workspace scope: {} is not inside a folder of workspace '{}'. Use Manage workspaces in the sidebar to add the folder.",
                resolved.display(),
                self.workspace.name
            )),
            Some(Access::Read) if need == Access::ReadWrite => Err(format!(
                "Workspace '{}' allows reading {} but not changing it. Use Manage workspaces in the sidebar to grant write access.",
                self.workspace.name,
                resolved.display()
            )),
            Some(_) => Ok(()),
        }
    }
}

/// Look up a live handle and check its tool against the current registry.
/// Acquire locks in registry -> run -> proposal order. A reviewed commit
/// can hold the registry/run locks through publication, so in-process grant
/// edits and ending a run serialize with it. This does not lock other apps
/// or the filesystem itself; reads already admitted may finish after end.
pub(crate) fn with_run_grant<T>(
    path: &Path,
    handle: &str,
    tool: Tool,
    act: impl FnOnce(&RunScope, &Grant<'_>, &Registry) -> Result<T, String>,
) -> Result<T, String> {
    if tool == Tool::ExecuteShell {
        return Err("Blocked: workspace runs cannot use shell commands.".into());
    }
    let handle = parse_handle(handle)?;
    let _registry_guard = lock_registry()?;
    let runs = lock_runs()?;
    let scope = runs.get(&handle).ok_or("Invalid or ended workspace run.")?;
    let registry = load_registry(path)?;
    let install = check_membership(&registry, &scope.workspace_id, &scope.installation_id)?;
    if !install.tools.contains(&tool) {
        return Err(format!(
            "Blocked by permissions: this bot may not {}. Edit its tool grants in Manage workspaces in the sidebar.",
            tool.label()
        ));
    }
    let workspace = registry
        .workspaces
        .iter()
        .find(|workspace| workspace.id == scope.workspace_id)
        .ok_or("Blocked: the workspace of this bot is missing.")?;
    act(scope, &Grant { workspace }, &registry)
}

pub(crate) fn verify_delegate_at(path: &Path, handle: &str, target: &str) -> Result<bool, String> {
    with_run_grant(path, handle, Tool::DelegateTask, |scope, _, registry| {
        check_membership(registry, &scope.workspace_id, target)?;
        Ok(true)
    })
}

/// Tauri provides the invoking window; the renderer does not supply it as
/// data. The main client owns raw IPC and only routes scoped tools to models.
pub(crate) fn require_owner_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Blocked: this command is reserved for the main AnyBot window.".into())
    }
}

#[tauri::command]
pub fn start_workspace_run(
    window: WebviewWindow,
    workspace_id: String,
    installation_id: String,
) -> Result<String, String> {
    require_owner_window(&window)?;
    start_run_at(&registry_path(), &workspace_id, &installation_id)
}

#[tauri::command]
pub fn end_workspace_run(window: WebviewWindow, handle: String) -> Result<bool, String> {
    require_owner_window(&window)?;
    end_run(&handle)
}

#[tauri::command]
pub fn verify_workspace_delegate(
    window: WebviewWindow,
    handle: String,
    target_installation_id: String,
) -> Result<bool, String> {
    require_owner_window(&window)?;
    verify_delegate_at(&registry_path(), &handle, &target_installation_id)
}

// ---- Changes the owner makes to workspaces and installations ----
//
// Each change reads the registry at `path`, applies one edit, validates the
// whole result, and writes it once. The Tauri commands below are thin
// wrappers that name the real file; everything else, including the tests,
// goes through these and can point them at a private file.

pub fn create_workspace_at(
    path: &Path,
    name: &str,
    folder: Option<&str>,
    access: Access,
) -> Result<Registry, String> {
    check_name(name)?;
    let (registry, ()) = update(path, |registry| {
        let mut workspace = Workspace {
            id: new_id("ws"),
            name: name.trim().to_string(),
            resources: Vec::new(),
            created_at: now_ms(),
        };
        if let Some(folder) = folder.map(str::trim).filter(|folder| !folder.is_empty()) {
            workspace
                .resources
                .push(resource_in(&workspace, folder, access)?);
        }
        registry.workspaces.push(workspace);
        Ok(())
    })?;
    Ok(registry)
}

pub fn add_workspace_resource_at(
    path: &Path,
    workspace_id: &str,
    folder: &str,
    access: Access,
) -> Result<Registry, String> {
    let (registry, ()) = update(path, |registry| {
        let workspace = workspace_mut(registry, workspace_id)?;
        if workspace.resources.len() >= MAX_RESOURCES {
            return Err(format!(
                "Workspace {} already lists {MAX_RESOURCES} folders.",
                workspace.name
            ));
        }
        workspace
            .resources
            .push(resource_in(workspace, folder, access)?);
        Ok(())
    })?;
    Ok(registry)
}

pub fn remove_workspace_resource_at(
    path: &Path,
    workspace_id: &str,
    resource_id: &str,
) -> Result<Registry, String> {
    let (registry, ()) = update(path, |registry| {
        let workspace = workspace_mut(registry, workspace_id)?;
        let before = workspace.resources.len();
        workspace
            .resources
            .retain(|resource| resource.id != resource_id);
        if workspace.resources.len() == before {
            return Err(format!("Unknown folder {resource_id}."));
        }
        Ok(())
    })?;
    Ok(registry)
}

/// Install personas in a workspace. All of them are installed or none: the
/// registry is written once, after every request has been checked.
pub fn install_bots_at(
    path: &Path,
    workspace_id: &str,
    bots: Vec<InstallRequest>,
) -> Result<Registry, String> {
    let (registry, ()) = update(path, |registry| {
        workspace_mut(registry, workspace_id)?;
        if bots.len() > 64 {
            return Err("Install up to 64 bots at a time.".into());
        }
        let mut added = Vec::new();
        for bot in &bots {
            check_persona_id(&bot.persona_id)?;
            let already = registry
                .installations
                .iter()
                .chain(added.iter())
                .any(|installation| {
                    installation.workspace_id == workspace_id
                        && installation.persona_id == bot.persona_id
                });
            if already {
                return Err(format!(
                    "Persona {} is already installed in this workspace.",
                    bot.persona_id
                ));
            }
            added.push(BotInstallation {
                id: new_id("inst"),
                workspace_id: workspace_id.to_owned(),
                template_id: bot.template_id.clone(),
                persona_id: bot.persona_id.clone(),
                tools: checked_tools(bot.tools.clone().unwrap_or_default(), &bot.template_id)?,
            });
        }
        registry.installations.extend(added);
        Ok(())
    })?;
    Ok(registry)
}

/// Replace the tools an installation may use. The template's ceiling holds.
pub fn update_bot_tools_at(
    path: &Path,
    installation_id: &str,
    tools: Vec<Tool>,
) -> Result<Registry, String> {
    let (registry, ()) = update(path, |registry| {
        let installation = registry
            .installations
            .iter_mut()
            .find(|installation| installation.id == installation_id)
            .ok_or_else(|| format!("Unknown bot installation {installation_id}."))?;
        installation.tools = checked_tools(tools, &installation.template_id)?;
        Ok(())
    })?;
    Ok(registry)
}

pub fn remove_bot_at(path: &Path, installation_id: &str) -> Result<Registry, String> {
    let (registry, ()) = update(path, |registry| {
        let before = registry.installations.len();
        registry
            .installations
            .retain(|installation| installation.id != installation_id);
        if registry.installations.len() == before {
            return Err(format!("Unknown bot installation {installation_id}."));
        }
        Ok(())
    })?;
    Ok(registry)
}

// ---- Tauri commands: the same changes, against the real registry ----

#[tauri::command]
pub fn get_workspace_registry(window: WebviewWindow) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    Ok(view(load_registry(&registry_path())?))
}

/// Create the first workspace if the registry does not exist yet. Safe to
/// call on every start; an existing registry is returned as it is.
#[tauri::command]
pub fn ensure_default_workspace(window: WebviewWindow) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    Ok(view(create_initial(&registry_path())?))
}

#[tauri::command]
pub fn create_workspace(
    window: WebviewWindow,
    name: String,
    folder: Option<String>,
    access: Access,
) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = create_workspace_at(&registry_path(), &name, folder.as_deref(), access)?;
    Ok(view(registry))
}

#[tauri::command]
pub fn add_workspace_resource(
    window: WebviewWindow,
    workspace_id: String,
    folder: String,
    access: Access,
) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = add_workspace_resource_at(&registry_path(), &workspace_id, &folder, access)?;
    Ok(view(registry))
}

#[tauri::command]
pub fn remove_workspace_resource(
    window: WebviewWindow,
    workspace_id: String,
    resource_id: String,
) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = remove_workspace_resource_at(&registry_path(), &workspace_id, &resource_id)?;
    Ok(view(registry))
}

#[tauri::command]
pub fn install_bots(
    window: WebviewWindow,
    workspace_id: String,
    bots: Vec<InstallRequest>,
) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = install_bots_at(&registry_path(), &workspace_id, bots)?;
    Ok(view(registry))
}

#[tauri::command]
pub fn update_bot_tools(
    window: WebviewWindow,
    installation_id: String,
    tools: Vec<Tool>,
) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = update_bot_tools_at(&registry_path(), &installation_id, tools)?;
    Ok(view(registry))
}

#[tauri::command]
pub fn remove_bot(window: WebviewWindow, installation_id: String) -> Result<RegistryView, String> {
    require_owner_window(&window)?;
    let registry = remove_bot_at(&registry_path(), &installation_id)?;
    Ok(view(registry))
}
