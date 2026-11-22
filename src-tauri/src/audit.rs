use std::collections::VecDeque;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

use crate::policy::audit_path;
use crate::proposal::sha256_hex;

pub(crate) const AUDIT_GENESIS: &str = "GENESIS";
const RECENT_LIMIT: usize = 25;
const MAX_ROW_BYTES: usize = 1024 * 1024;
const APPEND_ERROR: &str = "Could not save the audit entry.";

// Serializes appends and snapshot acquisition within this process. The tip
// cache is an optimization, not a trusted checkpoint or a cross-process lock.
static WRITER: Mutex<Option<AuditTip>> = Mutex::new(None);
static RECORDING_FAILED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

struct AuditTip {
    path: PathBuf,
    stamp: FileStamp,
    hash: String,
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64),
    #[cfg(windows)]
    created: SystemTime,
}

impl FileStamp {
    fn from_metadata(meta: &Metadata) -> Option<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        Some(Self {
            len: meta.len(),
            modified: meta.modified().ok()?,
            #[cfg(unix)]
            identity: (meta.dev(), meta.ino()),
            #[cfg(windows)]
            created: meta.created().ok()?,
        })
    }
}

pub(crate) fn init_notifications(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

#[tauri::command]
pub fn has_audit_recording_failure() -> bool {
    RECORDING_FAILED.load(Ordering::SeqCst)
}

pub(crate) fn record_audit(event: Value) -> Result<(), String> {
    record_audit_at(&audit_path(), event)
}

// Report recording failures separately from the action outcome. An already
// applied edit or executed command cannot be undone by changing its IPC result.
pub(crate) fn record_audit_at(path: &Path, event: Value) -> Result<(), String> {
    audit_into(path, event).map_err(|error| {
        if !RECORDING_FAILED.swap(true, Ordering::SeqCst) {
            log::warn!(
                "Could not append to the local audit log: {:?}",
                error.kind()
            );
            if let Some(app) = APP.get() {
                if app.emit("audit-recording-failed", true).is_err() {
                    log::warn!("Could not notify the workspace of an audit recording failure.");
                }
            }
        }
        APPEND_ERROR.into()
    })
}

fn open_audit_log(path: &Path, append: bool) -> io::Result<File> {
    let not_regular = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Audit log is not a regular file",
        )
    };
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() => return Err(not_regular()),
        Err(error) if !append || error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.read(true);
    if append {
        options.append(true).create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(not_regular());
    }
    Ok(file)
}

// Preserve the on-disk hash format: sort keys recursively, serialize the
// whole row except `hash`, and include its link to the previous record.
fn canonicalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<String, Value> = map
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize).collect()),
        other => other,
    }
}

fn audit_row_hash(row: &Value) -> String {
    sha256_hex(canonicalize(row.clone()).to_string().as_bytes())
}

fn audit_into(path: &Path, mut event: Value) -> io::Result<()> {
    let row = event.as_object_mut().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Audit entry is not an object")
    })?;
    row.remove("hash");
    row.entry("ts")
        .or_insert_with(|| Value::String(chrono_free_iso8601_now()));

    let mut writer = WRITER
        .lock()
        .map_err(|_| io::Error::other("Audit writer unavailable"))?;
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = open_audit_log(path, true)?;
    let meta = file.metadata()?;
    let original_stamp = FileStamp::from_metadata(&meta);
    let (prev_hash, separator) = match writer.as_ref() {
        Some(tip) if tip.path == path && original_stamp.as_ref() == Some(&tip.stamp) => {
            (tip.hash.clone(), false)
        }
        _ => {
            file.seek(SeekFrom::Start(0))?;
            let scan = scan_audit(&mut file, meta.len(), false)?;
            if scan.status == AuditStatus::Broken {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Existing audit chain is broken",
                ));
            }
            (
                scan.tip_hash.unwrap_or_else(|| AUDIT_GENESIS.into()),
                !scan.last_line_terminated,
            )
        }
    };

    event["prev_hash"] = Value::String(prev_hash);
    let hash = audit_row_hash(&event);
    event["hash"] = Value::String(hash.clone());
    let mut line = format!("{event}\n");
    if line.len() - 1 > MAX_ROW_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audit entry exceeds the row size limit",
        ));
    }
    if separator {
        line.insert(0, '\n');
    }
    let current = file.metadata()?;
    if current.len() != meta.len()
        || original_stamp.is_some() && FileStamp::from_metadata(&current) != original_stamp
    {
        return Err(io::Error::other("Audit log changed during append"));
    }
    *writer = None;
    file.write_all(line.as_bytes())?;
    let current = file.metadata()?;
    if current.len() != meta.len() + line.len() as u64 {
        return Err(io::Error::other("Audit log changed during append"));
    }
    *writer = FileStamp::from_metadata(&current).map(|stamp| AuditTip {
        path: path.into(),
        stamp,
        hash,
    });
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuditStatus {
    Missing,
    Empty,
    LegacyOnly,
    Consistent,
    Broken,
    Unreadable,
}

#[derive(Debug, Serialize)]
pub struct AuditVerification {
    pub(crate) status: AuditStatus,
    pub(crate) total_rows: usize,
    pub(crate) hashed_rows: usize,
    pub(crate) legacy_rows: usize,
    pub(crate) first_break: Option<usize>,
    recent: Vec<AuditActivity>,
    #[serde(skip)]
    pub(crate) tip_hash: Option<String>,
    #[serde(skip)]
    last_line_terminated: bool,
}

impl AuditVerification {
    fn new(status: AuditStatus) -> Self {
        Self {
            status,
            total_rows: 0,
            hashed_rows: 0,
            legacy_rows: 0,
            first_break: None,
            recent: Vec::new(),
            tip_hash: None,
            last_line_terminated: true,
        }
    }

