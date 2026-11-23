//! Fault-tolerant stdio MCP client: JSON-RPC 2.0 over the child's stdin/stdout,
//! per-tool timeouts, isolated stderr logging, and exponential-backoff
//! auto-restart (up to 3 retries) with health status reporting.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::mcp::Health;
use crate::tools::{ToolError, ToolOk};

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
/// A session that ran at least this long counts as "healthy" and resets the
/// consecutive-restart counter.
const HEALTHY_SESSION_SECS: u64 = 60;
const MAX_RESTARTS: usize = 3;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpServerDef {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub tool_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

struct Shared {
    health: Health,
    tools: Vec<McpToolDef>,
}

pub struct Client {
    name: String,
    def: McpServerDef,
    shared: Arc<Mutex<Shared>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    stdin_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    next_id: AtomicU64,
}

impl Client {
    pub fn new(name: String, def: McpServerDef) -> Client {
        Client {
            name,
            def,
            shared: Arc::new(Mutex::new(Shared {
                health: Health::Starting,
                tools: Vec::new(),
            })),
            pending: Arc::new(Mutex::new(HashMap::new())),
            stdin_tx: Arc::new(Mutex::new(None)),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn health(&self) -> Health {
        self.shared.lock().unwrap().health
    }

    pub fn tool_count(&self) -> usize {
        self.shared.lock().unwrap().tools.len()
    }

    pub fn tools(&self) -> Vec<McpToolDef> {
        self.shared.lock().unwrap().tools.clone()
    }

    fn set_health(&self, h: Health) {
        self.shared.lock().unwrap().health = h;
    }

    /// Spawn the supervisor task that keeps the server alive with backoff.
    /// Called once at startup; the supervisor owns all subsequent sessions.
    pub fn spawn_supervisor(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut consecutive_failures: usize = 0;
            loop {
                let started = Instant::now();
                this.set_health(Health::Starting);
                let session_result = this.start_session().await;

                let ran_healthy = started.elapsed().as_secs() >= HEALTHY_SESSION_SECS;
                match session_result {
                    Ok(()) if ran_healthy => consecutive_failures = 0,
                    Ok(()) => {} // short-lived session counts as a failure
                    Err(_) => {}
                }

                consecutive_failures += 1;
                if consecutive_failures > MAX_RESTARTS {
                    this.set_health(Health::Failed);
                    eprintln!(
                        "[mcp:{}] giving up after {MAX_RESTARTS} restart attempts",
                        this.name
                    );
                    return;
                }
                this.set_health(Health::Restarting);
                let backoff = Duration::from_secs(1u64 << (consecutive_failures - 1).min(4));
                eprintln!(
                    "[mcp:{}] session ended — restarting in {:?} (attempt {consecutive_failures}/{MAX_RESTARTS})",
                    this.name, backoff
                );
                tokio::time::sleep(backoff).await;
            }
        });
    }

    /// Spawn the child, initialize the protocol, list tools, then block until
    /// the child exits (session lifetime). Returns Ok(()) on clean session end.
    async fn start_session(&self) -> Result<(), String> {
        let mut std_cmd = std::process::Command::new(&self.def.command);
        std_cmd
            .args(&self.def.args)
            .envs(&self.def.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

        let mut stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

        // Channel-based line writer so request() can send while awaiting replies.
        let (wtx, wrx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut wrx = wrx;
            while let Some(line) = wrx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        *self.stdin_tx.lock().unwrap() = Some(wtx);

        // stdout reader: route JSON-RPC responses to pending oneshots.
        {
            let pending = self.pending.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                        if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                                let _ = tx.send(v);
                            }
                        }
                    }
                }
                // Stream closed — fail every in-flight request.
                pending.lock().unwrap().clear();
            });
        }

        // stderr reader: structured, isolated logging (never touches stdout JSON).
        {
            let name = self.name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[mcp:{name}] stderr: {line}");
                }
            });
        }

        // JSON-RPC initialize handshake.
        let init = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "phantomdock", "version": crate::VERSION}
                }),
                INIT_TIMEOUT,
            )
            .await
            .map_err(|e| format!("initialize failed: {e}"))?;
        let _ = init; // server capabilities not needed for tools/call

        self.notify("notifications/initialized")
            .map_err(|e| format!("initialized notification failed: {e}"))?;

        // tools/list
        let listed = self
            .request("tools/list", json!({}), INIT_TIMEOUT)
            .await
            .map_err(|e| format!("tools/list failed: {e}"))?;
        let tools = parse_tools_list(&listed);
        {
            let mut g = self.shared.lock().unwrap();
            g.tools = tools;
            g.health = Health::Healthy;
        }

        // Session lifetime: wait for the child to exit.
        let _ = child.wait().await;
        *self.stdin_tx.lock().unwrap() = None;
        self.pending.lock().unwrap().clear();
        Ok(())
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn notify(&self, method: &str) -> Result<(), String> {
        let msg = json!({"jsonrpc": "2.0", "method": method});
        let guard = self.stdin_tx.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.send(msg.to_string()).map_err(|e| e.to_string()),
            None => Err("not running".into()),
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel::<Value>();
        self.pending.lock().unwrap().insert(id, tx);

        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        {
            let guard = self.stdin_tx.lock().unwrap();
            match guard.as_ref() {
                Some(w) => {
                    if w.send(msg.to_string()).is_err() {
                        self.pending.lock().unwrap().remove(&id);
                        return Err("server not accepting input".into());
                    }
                }
                None => {
                    self.pending.lock().unwrap().remove(&id);
                    return Err("server not running".into());
                }
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("timeout".into())
            }
        }
    }

    pub async fn call_tool(&self, tool: &str, args: Value) -> Result<ToolOk, ToolError> {
        let timeout = Duration::from_secs(self.def.tool_timeout_secs.unwrap_or(30).max(1));
        let v = self
            .request(
                "tools/call",
                json!({"name": tool, "arguments": args}),
                timeout,
            )
            .await
            .map_err(|e| {
                if e == "timeout" {
                    ToolError::new(
                        "MCP_TIMEOUT",
                        format!(
                            "mcp tool '{}/{}' timed out after {:?}",
                            self.name, tool, timeout
                        ),
                    )
                } else {
                    ToolError::new(
                        "MCP_UNAVAILABLE",
                        format!("mcp server '{}' unavailable: {e}", self.name),
                    )
                }
            })?;

        if let Some(err) = v.get("error") {
            return Err(ToolError::new(
                "MCP_ERROR",
                format!("mcp error from '{}': {}", self.name, err),
            ));
        }
        let result = v.get("result").cloned().unwrap_or(Value::Null);
        let is_error = result
            .get("isError")
            .and_then(|f| f.as_bool())
            .unwrap_or(false);
        let text = extract_text_content(&result);
        if is_error {
            return Err(ToolError::new("MCP_ERROR", text));
        }
        Ok(ToolOk::ok(text))
    }
}

