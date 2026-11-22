use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::audit::record_audit;

pub fn config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            return PathBuf::from(app_data).join("anybot");
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("anybot")
}

pub fn policy_path() -> PathBuf {
    config_dir().join("policy.json")
}

pub fn grants_path() -> PathBuf {
    config_dir().join("standing-grants.json")
}

pub fn audit_path() -> PathBuf {
    config_dir().join("audit.jsonl")
}

/// Action policy as data (OpenBot-style): deny rules are evaluated before
/// allow rules, and an unreadable or corrupt policy falls back to a
/// conservative built-in set where everything requires approval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    /// Substrings that flag a command as Dangerous (never auto-run, always
    /// surfaced as destructive). Evaluated first.
    pub deny_patterns: Vec<String>,
    /// Commands that are blocked unconditionally: no approval path,
    /// proposal token, or standing grant can execute them.
    pub deny_commands: Vec<String>,
    /// Read-only commands eligible for auto-run.
    pub allow_read_only: Vec<String>,
    /// Read-only `git` subcommands.
    pub git_read_only: Vec<String>,
    /// Exact command prefixes that are read-only (e.g. "cargo check").
    pub allow_phrases: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            deny_patterns: default_deny_patterns(),
            deny_commands: vec![],
            allow_read_only: default_read_only(),
            git_read_only: default_git_read_only(),
            allow_phrases: default_phrases(),
        }
    }
}

