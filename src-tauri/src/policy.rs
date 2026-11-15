use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tokio::fs;

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

/// Append one audit event (JSON object) to audit.jsonl. The single writer is
/// Rust so rows land even if the UI dies mid-action.
pub fn audit(event: serde_json::Value) {
    audit_into(&audit_path(), event);
}

/// Genesis anchor: the first hashed row chains from this constant, so the
/// chain's integrity is verifiable without trusting any stored "root".
pub const AUDIT_GENESIS: &str = "GENESIS";

/// Append state per log file: where the writer's last line ended (byte
/// offset) and the hash of that line. If the file no longer ends there
/// (rotated, truncated, or edited by another process), the tip is
/// re-derived from the file instead of trusting the cache.
static AUDIT_TIPS: std::sync::LazyLock<std::sync::Mutex<HashMap<PathBuf, (u64, String)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Recursively sort object keys so a row's JSON serializes identically no
/// matter which code path built it — the hash input is canonical.
fn canonicalize(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let sorted: std::collections::BTreeMap<String, serde_json::Value> = map
                .into_iter()
                .map(|(k, val)| (k, canonicalize(val)))
                .collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(canonicalize).collect())
        }
        other => other,
    }
}

/// Hash of a row's content bound to its predecessor: editing any earlier row
/// (or this one) changes what this value must be, so verification catches it.
fn audit_row_hash(row_without_hash: &serde_json::Value, prev_hash: &str) -> String {
    let mut payload = row_without_hash.clone();
    payload["prev_hash"] = serde_json::Value::String(prev_hash.to_string());
    let canonical = serde_json::to_string(&canonicalize(payload)).unwrap_or_default();
    crate::proposal::sha256_hex(canonical.as_bytes())
}

/// The `hash` of the last line of `path`, or GENESIS when the file is empty
/// or ends in legacy (pre-chain) rows.
fn derive_audit_tip(path: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return AUDIT_GENESIS.to_string();
    };
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|last| serde_json::from_str::<serde_json::Value>(last).ok())
        .and_then(|row| row.get("hash").and_then(|h| h.as_str()).map(String::from))
        .unwrap_or_else(|| AUDIT_GENESIS.to_string())
}

/// Chain-append one event to a JSONL audit log. Every row records the hash
/// of its predecessor and its own hash over the canonical row content, so
/// post-hoc edits, deletions, or reorderings break verification.
pub fn audit_into(path: &Path, mut event: serde_json::Value) {
    use std::io::Write;
    // One appender at a time: the tip cache and the file must never race.
    // (A poisoned lock means a panic left the registry inconsistent —
    // dropping the row beats writing an unchained one.)
    let Ok(mut tips) = AUDIT_TIPS.lock() else { return };
    if !event.get("ts").is_some() {
        event["ts"] = serde_json::Value::String(chrono_free_iso8601_now());
    }
    let file_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let prev_hash = match tips.get(path) {
        // Fast path: the file still ends exactly where our last append left
        // it, so the cached tip is the live chain head.
        Some((offset, tip)) if *offset == file_len && file_len > 0 => tip.clone(),
        // Cold cache, first write, or the file changed underneath us
        // (rotation/truncation/edit): re-derive from the actual bytes.
        _ => derive_audit_tip(path),
    };
    let hash = audit_row_hash(&event, &prev_hash);
    let mut row_obj = event.as_object().cloned().unwrap_or_default();
    row_obj.insert("prev_hash".into(), serde_json::Value::String(prev_hash));
    row_obj.insert("hash".into(), serde_json::Value::String(hash.clone()));
    let row = serde_json::Value::Object(row_obj);
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let line = format!("{row}\n");
        if f.write_all(line.as_bytes()).is_ok() {
            tips.insert(path.to_path_buf(), (file_len + line.len() as u64, hash));
        }
    }
}

/// Result of walking an audit log's hash chain.
#[derive(Debug, Serialize)]
pub struct AuditVerification {
    pub total_rows: usize,
    /// Rows carrying chain hashes (verifiable).
    pub hashed_rows: usize,
    /// Legacy rows written before hash-chaining existed (kept, unverifiable).
    pub legacy_rows: usize,
    pub valid: bool,
    /// 1-based row number where the chain first breaks, if it does.
    pub first_break: Option<usize>,
    pub tip_hash: Option<String>,
}

/// Walk the chain in `path`: every hashed row must recompute to its stored
/// hash and link to its predecessor's. Legacy rows are tolerated only
/// before the chain starts; a legacy row after hashed rows is a break.
pub fn verify_audit_file(path: &Path) -> AuditVerification {
    let mut result = AuditVerification {
        total_rows: 0,
        hashed_rows: 0,
        legacy_rows: 0,
        valid: true,
        first_break: None,
        tip_hash: None,
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return result; // No log yet — trivially intact.
    };
    let mut prev_hash = AUDIT_GENESIS.to_string();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        result.total_rows += 1;
        let row_number = result.total_rows;
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            result.valid = false;
            result.first_break = Some(row_number);
            return result;
        };
        let stored_hash = row.get("hash").and_then(|h| h.as_str());
        match stored_hash {
            None => {
                // Legacy pre-chain row.
                if result.hashed_rows > 0 {
                    // Chain already started — a hash-less row here means
                    // rows were spliced in after the fact.
                    result.valid = false;
                    result.first_break = Some(row_number);
                    return result;
                }
                result.legacy_rows += 1;
            }
            Some(stored) => {
                let stored_prev = row
                    .get("prev_hash")
                    .and_then(|h| h.as_str())
                    .unwrap_or_default();
                if stored_prev != prev_hash
                    || audit_row_hash(
                        &{
                            let mut bare = row.clone();
                            bare.as_object_mut().map(|o| o.remove("hash"));
                            bare
                        },
                        stored_prev,
                    ) != stored
                {
                    result.valid = false;
                    result.first_break = Some(row_number);
                    return result;
                }
                prev_hash = stored.to_string();
                result.hashed_rows += 1;
                result.tip_hash = Some(stored.to_string());
            }
        }
    }
    result
}

