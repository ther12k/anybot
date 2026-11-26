//! Read-only import of visible text from the local ZCode CLI 0.18 SQLite store.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::WebviewWindow;

use crate::workspace;

const SESSION_LIST_LIMIT: i64 = 100;
const LIST_TITLE_BYTES: i64 = 4 * 1024;
const ID_BYTES: i64 = 128;
const MAX_TURNS: usize = 400;
const MAX_PAYLOAD_BYTES: usize = 512 * 1024;
const MAX_MESSAGE_ROWS: i64 = 12_000;
const MAX_PART_ROWS: i64 = 50_000;
const MAX_ROW_JSON_BYTES: i64 = 1024 * 1024;
const MAX_TOTAL_JSON_BYTES: usize = 64 * 1024 * 1024;
const DB_ERROR: &str = "Could not read the ZCode session database. It may be busy, unreadable, or use an unsupported schema.";
const NO_DB: &str = "No ZCode CLI session database was found.";
const UNAVAILABLE_SESSION: &str = "This ZCode session is no longer available for import.";
const NO_VISIBLE_TEXT: &str = "This ZCode session has no visible chat text to import.";
const TOO_MUCH_TEXT: &str =
    "This ZCode session exceeds the import limit of 400 messages or 512 KiB. Nothing was imported.";
const RAW_LIMIT: &str = "This ZCode session exceeds the database scan limit. Nothing was imported.";

#[derive(Debug, Serialize)]
pub(crate) struct SessionSummary {
    id: String,
    title: String,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportedSession {
    source: &'static str,
    title: String,
    messages: Vec<ImportedMessage>,
}

#[derive(Debug, Serialize)]
struct ImportedMessage {
    role: Role,
    content: String,
    timestamp: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Assistant,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Semantics {
    ui_visibility: Option<String>,
    transcript_visibility: Option<String>,
    kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowData {
    role: Option<Role>,
    #[serde(rename = "type")]
    part_type: Option<String>,
    text: Option<Value>,
    synthetic: Option<bool>,
    ignored: Option<bool>,
    hidden: Option<bool>,
    summary: Option<Value>,
    node_summary: Option<bool>,
    visibility: Option<String>,
    ui_visibility: Option<String>,
    transcript_visibility: Option<String>,
    semantics: Option<Semantics>,
}

impl RowData {
    fn is_visible(&self) -> bool {
        self.synthetic != Some(true)
            && self.ignored != Some(true)
            && self.hidden != Some(true)
            && self.node_summary != Some(true)
            && self.summary != Some(Value::Bool(true))
            && self
                .visibility
                .as_deref()
                .is_none_or(|value| matches!(value, "visible" | "public" | "user-visible"))
            && self.ui_visibility.as_deref().is_none_or(|v| v == "visible")
            && self
                .transcript_visibility
                .as_deref()
                .is_none_or(|v| v == "visible")
            && self.semantics.as_ref().is_none_or(|semantics| {
                semantics
                    .ui_visibility
                    .as_deref()
                    .is_none_or(|v| v == "visible")
                    && semantics
                        .transcript_visibility
                        .as_deref()
                        .is_none_or(|v| v == "visible")
                    && !matches!(
                        semantics.kind.as_deref(),
                        Some("node_summary" | "node-summary" | "nodeSummary")
                    )
            })
    }
}

struct Position {
    id: String,
    sequence: Option<i64>,
    created: i64,
}

impl Position {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            sequence: row.get(1)?,
            created: row.get(2)?,
        })
    }

    fn cmp(&self, other: &Self, use_sequence: bool) -> Ordering {
        let chronological = || {
            self.created
                .cmp(&other.created)
                .then_with(|| self.id.cmp(&other.id))
        };
        if use_sequence {
            self.sequence.cmp(&other.sequence).then_with(chronological)
        } else {
            // A sequence is an ordinal, not a timestamp. A mixed legacy group
            // falls back to timestamp order for the whole group.
            chronological()
        }
    }
}

struct TextPart {
    position: Position,
    text: String,
}

struct Turn {
    position: Position,
    role: Role,
    parts: Vec<TextPart>,
}

fn db_error(_: rusqlite::Error) -> String {
    DB_ERROR.into()
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_BYTES as usize
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn open_at(path: &Path) -> Result<Option<Connection>, String> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        _ => return Err(DB_ERROR.into()),
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(db_error)?;
    connection
        .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
        .map_err(db_error)?;
    Ok(Some(connection))
}

