use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use crate::models::{CommandSafetyResult, ShellCommandResult};
use crate::policy::{audit, load_policy, load_standing_grants_sync};
use crate::security::{evaluate_command_safety, evaluate_with_policy};

/// Shell executions currently running, keyed by the frontend call id.
/// Each entry maps to the spawned bash process-group leader so Stop can
/// kill the whole tree (bash + children), not just the shell.
static RUNNING: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Call ids killed via kill_shell_command, so the awaiting execution can
/// report the honest outcome "killed" instead of a bare non-zero exit.
static KILLED: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn register(call_id: &str, pid: u32) {
    if let Ok(mut map) = RUNNING.lock() {
        map.insert(call_id.to_string(), pid);
    }
}

fn unregister(call_id: &str) -> Option<u32> {
    RUNNING.lock().ok()?.remove(call_id)
}

fn mark_killed(call_id: &str) -> bool {
    KILLED
        .lock()
        .map(|mut s| s.remove(call_id))
        .unwrap_or(false)
}

#[cfg(test)]
fn was_killed(call_id: &str) -> bool {
    KILLED.lock().map(|s| s.contains(call_id)).unwrap_or(false)
}

/// SIGKILL the whole process group led by `pid` (children included).
/// Unix only; on other platforms the caller degrades gracefully.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // Negative pid = whole process group (we spawned with process_group(0)).
    let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if rc != 0 {
        // Group may already be gone; try the leader directly.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn kill_process_group(pid: u32) {
    let _ = pid;
}

#[tauri::command]
pub fn check_shell_safety(command: String, cwd: Option<String>) -> CommandSafetyResult {
    evaluate_command_safety(&command, cwd.as_deref())
}

#[tauri::command]
pub async fn execute_shell_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    call_id: Option<String>,
    decision: Option<String>,
) -> Result<ShellCommandResult, String> {
    let id = call_id.unwrap_or_else(|| format!("auto_{}", std::process::id()));
    let secs = timeout_secs.unwrap_or(60);
    run_tracked(command, cwd, secs, id, decision).await
}

/// Kill a running shell execution by its call id. Kills the process group
/// so children (the actual workload) die too. Fire-and-forget from the UI.
#[tauri::command]
pub fn kill_shell_command(call_id: String) -> Result<bool, String> {
    let pid = {
        let mut map = RUNNING.lock().map_err(|e| e.to_string())?;
        map.remove(&call_id)
    };

    let Some(pid) = pid else {
        // Already finished — nothing to kill, not an error.
        return Ok(false);
    };

    if let Ok(mut killed) = KILLED.lock() {
        killed.insert(call_id);
    }

    #[cfg(unix)]
    {
        kill_process_group(pid);
        Ok(true)
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("Killing running commands is not supported on this platform.".to_string())
    }
}

fn audit_shell(
    command: &str,
    decision: &str,
    outcome: &str,
    exit_code: Option<i32>,
    duration_ms: Option<u128>,
    call_id: &str,
) {
    audit(serde_json::json!({
        "tool": "execute_shell",
        "decision": decision,
        "outcome": outcome,
        "command": command,
        "exit_code": exit_code,
        "duration_ms": duration_ms.map(|d| d as u64),
        "call_id": call_id,
    }));
}

