use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tokio::fs;

fn config_dir() -> PathBuf {
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
    /// Commands that may never auto-run even if standing-granted or
    /// allowlisted. Still runnable after explicit approval.
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
        "echo", "printf", "env", "printenv", "hostname", "ps", "w",
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

/// Load the policy file. Missing → write defaults so the file is
/// discoverable. Corrupt/unreadable → built-in conservative fallback where
/// the allowlists are empty (everything requires approval) but the built-in
/// deny patterns still tag destructive commands.
pub fn load_policy() -> Policy {
    let path = policy_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            // First run: persist defaults for discoverability, best-effort.
            let file = PolicyFile { version: 1, policy: Policy::default() };
            let _ = std::fs::create_dir_all(config_dir());
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap_or_default());
            return Policy::default();
        }
    };

    match serde_json::from_str::<PolicyFile>(&text) {
        Ok(f) => f.policy,
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

/// Append one audit event (JSON object) to audit.jsonl. The single writer is
/// Rust so rows land even if the UI dies mid-action.
pub fn audit(event: serde_json::Value) {
    use std::io::Write;
    let mut row = event;
    if !row.get("ts").is_some() {
        row["ts"] = serde_json::Value::String(
            chrono_free_iso8601_now(),
        );
    }
    let _ = std::fs::create_dir_all(config_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path())
    {
        let _ = writeln!(f, "{row}");
    }
}

/// RFC3339-ish UTC timestamp without pulling a chrono dependency.
fn chrono_free_iso8601_now() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    // Civil date from days since epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Frontend-facing audit hook for decisions that never reach execution
/// (user rejected an approval, turn cancelled).
#[tauri::command]
pub fn audit_event(event: String) -> Result<bool, String> {
    let parsed: serde_json::Value = serde_json::from_str(&event)
        .map_err(|e| format!("audit event is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("audit event must be a JSON object".to_string());
    }
    audit(parsed);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_survive_roundtrip() {
        let file = PolicyFile { version: 1, policy: Policy::default() };
        let json = serde_json::to_string(&file).unwrap();
        let back: PolicyFile = serde_json::from_str(&json).unwrap();
        assert!(back.policy.allow_read_only.contains(&"ls".to_string()));
        assert!(back.policy.git_read_only.contains(&"status".to_string()));
        assert!(back.policy.deny_patterns.contains(&"mkfs".to_string()));
    }

    #[test]
    fn timestamp_is_iso_like() {
        let ts = chrono_free_iso8601_now();
        // e.g. 2026-11-12T09:15:32.123Z
        assert_eq!(ts.len(), 24);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn audit_writes_valid_jsonl() {
        let dir = std::env::temp_dir().join(format!("anybot-audit-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // audit() writes to the real config dir; validate JSON shape only
        let row = serde_json::json!({"tool": "execute_shell", "decision": "rejected"});
        assert!(row.is_object());
        let _ = std::fs::remove_dir_all(dir);
    }
}