fn default_deny_patterns() -> Vec<String> {
    [
        "rm -rf /", "rm -rf /*", "rm -rf ~", "mkfs", "dd if=",
        ":(){ :|:& };:", "> /dev/sd", "shutdown", "reboot", "halt",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_read_only() -> Vec<String> {
    [
        "ls", "dir", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du",
        "df", "which", "whereis", "whoami", "id", "uname", "date", "uptime",
        "echo", "printf", "hostname", "ps", "w",
        "grep", "rg",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_git_read_only() -> Vec<String> {
    [
        "status", "log", "diff", "show", "branch", "remote", "describe",
        "rev-parse", "blame", "shortlog", "tag", "ls-files",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_phrases() -> Vec<String> {
    // Only truly inert version/listing phrases. Note what is deliberately
    // ABSENT: `cargo check`/`tree`/`metadata` execute build scripts and hit
    // the network; `npx <pkg>` can install and run arbitrary lifecycle
    // scripts. Those are mutative and require approval.
    [
        "cargo --version", "rustc --version", "node -v", "node --version",
        "npm -v", "npm --version", "npm ls", "npm list",
        "tsc --noEmit", "python --version", "python3 --version",
        "pip --version", "pip3 --version", "git --version", "go version",
        "java --version", "make --version", "cmake --version",
        "docker --version", "docker ps",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Shell syntax that compounds, redirects, or backgrounds a command. Static,
/// not policy data: `pwd && touch x` — or `ls & touch x` (bare `&` runs the
/// rest as a background job) — must never inherit a safe prefix regardless
/// of what the config allows.
pub const COMPOUND_MARKERS: &[&str] = &[
    ";", "&&", "||", "&", "|", "`", "$(", ">", ">>", "<", "<<", "\n", "\r",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyFile {
    pub version: u32,
    #[serde(flatten)]
    pub policy: Policy,
}

/// Current policy schema version. Bump when the built-in defaults change in
/// a way that must reach upgraded installs (v1 installs persisted older,
/// unsafe allow_phrases such as `cargo check`).
pub const POLICY_VERSION: u32 = 2;

/// Phrases that v1 defaults allowed but that execute code (build scripts /
/// package installs). A v1 policy file carrying them is migrated by
/// dropping them — user-added entries are kept.
const RETIRED_UNSAFE_PHRASES: &[&str] = &[
    "cargo check",
    "cargo tree",
    "cargo metadata",
    "npx tsc --noEmit",
];

fn migrate_policy(mut policy: Policy, version: u32) -> Policy {
    if version < 2 {
        policy
            .allow_phrases
            .retain(|p| !RETIRED_UNSAFE_PHRASES.iter().any(|bad| p.eq_ignore_ascii_case(bad)));
    }
    policy
}

/// Load the policy file. Missing → write defaults so the file is
/// discoverable. Corrupt/unreadable → built-in conservative fallback where
/// the allowlists are empty (everything requires approval) but the built-in
/// deny patterns still tag destructive commands. Older schema versions are
/// migrated (retired unsafe defaults removed) and persisted back at the
/// current version.
pub fn load_policy() -> Policy {
    let path = policy_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            // First run: persist defaults for discoverability, best-effort.
            let file = PolicyFile { version: POLICY_VERSION, policy: Policy::default() };
            let _ = std::fs::create_dir_all(config_dir());
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap_or_default());
            return Policy::default();
        }
    };

    match serde_json::from_str::<PolicyFile>(&text) {
        Ok(f) => {
            let policy = migrate_policy(f.policy, f.version);
            if f.version != POLICY_VERSION {
                // Persist the migration so upgrades converge on v2.
                let file = PolicyFile { version: POLICY_VERSION, policy: policy.clone() };
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap_or_default());
            }
            policy
        }
        Err(_) => Policy {
            deny_patterns: default_deny_patterns(),
            deny_commands: vec![],
            allow_read_only: vec![],      // fail closed: nothing auto-runs
            git_read_only: vec![],
            allow_phrases: vec![],
        },
    }
}

/// A standing grant ("Always allow"). Grants are case-sensitive exact command
/// identities, optionally scoped to one working directory so a grant earned
/// in one project cannot auto-run the same text elsewhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StandingGrant {
    /// Legacy plain-string grant (matches any working directory).
    Simple(String),
    /// Grant scoped to an exact working directory.
    Scoped {
        command: String,
        #[serde(default)]
        cwd: Option<String>,
    },
}

pub fn load_standing_grants_sync() -> Vec<StandingGrant> {
    std::fs::read_to_string(grants_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn load_standing_grants() -> Result<Vec<StandingGrant>, String> {
    Ok(load_standing_grants_sync())
}

#[tauri::command]
pub async fn save_standing_grants(grants: Vec<StandingGrant>) -> Result<bool, String> {
    let path = grants_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&grants).map_err(|e| e.to_string())?;
    fs::write(path, json).await.map_err(|e| e.to_string())?;
    Ok(true)
}

/// Frontend-facing audit hook for decisions that never reach execution
/// (user rejected an approval, turn cancelled). Typed and validated — the
/// renderer may report WHAT it decided, but cannot forge arbitrary rows:
/// with a hash-chained log, forgeable rows would undermine the chain's
/// provenance rather than its integrity.
#[tauri::command]
pub fn record_rejection_audit(
    tool: String,
    outcome: String,
    command: Option<String>,
    path: Option<String>,
) -> Result<bool, String> {
    const KNOWN_TOOLS: [&str; 5] = [
        "execute_shell",
        "read_file",
        "write_file",
        "list_directory",
        "delegate_task",
    ];
    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return Err(format!("unknown tool: {tool}"));
    }
    if !["rejected", "cancelled"].contains(&outcome.as_str()) {
        return Err(format!("invalid rejection outcome: {outcome}"));
    }
    record_audit(serde_json::json!({
        "tool": tool,
        "decision": outcome,
        "outcome": outcome,
        "command": command,
        "path": path,
    }))?;
    Ok(true)
}

/// Audit a bot-to-bot delegation. Typed like the rejection hook: the
/// renderer reports the actors and result, never free-form row content.
#[tauri::command]
pub fn record_delegation_audit(
    from_bot: String,
    to_bot: String,
    to_model: String,
    outcome: String,
    error: Option<String>,
) -> Result<bool, String> {
    if !["completed", "failed", "cancelled"].contains(&outcome.as_str()) {
        return Err(format!("invalid delegation outcome: {outcome}"));
    }
    record_audit(serde_json::json!({
        "tool": "delegate_task",
        "decision": "auto_safe",
        "from_bot": from_bot,
        "to_bot": to_bot,
        "to_model": to_model,
        "outcome": outcome,
        "error": error,
    }))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_survive_roundtrip() {
        let file = PolicyFile { version: POLICY_VERSION, policy: Policy::default() };
        let json = serde_json::to_string(&file).unwrap();
        let back: PolicyFile = serde_json::from_str(&json).unwrap();
        assert!(back.policy.allow_read_only.contains(&"ls".to_string()));
        assert!(back.policy.git_read_only.contains(&"status".to_string()));
        assert!(back.policy.deny_patterns.contains(&"mkfs".to_string()));
    }

    #[test]
    fn v1_policy_migrates_retired_unsafe_phrases() {
        // An upgraded install persisted the old v1 defaults: cargo check ran
        // build scripts and npx could install packages. Migration must drop
        // exactly those while keeping user-added entries.
        let v1 = PolicyFile {
            version: 1,
            policy: Policy {
                allow_phrases: vec![
                    "cargo check".to_string(),
                    "npx tsc --noEmit".to_string(),
                    "my custom safe phrase".to_string(),
                ],
                ..Policy::default()
            },
        };
        let migrated = migrate_policy(v1.policy, 1);
        assert!(!migrated.allow_phrases.contains(&"cargo check".to_string()));
        assert!(!migrated.allow_phrases.contains(&"npx tsc --noEmit".to_string()));
        assert!(migrated.allow_phrases.contains(&"my custom safe phrase".to_string()));
        // Already-migrated policy is untouched.
        let v2 = migrate_policy(Policy::default(), POLICY_VERSION);
        assert_eq!(v2.allow_phrases, Policy::default().allow_phrases);
    }

    #[test]
    fn rejection_audit_validates_tool_and_outcome() {
        // Error paths only: the success path appends to the user's REAL
        // audit log (audit() targets config_dir), which tests must not do.
        assert!(record_rejection_audit("rm_rf_imagination".into(), "rejected".into(), None, None).is_err());
        assert!(record_rejection_audit("execute_shell".into(), "completed".into(), None, None).is_err());
        assert!(record_delegation_audit("a".into(), "b".into(), "m".into(), "teleported".into(), None).is_err());
    }
}
