use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

/// Status and metadata of a detected local agent CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedAgentCli {
    pub engine: String,
    pub name: String,
    pub binary: String,
    pub path: Option<String>,
    pub is_installed: bool,
    pub version: Option<String>,
    pub protocol: String, // "acp-stream-json" | "acp-jsonrpc" | "batch"
}

/// Normalized streaming event emitted to frontend during ACP / BYOP runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpStreamEvent {
    pub session_id: String,
    pub event_type: String, // "thinking" | "content" | "tool_call" | "finished" | "error"
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub error: Option<String>,
}

static RUNNING_ACP: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Look up an executable in PATH or standard user directories.
fn find_binary(bin_name: &str) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Common extra local paths on Linux/macOS
    let home = std::env::var("HOME").unwrap_or_default();
    let common_fallbacks = [
        format!("{}/.local/bin/{}", home, bin_name),
        format!("{}/.cargo/bin/{}", home, bin_name),
        format!("/usr/local/bin/{}", bin_name),
        format!("/usr/bin/{}", bin_name),
        format!("/opt/{}/{}", bin_name, bin_name),
    ];
    for fb in &common_fallbacks {
        let p = Path::new(fb);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }

    None
}

/// Query an executable for its version string.
async fn query_version(bin_path: &Path, arg: &str) -> Option<String> {
    let mut cmd = Command::new(bin_path);
    cmd.arg(arg).stdout(Stdio::piped()).stderr(Stdio::null());
    match timeout(Duration::from_millis(1500), cmd.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let out_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let first_line = out_str.lines().next().unwrap_or("").trim().to_string();
            if first_line.is_empty() {
                None
            } else {
                Some(first_line)
            }
        }
        _ => None,
    }
}

/// Scan host for supported BYOP / ACP Agent CLIs.
#[tauri::command]
pub async fn detect_agent_clis() -> Result<Vec<DetectedAgentCli>, String> {
    let mut results = Vec::new();

    // 1. Claude Code CLI
    let claude_path = find_binary("claude");
    let (claude_installed, claude_ver) = if let Some(ref p) = claude_path {
        let ver = query_version(p, "--version").await;
        (true, ver)
    } else {
        (false, None)
    };
    results.push(DetectedAgentCli {
        engine: "claude".to_string(),
        name: "Claude Code".to_string(),
        binary: "claude".to_string(),
        path: claude_path.map(|p| p.to_string_lossy().to_string()),
        is_installed: claude_installed,
        version: claude_ver,
        protocol: "acp-stream-json".to_string(),
    });

    // 2. OpenAI Codex CLI
    let codex_path = find_binary("codex");
    let (codex_installed, codex_ver) = if let Some(ref p) = codex_path {
        let ver = query_version(p, "--version").await;
        (true, ver)
    } else {
        (false, None)
    };
    results.push(DetectedAgentCli {
        engine: "codex".to_string(),
        name: "Codex CLI".to_string(),
        binary: "codex".to_string(),
        path: codex_path.map(|p| p.to_string_lossy().to_string()),
        is_installed: codex_installed,
        version: codex_ver,
        protocol: "acp-jsonrpc".to_string(),
    });

    // 3. OpenCode CLI
    let opencode_path = find_binary("opencode");
    let (opencode_installed, opencode_ver) = if let Some(ref p) = opencode_path {
        let ver = query_version(p, "--version").await;
        (true, ver)
    } else {
        (false, None)
    };
    results.push(DetectedAgentCli {
        engine: "opencode".to_string(),
        name: "OpenCode".to_string(),
        binary: "opencode".to_string(),
        path: opencode_path.map(|p| p.to_string_lossy().to_string()),
        is_installed: opencode_installed,
        version: opencode_ver,
        protocol: "acp-jsonrpc".to_string(),
    });

    // 4. ZCode CLI
    let zcode_path = find_binary("zcode");
    let (zcode_installed, zcode_ver) = if let Some(ref p) = zcode_path {
        let ver = query_version(p, "--version").await;
        (true, ver)
    } else {
        (false, None)
    };
    results.push(DetectedAgentCli {
        engine: "zcode".to_string(),
        name: "ZCode".to_string(),
        binary: "zcode".to_string(),
        path: zcode_path.map(|p| p.to_string_lossy().to_string()),
        is_installed: zcode_installed,
        version: zcode_ver,
        protocol: "acp-jsonrpc".to_string(),
    });

    // 5. Antigravity CLI (agy)
    let agy_path = find_binary("agy");
    let (agy_installed, agy_ver) = if let Some(ref p) = agy_path {
        let ver = query_version(p, "--version").await;
        (true, ver)
    } else {
        (false, None)
    };
    results.push(DetectedAgentCli {
        engine: "agy".to_string(),
        name: "Antigravity (agy)".to_string(),
        binary: "agy".to_string(),
        path: agy_path.map(|p| p.to_string_lossy().to_string()),
        is_installed: agy_installed,
        version: agy_ver,
        protocol: "acp-stdio".to_string(),
    });

    Ok(results)
}