fn parse_tools_list(response: &Value) -> Vec<McpToolDef> {
    response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name")?.as_str()?.to_string();
                    let description = t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input_schema = t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
                    Some(McpToolDef {
                        name,
                        description,
                        input_schema,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Flatten MCP `content` blocks ({"type":"text","text":...}) into plain text.
fn extract_text_content(result: &Value) -> String {
    let Some(content) = result.get("content").and_then(|c| c.as_array()) else {
        if result.is_null() {
            return "(empty mcp result)".to_string();
        }
        return serde_json::to_string_pretty(result).unwrap_or_else(|_| "{}".into());
    };
    let parts: Vec<String> = content
        .iter()
        .map(|c| {
            if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                c.get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                serde_json::to_string(c).unwrap_or_default()
            }
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        "(empty mcp result)".to_string()
    } else {
        parts.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spin up a tiny fake MCP server implemented as a shell script that speaks
    /// JSON-RPC over stdio, then verify initialize + tools/list + tools/call.
    #[cfg(unix)]
    #[tokio::test]
    async fn end_to_end_against_fake_stdio_server() {
        if std::env::var("PD_SKIP_MCP_E2E").is_ok() {
            return;
        }
        let script = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  if [ "$method" = "initialize" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake"}}}\n' "$id"
  elif [ "$method" = "tools/list" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo tool","inputSchema":{"type":"object"}}]}}\n' "$id"
  elif [ "$method" = "tools/call" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}],"isError":false}}\n' "$id"
  fi
done
"#;
        let tmp = tempfile::TempDir::new().unwrap();
        let script_path = tmp.path().join("fake-mcp.sh");
        std::fs::write(&script_path, script).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let client = Arc::new(Client::new(
            "fake".to_string(),
            McpServerDef {
                command: script_path.display().to_string(),
                args: vec![],
                env: HashMap::new(),
                tool_timeout_secs: Some(5),
            },
        ));
        client.spawn_supervisor();

        // Wait for Healthy + tools to appear.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if client.health() == Health::Healthy && client.tool_count() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            client.health(),
            Health::Healthy,
            "fake server should be healthy"
        );
        let tools = client.tools();
        assert_eq!(tools[0].name, "echo");

        let ok = client
            .call_tool("echo", json!({"msg": "ping"}))
            .await
            .unwrap();
        assert_eq!(ok.text, "pong");
    }

    #[test]
    fn extracts_text_content_blocks() {
        let v = json!({"content": [
            {"type": "text", "text": "a"},
            {"type": "text", "text": "b"},
            {"type": "image", "data": "xxx"}
        ]});
        let text = extract_text_content(&v);
        assert!(text.contains("a"));
        assert!(text.contains("b"));
        assert!(text.contains("image"));
    }

    #[test]
    fn parses_tools_list_shapes() {
        let v = json!({"result": {"tools": [
            {"name": "t1", "description": "one", "inputSchema": {"type": "object"}},
            {"description": "missing name — skipped"}
        ]}});
        let tools = parse_tools_list(&v);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "t1");
    }
}