/// Spawn a shell command as its own process group, register it under
/// `call_id` while it runs, and collect stdout/stderr/exit status. Every
/// finished execution writes one audit row.
///
/// Trust boundary: the frontend's `decision` string is verified, not
/// trusted — the policy is re-evaluated here against the CURRENT policy
/// file and grants. A command that needs approval but arrives without
/// decision="approved" is refused before any process is spawned.
pub async fn run_tracked(
    command: String,
    cwd: Option<String>,
    timeout_secs: u64,
    call_id: String,
    decision: Option<String>,
) -> Result<ShellCommandResult, String> {
    let start_time = Instant::now();

    // 0. Native re-evaluation — the shell endpoint is the enforcement point.
    let policy = load_policy();
    let grants = load_standing_grants_sync();
    let safety = evaluate_with_policy(&command, &policy, &grants, cwd.as_deref());
    let decision = if safety.requires_confirmation {
        if decision.as_deref() != Some("approved") {
            let ms = start_time.elapsed().as_millis();
            audit_shell(&command, "blocked", "blocked", None, Some(ms), &call_id);
            return Err(
                "Blocked by policy: this command requires user approval, and no approval was recorded for it."
                    .to_string(),
            );
        }
        "approved".to_string()
    } else if safety.standing_grant {
        "standing_grant".to_string()
    } else {
        "auto_safe".to_string()
    };

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("bash");
        c.args(["-c", &command]);
        // Own process group so Stop can SIGKILL bash and its children.
        #[cfg(unix)]
        c.process_group(0);
        c
    };

    if let Some(working_dir) = cwd {
        if !working_dir.trim().is_empty() {
            cmd.current_dir(working_dir);
        }
    }

    // Pipes, not inherited stdio: we must capture output, and spawned
    // descendants keep the write ends open which we handle below.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            audit_shell(&command, &decision, "spawn_error", None, Some(start_time.elapsed().as_millis()), &call_id);
            return Err(format!("Failed to spawn: {e}"));
        }
    };
    let pid = child.id();
    if let Some(p) = pid {
        register(&call_id, p);
    }

    // Drain the pipes on dedicated tasks so `child` stays in scope — a bare
    // wait_with_output() consumes the handle, which previously left a timed
    // out process group running after the timeout was reported.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let read_out = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = stdout_pipe {
            let _ = r.read_to_end(&mut buf).await;
        }
        buf
    });
    let read_err = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut r) = stderr_pipe {
            let _ = r.read_to_end(&mut buf).await;
        }
        buf
    });

    let waited = timeout(Duration::from_secs(timeout_secs), child.wait()).await;
    unregister(&call_id);
    let killed = mark_killed(&call_id);
    let duration_ms = start_time.elapsed().as_millis();

    let output = match waited {
        Ok(res) => match res {
            Ok(status) => {
                // The leader exited. Descendants (background jobs) may still
                // hold the pipes; give them a short grace window, then
                // reclaim the group so nothing outlives a reported finish.
                // The handles move into the async block: on grace timeout the
                // block drops, detaching the readers (dying at pipe EOF
                // after the group kill below).
                let grace = timeout(
                    Duration::from_secs(2),
                    async {
                        let o = read_out.await.unwrap_or_default();
                        let e = read_err.await.unwrap_or_default();
                        (o, e)
                    },
                )
                .await;
                let (out, err) = match grace {
                    Ok(pair) => pair,
                    Err(_) => {
                        // Still-running descendants keep the pipe open past
                        // the leader's exit — stop the tree for real.
                        if let Some(p) = pid {
                            kill_process_group(p);
                        }
                        (Vec::new(), Vec::new())
                    }
                };
                (out, err, status)
            }
            Err(e) => {
                read_out.abort();
                read_err.abort();
                audit_shell(&command, &decision, "error", None, Some(duration_ms), &call_id);
                return Err(e.to_string());
            }
        },
        Err(_) => {
            // Timeout: terminate the entire process group, then reap the
            // leader so the app never reports a stop that didn't happen.
            // (Dropping a tokio child handle does NOT kill or reap it.)
            if let Some(p) = pid {
                kill_process_group(p);
            }
            // Non-Unix: there is no process-group kill; at least terminate
            // the leader so a timed-out cmd.exe can't hold the run open.
            // Descendant termination on Windows remains a known limitation.
            #[cfg(not(unix))]
            {
                let _ = child.start_kill();
            }
            let _ = child.wait().await; // SIGKILLed leader → returns promptly
            read_out.abort();
            read_err.abort();
            audit_shell(&command, &decision, "timeout", None, Some(duration_ms), &call_id);
            return Err(format!(
                "Command execution timed out after {timeout_secs} seconds and its process group was terminated."
            ));
        }
    };

    let (out, err, status) = output;
    let exit_code = status.code().unwrap_or(-1);
    let success = status.success();
    let outcome = if killed {
        "killed"
    } else if success {
        "completed"
    } else {
        "failed"
    };
    audit_shell(
        &command,
        &decision,
        outcome,
        Some(exit_code),
        Some(duration_ms),
        &call_id,
    );

    Ok(ShellCommandResult {
        stdout: String::from_utf8_lossy(&out).to_string(),
        stderr: String::from_utf8_lossy(&err).to_string(),
        exit_code,
        success: success && !killed,
        execution_time_ms: duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn executes_simple_command() {
        let res = run_tracked(
            "echo anybot-e2e".into(),
            None,
            10,
            "t1".into(),
            Some("auto_safe".into()),
        )
        .await
        .unwrap();
        assert!(res.success);
        assert!(res.stdout.contains("anybot-e2e"));
        assert_eq!(res.exit_code, 0);
    }

    #[tokio::test]
    async fn kill_stops_long_running_command() {
        let handle = tokio::spawn(run_tracked(
            "sleep 30".into(),
            None,
            60,
            "t2".into(),
            Some("approved".into()),
        ));

        // Wait until the child is registered, then kill it.
        let mut registered = false;
        for _ in 0..50 {
            if let Ok(map) = RUNNING.lock() {
                if map.contains_key("t2") {
                    registered = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(registered, "child was never registered");

        let killed = kill_shell_command("t2".into()).unwrap();
        assert!(killed);

        let start = Instant::now();
        let res = handle.await.unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(5), "kill did not stop the command");
        // Killed by SIGKILL -> no clean exit; never reported as success.
        assert!(!res.unwrap().success);
        // The killed marker was consumed by the awaiting execution.
        assert!(!was_killed("t2"));
    }

    #[tokio::test]
    async fn kill_of_unknown_id_is_not_an_error() {
        assert!(!kill_shell_command("nope".into()).unwrap());
    }

    #[tokio::test]
    async fn timeout_terminates_process_group() {
        // The old code returned the timeout error while `sleep 30` kept
        // running. The executor must kill the group before reporting.
        let start = Instant::now();
        let res = run_tracked(
            "sleep 30".into(),
            None,
            1,
            "t4".into(),
            Some("approved".into()),
        )
        .await;
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(5), "timeout returned too slowly");
        assert!(res.is_err(), "timed-out command must not report success");
        assert!(res.unwrap_err().contains("process group was terminated"));
    }

    #[tokio::test]
    async fn unapproved_mutative_command_is_blocked_natively() {
        // The frontend decision string is verified against the policy here,
        // in the shell endpoint — it is not trusted blindly.
        let res = run_tracked(
            "touch /tmp/anybot-should-never-exist".into(),
            None,
            10,
            "t5".into(),
            None,
        )
        .await;
        assert!(res.is_err(), "mutative command without approval must be refused");
        assert!(res.unwrap_err().contains("Blocked by policy"));
    }

    #[tokio::test]
    async fn safe_command_runs_without_frontend_decision() {
        let res = run_tracked("echo native-reeval".into(), None, 10, "t6".into(), None)
            .await
            .unwrap();
        assert!(res.success);
        assert!(res.stdout.contains("native-reeval"));
    }
}