/// Normalizes an incoming line of stdout from a stream-json or JSON-RPC agent into an AcpStreamEvent.
pub fn parse_acp_line(session_id: &str, line: &str) -> Option<AcpStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Try parsing as JSON object
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        // Case 1: Claude Code CLI stream-json format
        if let Some(event_type) = v.get("type").and_then(|t| t.as_str()) {
            match event_type {
                "content_block_delta" => {
                    if let Some(delta) = v.get("delta") {
                        if delta.get("type").and_then(|t| t.as_str()) == Some("thinking_delta") {
                            return Some(AcpStreamEvent {
                                session_id: session_id.to_string(),
                                event_type: "thinking".to_string(),
                                text: delta.get("thinking").and_then(|s| s.as_str()).map(String::from),
                                tool_name: None,
                                tool_args: None,
                                error: None,
                            });
                        }
                        if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            return Some(AcpStreamEvent {
                                session_id: session_id.to_string(),
                                event_type: "content".to_string(),
                                text: delta.get("text").and_then(|s| s.as_str()).map(String::from),
                                tool_name: None,
                                tool_args: None,
                                error: None,
                            });
                        }
                    }
                }
                "assistant" => {
                    // Assistant message chunk or block
                    if let Some(content) = v.get("content").and_then(|c| c.as_str()) {
                        return Some(AcpStreamEvent {
                            session_id: session_id.to_string(),
                            event_type: "content".to_string(),
                            text: Some(content.to_string()),
                            tool_name: None,
                            tool_args: None,
                            error: None,
                        });
                    }
                }
                "error" => {
                    let err_msg = v.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .or_else(|| v.get("message").and_then(|m| m.as_str()))
                        .unwrap_or("Unknown agent error");
                    return Some(AcpStreamEvent {
                        session_id: session_id.to_string(),
                        event_type: "error".to_string(),
                        text: None,
                        tool_name: None,
                        tool_args: None,
                        error: Some(err_msg.to_string()),
                    });
                }
                _ => {}
            }
        }

        // Case 2: Standard ACP JSON-RPC format (method notifications)
        if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
            match method {
                "agent/thinking" => {
                    let text = v.get("params")
                        .and_then(|p| p.get("text"))
                        .and_then(|t| t.as_str())
                        .map(String::from);
                    return Some(AcpStreamEvent {
                        session_id: session_id.to_string(),
                        event_type: "thinking".to_string(),
                        text,
                        tool_name: None,
                        tool_args: None,
                        error: None,
                    });
                }
                "agent/content" => {
                    let text = v.get("params")
                        .and_then(|p| p.get("text"))
                        .and_then(|t| t.as_str())
                        .map(String::from);
                    return Some(AcpStreamEvent {
                        session_id: session_id.to_string(),
                        event_type: "content".to_string(),
                        text,
                        tool_name: None,
                        tool_args: None,
                        error: None,
                    });
                }
                "agent/toolCall" => {
                    let params = v.get("params");
                    let tool_name = params
                        .and_then(|p| p.get("name"))
                        .and_then(|n| n.as_str())
                        .map(String::from);
                    let tool_args = params
                        .and_then(|p| p.get("arguments"))
                        .map(|a| a.to_string());
                    return Some(AcpStreamEvent {
                        session_id: session_id.to_string(),
                        event_type: "tool_call".to_string(),
                        text: None,
                        tool_name,
                        tool_args,
                        error: None,
                    });
                }
                _ => {}
            }
        }
    }

    // Fallback: If not parsed as JSON, treat raw text line as content
    Some(AcpStreamEvent {
        session_id: session_id.to_string(),
        event_type: "content".to_string(),
        text: Some(format!("{}\n", trimmed)),
        tool_name: None,
        tool_args: None,
        error: None,
    })
}

