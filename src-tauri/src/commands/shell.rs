use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use crate::models::{CommandSafetyResult, ShellCommandResult};
use crate::policy::audit;
use crate::security::evaluate_command_safety;

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

#[tauri::command]
pub fn check_shell_safety(command: String) -> CommandSafetyResult {
    evaluate_command_safety(&command)
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
        // Negative pid = whole process group (we spawned with process_group(0)).
        let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if rc != 0 {
            // Group may already be gone; try the leader directly.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
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
pub async fn run_tracked(
    command: String,
    cwd: Option<String>,
    timeout_secs: u64,
    call_id: String,
    decision: Option<String>,
) -> Result<ShellCommandResult, String> {
    let start_time = Instant::now();
    let decision = decision.unwrap_or_else(|| "unknown".to_string());

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

    // wait_with_output() only captures what is piped; without this the
    // child inherits our stdout and the result comes back empty.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            audit_shell(&command, &decision, "spawn_error", None, Some(start_time.elapsed().as_millis()), &call_id);
            return Err(format!("Failed to spawn: {e}"));
        }
    };
    if let Some(pid) = child.id() {
        register(&call_id, pid);
    }

    let waited = timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await;
    unregister(&call_id);
    let killed = mark_killed(&call_id);
    let duration_ms = start_time.elapsed().as_millis();

    let output = match waited {
        Ok(res) => match res {
            Ok(o) => o,
            Err(e) => {
                audit_shell(&command, &decision, "error", None, Some(duration_ms), &call_id);
                return Err(e.to_string());
            }
        },
        Err(_) => {
            audit_shell(&command, &decision, "timeout", None, Some(duration_ms), &call_id);
            return Err(format!(
                "Command execution timed out after {timeout_secs} seconds."
            ));
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let success = output.status.success();
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
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
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
}