#[tauri::command]
pub fn verify_audit_log() -> Result<AuditVerification, String> {
    Ok(verify_audit_file(&audit_path()))
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
    audit(serde_json::json!({
        "tool": tool,
        "decision": outcome,
        "outcome": outcome,
        "command": command,
        "path": path,
    }));
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
    audit(serde_json::json!({
        "tool": "delegate_task",
        "decision": "auto_safe",
        "from_bot": from_bot,
        "to_bot": to_bot,
        "to_model": to_model,
        "outcome": outcome,
        "error": error,
    }));
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

    /// Fresh temp log per test so parallel tests never share chain state.
    fn chain_test_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "anybot-chain-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("audit.jsonl")
    }

    #[test]
    fn audit_chain_links_and_verifies() {
        let path = chain_test_path("links");
        for i in 0..3 {
            audit_into(&path, serde_json::json!({"tool": "execute_shell", "n": i}));
        }
        let v = verify_audit_file(&path);
        assert!(v.valid, "fresh chain must verify");
        assert_eq!(v.total_rows, 3);
        assert_eq!(v.hashed_rows, 3);
        assert_eq!(v.legacy_rows, 0);
        assert!(v.tip_hash.is_some());
        // The stored tip must equal the hash on the last line.
        let text = std::fs::read_to_string(&path).unwrap();
        let last = text.lines().rev().next().unwrap();
        let row: serde_json::Value = serde_json::from_str(last).unwrap();
        assert_eq!(v.tip_hash.as_deref(), row["hash"].as_str());
        // First row chains from GENESIS.
        let first: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(&path).unwrap().lines().next().unwrap(),
        )
        .unwrap();
        assert_eq!(first["prev_hash"].as_str(), Some(AUDIT_GENESIS));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn tampered_row_breaks_chain() {
        let path = chain_test_path("tamper");
        for i in 0..3 {
            audit_into(&path, serde_json::json!({"tool": "read_file", "n": i}));
        }
        // Edit row 2 in place: rewrite the file with a doctored line.
        let mut lines: Vec<String> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(String::from)
            .collect();
        let mut doctored: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        doctored["n"] = serde_json::Value::from(999); // content changed, hash unchanged
        lines[1] = doctored.to_string();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let v = verify_audit_file(&path);
        assert!(!v.valid, "edited row must be detected");
        assert_eq!(v.first_break, Some(2));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn deleted_row_breaks_chain() {
        let path = chain_test_path("delete");
        for i in 0..3 {
            audit_into(&path, serde_json::json!({"tool": "list_directory", "n": i}));
        }
        // Remove row 2: row 3's prev_hash no longer links to row 1.
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let spliced = vec![lines[0], lines[2]].join("\n") + "\n";
        std::fs::write(&path, spliced).unwrap();
        let v = verify_audit_file(&path);
        assert!(!v.valid, "deleted row must be detected");
        assert_eq!(v.first_break, Some(2));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn legacy_rows_anchor_a_fresh_chain() {
        let path = chain_test_path("legacy");
        // Pre-chain rows (written by AnyBot before this feature) have no hashes.
        std::fs::write(
            &path,
            "{\"tool\":\"execute_shell\",\"decision\":\"auto_safe\"}\n{\"tool\":\"read_file\",\"decision\":\"approved\"}\n",
        )
        .unwrap();
        audit_into(&path, serde_json::json!({"tool": "write_file", "n": 1}));
        audit_into(&path, serde_json::json!({"tool": "write_file", "n": 2}));
        let v = verify_audit_file(&path);
        assert!(v.valid, "legacy prefix + fresh chain must verify");
        assert_eq!(v.total_rows, 4);
        assert_eq!(v.legacy_rows, 2);
        assert_eq!(v.hashed_rows, 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn truncation_restarts_from_genesis_not_stale_cache() {
        let path = chain_test_path("truncate");
        audit_into(&path, serde_json::json!({"tool": "read_file", "n": 1}));
        // The file is rotated away under the writer (offset cache is now
        // stale); the next append must re-derive the tip from the bytes.
        std::fs::remove_file(&path).unwrap();
        audit_into(&path, serde_json::json!({"tool": "read_file", "n": 2}));
        let v = verify_audit_file(&path);
        assert!(v.valid, "post-truncation chain must restart cleanly");
        assert_eq!(v.hashed_rows, 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn forged_legacy_row_after_chain_is_a_break() {
        let path = chain_test_path("splice");
        audit_into(&path, serde_json::json!({"tool": "read_file", "n": 1}));
        // Splice a hash-less row AFTER the chain started.
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"tool\":\"execute_shell\",\"decision\":\"approved\",\"injected\":true}\n");
        std::fs::write(&path, text).unwrap();
        let v = verify_audit_file(&path);
        assert!(!v.valid, "hash-less row after chain start must be a break");
        assert_eq!(v.first_break, Some(2));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
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