/// Run an agent prompt via its CLI subprocess with streaming output.
#[tauri::command]
pub async fn run_acp_prompt(
    session_id: String,
    engine: String,
    prompt: String,
    cwd: Option<String>,
    channel: tauri::ipc::Channel<AcpStreamEvent>,
) -> Result<bool, String> {
    let bin_path = find_binary(&engine).ok_or_else(|| {
        format!(
            "Agent CLI for '{}' not found on system. Install it or check PATH.",
            engine
        )
    })?;

    let work_dir = cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let mut cmd = Command::new(&bin_path);
    cmd.current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Configure flags per engine
    match engine.as_str() {
        "claude" => {
            // Claude Code CLI options
            cmd.arg("-p")
                .arg(&prompt)
                .arg("--output-format=stream-json")
                .arg("--verbose")
                .arg("--include-partial-messages");
        }
        "codex" => {
            // Codex CLI in prompt/exec mode
            cmd.arg("exec").arg(&prompt);
        }
        "opencode" => {
            // OpenCode agent prompt mode
            cmd.arg("--prompt").arg(&prompt);
        }
        "zcode" => {
            // ZCode non-interactive batch/prompt mode
            cmd.arg("--prompt").arg(&prompt);
        }
        "agy" => {
            // Antigravity CLI print mode with stream-json format
            cmd.arg("-p")
                .arg(&prompt)
                .arg("--output-format=stream-json");
        }
        _ => {
            // Generic fallback
            cmd.arg("-p").arg(&prompt);
        }
    }

    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn agent {engine}: {e}"))?;

    let pid = child.id().unwrap_or(0);
    if pid > 0 {
        if let Ok(mut map) = RUNNING_ACP.lock() {
            map.insert(session_id.clone(), pid);
        }
    }

    // Pipe stdout line by line
    if let Some(stdout) = child.stdout.take() {
        let sid = session_id.clone();
        let ch = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(event) = parse_acp_line(&sid, &line) {
                    let _ = ch.send(event);
                }
            }
        });
    }

    // Pipe stderr
    if let Some(stderr) = child.stderr.take() {
        let sid = session_id.clone();
        let ch = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    // Send stderr as thinking/diagnostic context
                    let _ = ch.send(AcpStreamEvent {
                        session_id: sid.clone(),
                        event_type: "thinking".to_string(),
                        text: Some(format!("[stderr] {}\n", trimmed)),
                        tool_name: None,
                        tool_args: None,
                        error: None,
                    });
                }
            }
        });
    }

    let sid = session_id.clone();
    let ch = channel.clone();
    tokio::spawn(async move {
        let wait_res = child.wait().await;
        if let Ok(mut map) = RUNNING_ACP.lock() {
            map.remove(&sid);
        }
        match wait_res {
            Ok(status) if status.success() => {
                let _ = ch.send(AcpStreamEvent {
                    session_id: sid,
                    event_type: "finished".to_string(),
                    text: None,
                    tool_name: None,
                    tool_args: None,
                    error: None,
                });
            }
            Ok(status) => {
                let _ = ch.send(AcpStreamEvent {
                    session_id: sid,
                    event_type: "error".to_string(),
                    text: None,
                    tool_name: None,
                    tool_args: None,
                    error: Some(format!("Agent exited with code {}", status.code().unwrap_or(-1))),
                });
            }
            Err(e) => {
                let _ = ch.send(AcpStreamEvent {
                    session_id: sid,
                    event_type: "error".to_string(),
                    text: None,
                    tool_name: None,
                    tool_args: None,
                    error: Some(e.to_string()),
                });
            }
        }
    });

    Ok(true)
}

/// Cancel a running ACP agent session using process group SIGKILL on Unix.
#[tauri::command]
pub fn kill_acp_session(session_id: String) -> Result<bool, String> {
    let pid = {
        let map = RUNNING_ACP.lock().map_err(|e| e.to_string())?;
        map.get(&session_id).copied()
    };

    let Some(pid) = pid else {
        // Already finished — nothing to kill, not an error.
        return Ok(false);
    };

    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if rc != 0 {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
        // Forget the session only once termination has actually been sent;
        // claiming success for a live process would be dishonest.
        if let Ok(mut map) = RUNNING_ACP.lock() {
            map.remove(&session_id);
        }
        return Ok(true);
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("Stopping agent sessions is not supported on this platform.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_acp_claude_thinking_delta() {
        let raw = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me check the repository."}}"#;
        let event = parse_acp_line("sess_1", raw).expect("should parse");
        assert_eq!(event.event_type, "thinking");
        assert_eq!(event.text.as_deref(), Some("Let me check the repository."));
    }

    #[test]
    fn test_parse_acp_claude_text_delta() {
        let raw = r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello world"}}"#;
        let event = parse_acp_line("sess_1", raw).expect("should parse");
        assert_eq!(event.event_type, "content");
        assert_eq!(event.text.as_deref(), Some("Hello world"));
    }

    #[test]
    fn test_parse_acp_jsonrpc_content() {
        let raw = r#"{"jsonrpc":"2.0","method":"agent/content","params":{"text":"Response line"}}"#;
        let event = parse_acp_line("sess_1", raw).expect("should parse");
        assert_eq!(event.event_type, "content");
        assert_eq!(event.text.as_deref(), Some("Response line"));
    }

    #[test]
    fn test_parse_acp_raw_fallback() {
        let raw = "Just normal terminal text";
        let event = parse_acp_line("sess_1", raw).expect("should parse fallback");
        assert_eq!(event.event_type, "content");
        assert!(event.text.unwrap().contains("Just normal terminal text"));
    }

    #[test]
    fn test_parse_acp_agy_stream_json() {
        // agy --output-format=stream-json emits Claude-style NDJSON lines:
        // partial message deltas carry content directly.
        let raw = r#"{"type":"assistant","content":"Antigravity reply text"}"#;
        let event = parse_acp_line("sess_agy", raw).expect("should parse");
        assert_eq!(event.event_type, "content");
        assert_eq!(event.text.as_deref(), Some("Antigravity reply text"));

        // An error frame from agy must surface as an error event.
        let err_raw = r#"{"type":"error","error":{"message":"auth expired"}}"#;
        let err_event = parse_acp_line("sess_agy", err_raw).expect("should parse");
        assert_eq!(err_event.event_type, "error");
        assert_eq!(err_event.error.as_deref(), Some("auth expired"));
    }
}