    fn broken(mut self) -> Self {
        self.status = AuditStatus::Broken;
        self.first_break = Some(self.total_rows);
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum AuditTool {
    ExecuteShell,
    ReadFile,
    WriteFile,
    ListDirectory,
    DelegateTask,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AuditOutcome {
    Completed,
    Failed,
    Blocked,
    Rejected,
    Cancelled,
    Killed,
    Timeout,
}

#[derive(Debug, Serialize)]
struct AuditActivity {
    record: usize,
    tool: AuditTool,
    outcome: AuditOutcome,
    timestamp: Option<String>,
}

impl AuditActivity {
    fn from_checked_row(record: usize, row: &Value) -> Option<Self> {
        let tool = match row.get("tool")?.as_str()? {
            "execute_shell" => AuditTool::ExecuteShell,
            "read_file" => AuditTool::ReadFile,
            "write_file" => AuditTool::WriteFile,
            "list_directory" => AuditTool::ListDirectory,
            "delegate_task" => AuditTool::DelegateTask,
            _ => return None,
        };
        let outcome = match (tool, row.get("outcome")?.as_str()?) {
            (_, "completed") => AuditOutcome::Completed,
            (_, "failed") | (AuditTool::ExecuteShell, "error" | "spawn_error") => {
                AuditOutcome::Failed
            }
            (_, "blocked") | (AuditTool::ExecuteShell, "denied" | "proposal_invalid") => {
                AuditOutcome::Blocked
            }
            (_, "rejected") => AuditOutcome::Rejected,
            (_, "cancelled") => AuditOutcome::Cancelled,
            (AuditTool::ExecuteShell, "killed") => AuditOutcome::Killed,
            (AuditTool::ExecuteShell, "timeout") => AuditOutcome::Timeout,
            _ => return None,
        };
        let timestamp = row
            .get("ts")
            .and_then(Value::as_str)
            .filter(|ts| is_audit_timestamp(ts));
        Some(Self {
            record,
            tool,
            outcome,
            timestamp: timestamp.map(str::to_owned),
        })
    }
}

// Only the writer's fixed-width UTC format is displayable, never free-form
// timestamp text from rows edited or written by earlier versions.
fn is_audit_timestamp(ts: &str) -> bool {
    let bytes = ts.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(i, &byte)| match i {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'.',
            23 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}

// A length-limited reader excludes later appends without holding the writer
// lock for the entire scan. Edits by external processes are not coordinated.
fn scan_audit(file: &mut File, len: u64, activity: bool) -> io::Result<AuditVerification> {
    let mut result = AuditVerification::new(AuditStatus::Empty);
    let mut reader = BufReader::new(file.take(len));
    let mut recent = VecDeque::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = (&mut reader)
            .take((MAX_ROW_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        result.last_line_terminated = line.ends_with(b"\n");
        if count - usize::from(result.last_line_terminated) > MAX_ROW_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Audit row exceeds the verification limit",
            ));
        }
        if std::str::from_utf8(&line).is_ok_and(|line| line.trim().is_empty()) {
            continue;
        }

        result.total_rows += 1;
        let Ok(Value::Object(mut fields)) = serde_json::from_slice::<Value>(&line) else {
            return Ok(result.broken());
        };
        match fields.remove("hash") {
            None if result.hashed_rows == 0 && !fields.contains_key("prev_hash") => {
                result.legacy_rows += 1;
            }
            Some(Value::String(stored)) => {
                let row = Value::Object(fields);
                let prev_hash = result.tip_hash.as_deref().unwrap_or(AUDIT_GENESIS);
                if row.get("prev_hash").and_then(Value::as_str) != Some(prev_hash)
                    || audit_row_hash(&row) != stored
                {
                    return Ok(result.broken());
                }
                if activity {
                    if let Some(item) = AuditActivity::from_checked_row(result.total_rows, &row) {
                        if recent.len() == RECENT_LIMIT {
                            recent.pop_front();
                        }
                        recent.push_back(item);
                    }
                }
                result.hashed_rows += 1;
                result.tip_hash = Some(stored);
            }
            _ => return Ok(result.broken()),
        }
    }
    if reader.into_inner().limit() != 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Audit log shortened during verification",
        ));
    }
    if result.hashed_rows > 0 {
        result.status = AuditStatus::Consistent;
        result.recent = recent.into_iter().rev().collect();
    } else if result.legacy_rows > 0 {
        result.status = AuditStatus::LegacyOnly;
    }
    Ok(result)
}

pub(crate) fn verify_audit_file(path: &Path) -> AuditVerification {
    let snapshot = || {
        let _writer = WRITER
            .lock()
            .map_err(|_| io::Error::other("Audit writer unavailable"))?;
        let file = open_audit_log(path, false)?;
        let len = file.metadata()?.len();
        Ok::<_, io::Error>((file, len))
    };
    match snapshot() {
        Ok((mut file, len)) => scan_audit(&mut file, len, true)
            .unwrap_or_else(|_| AuditVerification::new(AuditStatus::Unreadable)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            AuditVerification::new(AuditStatus::Missing)
        }
        Err(_) => AuditVerification::new(AuditStatus::Unreadable),
    }
}

#[tauri::command]
pub async fn verify_audit_log() -> Result<AuditVerification, String> {
    tokio::task::spawn_blocking(|| verify_audit_file(&audit_path()))
        .await
        .map_err(|_| "Audit verification could not finish.".into())
}

/// RFC3339 UTC timestamp without pulling a chrono dependency.
fn chrono_free_iso8601_now() -> String {
    let ms = SystemTime::now()
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

#[cfg(test)]
#[path = "audit_tests.rs"]
mod tests;
