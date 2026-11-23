//! `run_shell` — hard-gated behind `--allow-shell` at CLI launch.
//! Runs `sh -c <command>` in its own process group inside the workspace and
//! kills the entire group on timeout.

use serde_json::Value;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;

use super::{require_str, ToolContext, ToolError, ToolOk};

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

pub async fn run(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let command = require_str(args, "command")?;
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(30_000)
        .clamp(500, 120_000);

    let mut std_cmd = std::process::Command::new("sh");
    std_cmd
        .arg("-c")
        .arg(&command)
        .current_dir(&ctx.sandbox.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std_cmd.process_group(0); // isolate into its own process group
    }

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| ToolError::new("IO_ERROR", format!("failed to spawn shell: {e}")))?;
    let pid = child.id().unwrap_or(0);

    let out_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let err_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

    let mut reader_tasks = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let buf = out_buf.clone();
        reader_tasks.push(tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                }
            }
        }));
    }
    if let Some(mut stderr) = child.stderr.take() {
        let buf = err_buf.clone();
        reader_tasks.push(tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                }
            }
        }));
    }

    let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await;

    let (status_line, timed_out) = match outcome {
        Ok(Ok(status)) => (
            format!("[exit code {}]", status.code().unwrap_or(-1)),
            false,
        ),
        Ok(Err(e)) => return Err(ToolError::new("IO_ERROR", format!("wait failed: {e}"))),
        Err(_) => {
            kill_group(pid);
            let _ = child.wait().await;
            (
                format!("[TIMEOUT after {timeout_ms} ms — process group killed]"),
                true,
            )
        }
    };

    // Give the pipe readers a moment to drain EOF data.
    for t in reader_tasks {
        let _ = tokio::time::timeout(Duration::from_millis(500), t).await;
    }

    let stdout_text = String::from_utf8_lossy(&out_buf.lock().unwrap()).to_string();
    let stderr_text = String::from_utf8_lossy(&err_buf.lock().unwrap()).to_string();

    let mut text = format!("$ {command}\n{status_line}\n--- stdout ---\n{stdout_text}");
    if !stderr_text.trim().is_empty() {
        text.push_str("\n--- stderr ---\n");
        text.push_str(&stderr_text);
    }
    Ok(ToolOk {
        status: if timed_out { "timeout" } else { "ok" },
        text,
        delivery: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::mcp::Manager as McpManager;
    use crate::sandbox::Sandbox;
    use crate::skills::SkillsIndex;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_ctx(tmp: &TempDir) -> (Sandbox, Config, SkillsIndex, McpManager) {
        (
            Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap(),
            Config::default(),
            SkillsIndex::default(),
            McpManager::empty(),
        )
    }

    #[tokio::test]
    async fn shell_runs_and_captures_output() {
        let tmp = TempDir::new().unwrap();
        let (sb, cfg, index, mcp) = make_ctx(&tmp);
        let ctx = ToolContext {
            call_id: "c1".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: true,
        };
        let ok = run(&json!({"command": "echo hello && echo err >&2"}), &ctx).await.unwrap();
        assert_eq!(ok.status, "ok");
        assert!(ok.text.contains("hello"));
        assert!(ok.text.contains("err"));
        assert!(ok.text.contains("[exit code 0]"));
    }

    #[tokio::test]
    async fn shell_timeout_kills_process_group() {
        let tmp = TempDir::new().unwrap();
        let (sb, cfg, index, mcp) = make_ctx(&tmp);
        let ctx = ToolContext {
            call_id: "c2".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: true,
        };
        let started = std::time::Instant::now();
        let ok = run(
            &json!({"command": "sleep 30", "timeout_ms": 700}),
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(ok.text.contains("TIMEOUT"));
    }

    #[tokio::test]
    async fn shell_gated_behind_flag() {
        // The gate itself lives in tools::Registry::execute; verify the error
        // surfaced when the tool is invoked through the registry while disabled.
        let tmp = TempDir::new().unwrap();
        let (sb, cfg, index, mcp) = make_ctx(&tmp);
        let ctx = ToolContext {
            call_id: "c3".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: false,
        };
        let reg = crate::tools::Registry::new();
        let err = reg
            .execute("run_shell", &json!({"command": "echo no"}), &ctx)
            .await
            .unwrap_err();
        assert_eq!(err.code, "SHELL_DISABLED");
    }
}