fn open_zcode() -> Result<Option<Connection>, String> {
    let path = workspace::expand_tilde("~/.zcode/cli/db/db.sqlite")?;
    open_at(&path)
}

#[tauri::command]
pub(crate) async fn list_zcode_sessions(
    window: WebviewWindow,
) -> Result<Vec<SessionSummary>, String> {
    workspace::require_owner_window(&window)?;
    tokio::task::spawn_blocking(|| match open_zcode()? {
        Some(connection) => list_sessions(&connection),
        None => Ok(Vec::new()),
    })
    .await
    .map_err(|_| DB_ERROR.to_owned())?
}

#[tauri::command]
pub(crate) async fn read_zcode_session(
    window: WebviewWindow,
    session_id: String,
) -> Result<ImportedSession, String> {
    workspace::require_owner_window(&window)?;
    if !valid_session_id(&session_id) {
        return Err("Invalid ZCode session ID.".into());
    }
    tokio::task::spawn_blocking(move || {
        let mut connection = open_zcode()?.ok_or(NO_DB)?;
        read_session(&mut connection, &session_id)
    })
    .await
    .map_err(|_| DB_ERROR.to_owned())?
}

fn list_sessions(connection: &Connection) -> Result<Vec<SessionSummary>, String> {
    let mut query = connection
        .prepare(
            "SELECT id, CASE WHEN octet_length(title) <= ?1 THEN title
                             ELSE 'ZCode session (long title)' END, time_updated
             FROM session
             WHERE parent_id IS NULL AND time_deleted IS NULL AND time_archived IS NULL
               AND octet_length(id) BETWEEN 1 AND ?2 AND id NOT GLOB '*[^a-zA-Z0-9_-]*'
             ORDER BY time_updated DESC, id ASC LIMIT ?3",
        )
        .map_err(db_error)?;
    query
        .query_map(
            params![LIST_TITLE_BYTES, ID_BYTES, SESSION_LIST_LIMIT],
            |row| {
                Ok(SessionSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)
}

fn decode_row(row: &Row<'_>, remaining_json: &mut usize) -> Result<RowData, String> {
    let raw = row.get_ref(3).map_err(db_error)?;
    if raw == rusqlite::types::ValueRef::Null {
        return Err(RAW_LIMIT.into());
    }
    let raw = raw.as_str().map_err(|_| DB_ERROR)?;
    *remaining_json = remaining_json.checked_sub(raw.len()).ok_or(RAW_LIMIT)?;
    serde_json::from_str(raw).map_err(|_| DB_ERROR.into())
}

fn read_session(connection: &mut Connection, id: &str) -> Result<ImportedSession, String> {
    // One snapshot: the CLI can append text, delete or archive a session
    // while we are reading it. This transaction never writes anything.
    let tx = connection.transaction().map_err(db_error)?;
    let title: Option<String> = tx
        .query_row(
            "SELECT CASE WHEN octet_length(title) <= ?2 THEN title END FROM session
             WHERE id = ?1 AND parent_id IS NULL AND time_deleted IS NULL AND time_archived IS NULL",
            params![id, MAX_PAYLOAD_BYTES as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or(UNAVAILABLE_SESSION)?;
    let title = title.ok_or(TOO_MUCH_TEXT)?;
    let mut remaining_json = MAX_TOTAL_JSON_BYTES;
    let mut turns = HashMap::new();
    {
        // octet_length(column) can use SQLite's record metadata without
        // loading an oversized value; the CASE never returns the raw value.
        let mut query = tx
            .prepare(
                "SELECT CASE WHEN octet_length(id) <= ?2 THEN id END, sequence, time_created,
                        CASE WHEN octet_length(data) <= ?3 THEN data END
                 FROM message WHERE session_id = ?1 LIMIT ?4",
            )
            .map_err(db_error)?;
        let mut rows = query
            .query(params![
                id,
                ID_BYTES,
                MAX_ROW_JSON_BYTES,
                MAX_MESSAGE_ROWS + 1
            ])
            .map_err(db_error)?;
        let mut count = 0;
        while let Some(row) = rows.next().map_err(db_error)? {
            count += 1;
            if count > MAX_MESSAGE_ROWS {
                return Err(RAW_LIMIT.into());
            }
            let data = decode_row(row, &mut remaining_json)?;
            if let Some(role @ (Role::User | Role::Assistant)) = data.role
                && data.is_visible()
            {
                let position = Position::from_row(row).map_err(db_error)?;
                turns.insert(
                    position.id.clone(),
                    Turn {
                        position,
                        role,
                        parts: Vec::new(),
                    },
                );
            }
        }
    }
    if turns.is_empty() {
        return Err(NO_VISIBLE_TEXT.into());
    }

    {
        // Fetch parts for visible messages in a single SELECT. Pass the IDs
        // as a bound array so session length cannot affect SQL text or cause
        // one trip to SQLite per message.
        let ids = serde_json::to_string(&turns.keys().collect::<Vec<_>>()).map_err(|_| DB_ERROR)?;
        let mut query = tx
            .prepare(
                "SELECT CASE WHEN octet_length(id) <= ?3 THEN id END, sequence, time_created,
                        CASE WHEN octet_length(data) <= ?4 THEN data END, message_id
                 FROM part WHERE session_id = ?1 AND message_id IN (SELECT value FROM json_each(?2))
                 LIMIT ?5",
            )
            .map_err(db_error)?;
        let mut rows = query
            .query(params![
                id,
                ids,
                ID_BYTES,
                MAX_ROW_JSON_BYTES,
                MAX_PART_ROWS + 1
            ])
            .map_err(db_error)?;
        let mut count = 0;
        let mut output_bytes = title.len();
        let mut output_turns = 0;
        while let Some(row) = rows.next().map_err(db_error)? {
            count += 1;
            if count > MAX_PART_ROWS {
                return Err(RAW_LIMIT.into());
            }
            let data = decode_row(row, &mut remaining_json)?;
            if data.part_type.as_deref() != Some("text") || !data.is_visible() {
                continue;
            }
            let Some(Value::String(text)) = data.text else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let message_id = row
                .get_ref(4)
                .map_err(db_error)?
                .as_str()
                .map_err(|_| DB_ERROR)?;
            let turn = turns.get_mut(message_id).ok_or(DB_ERROR)?;
            if turn.parts.is_empty() {
                output_turns += 1;
            } else {
                output_bytes += 2; // blank line separator
            }
            output_bytes += text.len();
            if output_turns > MAX_TURNS || output_bytes > MAX_PAYLOAD_BYTES {
                return Err(TOO_MUCH_TEXT.into());
            }
            turn.parts.push(TextPart {
                position: Position::from_row(row).map_err(db_error)?,
                text,
            });
        }
    }
    tx.commit().map_err(db_error)?;

    let mut turns: Vec<_> = turns
        .into_values()
        .filter(|turn| !turn.parts.is_empty())
        .collect();
    if turns.is_empty() {
        return Err(NO_VISIBLE_TEXT.into());
    }
    let sequenced = turns.iter().all(|turn| turn.position.sequence.is_some());
    turns.sort_unstable_by(|a, b| a.position.cmp(&b.position, sequenced));
    let messages = turns
        .into_iter()
        .map(|mut turn| {
            let sequenced = turn
                .parts
                .iter()
                .all(|part| part.position.sequence.is_some());
            turn.parts
                .sort_unstable_by(|a, b| a.position.cmp(&b.position, sequenced));
            let mut content = String::new();
            for part in turn.parts {
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str(&part.text);
            }
            ImportedMessage {
                role: turn.role,
                content,
                timestamp: turn.position.created,
            }
        })
        .collect();
    let result = ImportedSession {
        source: "zcode",
        title,
        messages,
    };
    // Include JSON escaping and the envelope in the cap, not just text bytes.
    if serde_json::to_vec(&result).map_err(|_| DB_ERROR)?.len() > MAX_PAYLOAD_BYTES {
        return Err(TOO_MUCH_TEXT.into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCHEMA: &str = "
        CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT,
                              time_updated INTEGER NOT NULL, time_deleted INTEGER, time_archived INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER,
                              time_created INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX message_session_sequence_idx ON message(session_id, sequence, time_created, id);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                           sequence INTEGER, time_created INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX part_session_message_sequence_idx ON part(session_id, message_id, sequence);
        INSERT INTO session VALUES ('sess_root', 'Example', NULL, 10, NULL, NULL);
    ";
    const SESSION: &str = "sess_root";

    fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db
    }

    fn message(db: &Connection, id: &str, sequence: Option<i64>, time: i64, data: Value) {
        db.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, SESSION, sequence, time, data.to_string()],
        )
        .unwrap();
    }

    fn part(
        db: &Connection,
        id: &str,
        message_id: &str,
        sequence: Option<i64>,
        time: i64,
        data: Value,
    ) {
        db.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, message_id, SESSION, sequence, time, data.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn lists_newest_eligible_roots_and_caps_results() {
        let mut db = fixture();
        db.execute_batch(
            "INSERT INTO session VALUES
            ('sess_child', 'Child', 'sess_root', 1000, NULL, NULL),
            ('sess_deleted', 'Deleted', NULL, 1000, 1, NULL),
            ('sess_archived', 'Archived', NULL, 1000, NULL, 1),
            ('sess_root_a', 'First tie', NULL, 10, NULL, NULL),
            ('sess_new', 'New', NULL, 11, NULL, NULL);",
        )
        .unwrap();
        let list = list_sessions(&db).unwrap();
        assert_eq!(
            serde_json::to_value(&list[0]).unwrap(),
            json!({"id":"sess_new","title":"New","updated_at":11})
        );
        assert_eq!(
            list.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["sess_new", "sess_root", "sess_root_a"]
        );
        for id in [
            "sess_child",
            "sess_archived",
            "sess_deleted",
            "not_found",
            "' OR 1=1 --",
        ] {
            assert_eq!(read_session(&mut db, id).unwrap_err(), UNAVAILABLE_SESSION);
        }
        assert!(!valid_session_id("' OR 1=1 --"));
        assert!(valid_session_id(
            "sess_00000000-0000-0000-0000-000000000000"
        ));
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 125)
            INSERT INTO session SELECT 's_' || i, 'Title', NULL, i+20, NULL, NULL FROM n;",
        )
        .unwrap();
        assert_eq!(
            list_sessions(&db).unwrap().len(),
            SESSION_LIST_LIMIT as usize
        );
    }

    #[test]
    fn reads_only_visible_top_level_text_in_sequence_order() {
        let mut db = fixture();
        message(
            &db,
            "ask",
            Some(1),
            400,
            json!({"role":"user","summary":{"diffs":[]},"semantics":{"uiVisibility":"visible","transcriptVisibility":"visible"}}),
        );
        message(&db, "answer", Some(2), 200, json!({"role":"assistant"}));
        part(
            &db,
            "first",
            "ask",
            Some(1),
            30,
            json!({"type":"text","text":"Prompt\n"}),
        );
        part(
            &db,
            "second",
            "ask",
            Some(2),
            20,
            json!({"type":"text","text":"Details"}),
        );
        part(
            &db,
            "reply",
            "answer",
            Some(1),
            10,
            json!({"type":"text","text":"Response"}),
        );
        for (i, data) in [
            json!({"role":"user","synthetic":true}),
            json!({"role":"user","visibility":"model-only"}),
            json!({"role":"assistant","semantics":{"uiVisibility":"hidden"}}),
            json!({"role":"assistant","semantics":{"transcriptVisibility":"hidden"}}),
            json!({"role":"assistant","semantics":{"kind":"node_summary"}}),
            json!({"role":"assistant","summary":true}),
            json!({"role":"assistant","nodeSummary":true}),
            json!({"role":"system"}),
            json!({"role":"assistant"}), // only a part from a different session
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("m{i}");
            message(&db, &id, Some(0), 0, data);
            if i != 8 {
                part(
                    &db,
                    &format!("p{i}"),
                    &id,
                    Some(0),
                    0,
                    json!({"type":"text","text":"Must not appear"}),
                );
            }
        }
        db.execute(
            "INSERT INTO part VALUES ('outside', 'm8', 'other_session', 0, 0, ?1)",
            [json!({"type":"text","text":"Outside session"}).to_string()],
        )
        .unwrap();
        for (i, data) in [
            json!({"type":"tool", "text":"Tool output"}),
            json!({"type":"reasoning", "text":"Hidden reasoning"}),
            json!({"type":"file", "text":"File"}),
            json!({"type":"text", "text":{"text":"Not a string"}}),
            json!({"type":"text", "text":"Synthetic", "synthetic":true}),
            json!({"type":"text", "text":"Ignored", "ignored":true}),
            json!({"type":"text", "text":"Hidden", "hidden":true}),
            json!({"type":"text", "text":"Hidden", "semantics":{"uiVisibility":"hidden"}}),
            json!({"type":"text", "text":"Model only", "visibility":"model-only"}),
        ]
        .into_iter()
        .enumerate()
        {
            part(&db, &format!("excluded{i}"), "ask", Some(0), 0, data);
        }
        let result = read_session(&mut db, SESSION).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "source":"zcode", "title":"Example", "messages":[
                    {"role":"user","content":"Prompt\n\n\nDetails","timestamp":400},
                    {"role":"assistant","content":"Response","timestamp":200}
                ]
            })
        );
    }

    #[test]
    fn mixed_sequences_fall_back_to_time_then_id_per_group() {
        let mut db = fixture();
        for (id, seq, time) in [("a", Some(3), 10), ("b", None, 10), ("c", Some(0), 20)] {
            message(&db, id, seq, time, json!({"role":"user"}));
            part(
                &db,
                &format!("part-{id}"),
                id,
                Some(5),
                10,
                json!({"type":"text","text":id}),
            );
        }
        part(
            &db,
            "a-legacy",
            "a",
            None,
            9,
            json!({"type":"text","text":"First"}),
        );
        part(
            &db,
            "z-tied",
            "a",
            Some(0),
            10,
            json!({"type":"text","text":"Last"}),
        );
        let result = read_session(&mut db, SESSION).unwrap();
        assert_eq!(
            result
                .messages
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            ["First\n\na\n\nLast", "b", "c"]
        );
    }

    #[test]
    fn empty_and_oversized_sessions_return_errors_without_partial_output() {
        let mut db = fixture();
        message(&db, "m", Some(1), 1, json!({"role":"user"}));
        assert_eq!(read_session(&mut db, SESSION).unwrap_err(), NO_VISIBLE_TEXT);
        part(
            &db,
            "p",
            "m",
            Some(1),
            1,
            json!({"type":"text","text":"\u{0000}".repeat(MAX_PAYLOAD_BYTES / 6)}),
        );
        // Retained text alone is under the limit; the serialized payload is not.
        assert_eq!(read_session(&mut db, SESSION).unwrap_err(), TOO_MUCH_TEXT);
        db.execute(
            "UPDATE part SET data = ?1",
            [json!({"type":"tool","value":"x".repeat(MAX_ROW_JSON_BYTES as usize)}).to_string()],
        )
        .unwrap();
        assert_eq!(read_session(&mut db, SESSION).unwrap_err(), RAW_LIMIT);
        db.execute_batch("DELETE FROM part;").unwrap();
        for i in 0..=MAX_TURNS {
            let id = format!("turn-{i}");
            message(&db, &id, Some(i as i64), i as i64, json!({"role":"user"}));
            part(
                &db,
                &id,
                &id,
                Some(0),
                i as i64,
                json!({"type":"text","text":"hello"}),
            );
        }
        assert_eq!(read_session(&mut db, SESSION).unwrap_err(), TOO_MUCH_TEXT);
    }

    #[test]
    fn opens_missing_and_live_wal_fixture_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("db.sqlite");
        assert!(open_at(&path).unwrap().is_none());
        assert!(!path.exists());
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        writer.execute_batch(SCHEMA).unwrap();
        message(&writer, "m", Some(0), 1, json!({"role":"user"}));
        part(
            &writer,
            "p",
            "m",
            Some(0),
            1,
            json!({"type":"text","text":"New in WAL"}),
        );
        let mut db = open_at(&path).unwrap().unwrap();
        assert!(db.is_readonly(rusqlite::DatabaseName::Main).unwrap());
        for (pragma, expected) in [("query_only", 1i32), ("trusted_schema", 0)] {
            assert_eq!(
                db.pragma_query_value(None, pragma, |row| row.get::<_, i32>(0))
                    .unwrap(),
                expected
            );
        }
        assert!(db.execute("DELETE FROM session", []).is_err());
        assert_eq!(
            read_session(&mut db, SESSION).unwrap().messages[0].content,
            "New in WAL"
        );
    }
}
