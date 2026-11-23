//! Axum HTTP/WS server:
//! - `GET /handshake` — non-sensitive metadata only (never the pairing token),
//!   strictly Origin-validated (chrome-extension:// / moz-extension:// only).
//! - `GET /ws?token=...` — token-gated WebSocket bridge with 20s keepalive
//!   pings + text keepalives (keeps MV3 service workers alive).

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::mcp::Manager as McpManager;
use crate::sandbox::Sandbox;
use crate::skills::SkillsIndex;
use crate::tools::{tool_infos_json, Registry, ToolContext};
use crate::config::Config;
use crate::{PROTOCOL_VERSION, VERSION};

const KEEPALIVE_SECS: u64 = 20;

pub struct AppState {
    pub cwd: std::path::PathBuf,
    pub pid: u32,
    pub port: u16,
    pub shell_enabled: bool,
    pub token_hash: [u8; 32],
    pub config: Config,
    pub sandbox: Arc<Sandbox>,
    pub skills: Arc<SkillsIndex>,
    pub mcp: Arc<McpManager>,
    pub registry: Arc<Registry>,
}

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/handshake", get(handshake))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

/// Strict Origin validation: only extension backgrounds may talk to the daemon.
/// A missing Origin (curl / local tooling) is permitted; any web origin is rejected.
pub fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN) {
        None => true,
        Some(v) => {
            let Ok(s) = v.to_str() else { return false };
            let s = s.trim();
            s.starts_with("chrome-extension://") || s.starts_with("moz-extension://")
        }
    }
}

/// Constant-time comparison of the SHA-256 of the provided token against the
/// stored hash.
pub fn validate_token(state: &AppState, provided: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(provided.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= digest[i] ^ state.token_hash[i];
    }
    diff == 0
}

fn handshake_body(state: &AppState) -> Value {
    json!({
        "protocol_version": PROTOCOL_VERSION,
        "server_version": VERSION,
        "port": state.port,
        "pid": state.pid,
        "cwd": state.cwd.display().to_string(),
        "shell_enabled": state.shell_enabled,
        "skills_count": state.skills.skills.len(),
        "mcp_servers": state.mcp.statuses().iter().map(|s| {
            json!({"name": s.name, "status": s.status, "tool_count": s.tool_count})
        }).collect::<Vec<_>>(),
    })
}

async fn handshake(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden origin").into_response();
    }
    Json(handshake_body(&state)).into_response()
}

#[derive(Deserialize)]
struct WsAuth {
    token: Option<String>,
}

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(auth): Query<WsAuth>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden origin").into_response();
    }
    let token = auth.token.unwrap_or_default();
    if token.is_empty() || !validate_token(&state, &token) {
        return (StatusCode::UNAUTHORIZED, "Invalid pairing token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

fn sanitize_call_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .take(64)
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "call".to_string()
    } else {
        cleaned
    }
}

async fn handle_socket(state: Arc<AppState>, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    // Single writer task: responses, keepalives, and pongs all flow through here.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // hello: handshake metadata + skills list + tool manifest summary.
    let mut hello = handshake_body(&state);
    hello["type"] = json!("hello");
    hello["skills"] = json!(state
        .skills
        .skills
        .iter()
        .map(|s| json!({"name": s.name, "description": s.description}))
        .collect::<Vec<_>>());
    hello["tools"] = tool_infos_json(state.shell_enabled, &state.mcp);
    if tx.send(Message::Text(hello.to_string())).is_err() {
        writer.abort();
        return;
    }

    // 20s keepalive: WS ping frame + text keepalive (text frames also reset the
    // MV3 service-worker idle timer in Chromium).
    let ka_tx = tx.clone();
    let keepalive = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(KEEPALIVE_SECS));
        interval.tick().await; // first tick is immediate — skip it
        loop {
            interval.tick().await;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let text = json!({"type": "keepalive", "ts": ts}).to_string();
            if ka_tx.send(Message::Text(text)).is_err() {
                break;
            }
            if ka_tx.send(Message::Ping(Vec::new())).is_err() {
                break;
            }
        }
    });

    // Read loop: each request is handled in its own task so long-running tools
    // (shell, MCP) never block keepalives.
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(txt) => {
                let st = state.clone();
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    handle_text(st, txt, tx2).await;
                });
            }
            Message::Ping(p) => {
                let _ = tx.send(Message::Pong(p));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    keepalive.abort();
    writer.abort();
}

async fn handle_text(
    state: Arc<AppState>,
    txt: String,
    tx: tokio::sync::mpsc::UnboundedSender<Message>,
) {
    let v: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(e) => {
            let _ = tx.send(Message::Text(
                json!({"type": "error", "error": {"code": "BAD_JSON", "message": e.to_string()}})
                    .to_string(),
            ));
            return;
        }
    };
    let id = v
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("0")
        .to_string();
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match kind {
        "tool_call" => {
            let tool = v
                .get("tool")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            if tool.is_empty() {
                let _ = tx.send(Message::Text(
                    json!({"id": id, "type": "tool_result", "ok": false,
                           "error": {"code": "INVALID_ARGS", "message": "missing 'tool'"}})
                        .to_string(),
                ));
                return;
            }
            let args = v.get("args").cloned().unwrap_or_else(|| json!({}));
            let ctx = ToolContext {
                call_id: sanitize_call_id(&id),
                sandbox: &state.sandbox,
                config: &state.config,
                skills: &state.skills,
                mcp: &state.mcp,
                shell_enabled: state.shell_enabled,
            };
            let result = state.registry.execute(&tool, &args, &ctx).await;
            let resp = match result {
                Ok(ok) => json!({
                    "id": id, "type": "tool_result", "ok": true, "result": ok.to_json()
                }),
                Err(e) => json!({
                    "id": id, "type": "tool_result", "ok": false, "error": e.to_json()
                }),
            };
            let _ = tx.send(Message::Text(resp.to_string()));
        }
        "manifest" => {
            let xml = crate::tools::build_workspace_context(
                state.shell_enabled,
                &state.mcp,
                &state.skills,
                &state.cwd,
            );
            let resp = json!({
                "id": id, "type": "manifest_result", "ok": true,
                "xml": xml, "tools": tool_infos_json(state.shell_enabled, &state.mcp)
            });
            let _ = tx.send(Message::Text(resp.to_string()));
        }
        "keepalive_ack" | "ping" => {}
        other => {
            let _ = tx.send(Message::Text(
                json!({"id": id, "type": "error",
                       "error": {"code": "BAD_REQUEST", "message": format!("unknown type '{other}'")}})
                    .to_string(),
            ));
        }
    }
}


/// Factory used by integration tests (and internal unit tests) to build a fully
/// wired AppState against a real directory.
pub mod test_support {
    use super::*;
    use std::path::PathBuf;

    pub fn make_state(cwd: PathBuf, shell_enabled: bool, token: &str) -> Arc<AppState> {
        let sandbox = Arc::new(Sandbox::new(cwd.clone(), vec![]).unwrap());
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        let token_hash: [u8; 32] = hasher.finalize().into();
        Arc::new(AppState {
            cwd,
            pid: std::process::id(),
            port: 0,
            shell_enabled,
            token_hash,
            config: Config::default(),
            sandbox,
            skills: Arc::new(SkillsIndex::default()),
            mcp: Arc::new(McpManager::empty()),
            registry: Arc::new(Registry::new()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt; // for Router::oneshot

    fn test_state(shell_enabled: bool) -> Arc<AppState> {
        let tmp = tempfile::TempDir::new().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        let state = test_support::make_state(cwd, shell_enabled, "secret-token");
        // The factory hardcodes pid=process id; patch the fields the tests assert on.
        let mut s = Arc::try_unwrap(state).ok().unwrap_or_else(|| unreachable!());
        s.pid = 4242;
        s.port = 47800;
        let st = Arc::new(s);
        std::mem::forget(tmp); // keep tempdir alive for the test duration
        st
    }

    #[tokio::test]
    async fn handshake_allows_extension_origins_and_hides_token() {
        let app = build_router(test_state(false));

        for origin in ["chrome-extension://abcdef", "moz-extension://1234"] {
            let req = Request::builder()
                .uri("/handshake")
                .header("origin", origin)
                .body(Body::empty())
                .unwrap();
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let body = res.into_body().collect().await.unwrap().to_bytes();
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["protocol_version"], 2);
            assert_eq!(v["pid"], 4242);
            assert_eq!(v["shell_enabled"], false);
            assert_eq!(v["skills_count"], 0);
            assert!(v["cwd"].is_string());
            let raw = String::from_utf8(body.to_vec()).unwrap();
            assert!(!raw.contains("token"), "handshake must never expose the token");
            assert!(!raw.contains("secret-token"));
        }

        // Missing Origin (local curl-style tooling) is allowed.
        let req = Request::builder().uri("/handshake").body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn handshake_rejects_web_origins() {
        let app = build_router(test_state(false));
        for origin in [
            "https://evil.example",
            "http://localhost:3000",
            "https://chat.qwen.ai",
            "null",
        ] {
            let req = Request::builder()
                .uri("/handshake")
                .header("origin", origin)
                .body(Body::empty())
                .unwrap();
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "origin {origin} must be rejected");
        }
    }

    #[test]
    fn token_comparison_is_constant_time_shape() {
        let state = test_state(false);
        assert!(validate_token(&state, "secret-token"));
        assert!(!validate_token(&state, "secret-tokem"));
        assert!(!validate_token(&state, ""));
        assert!(!validate_token(&state, "SECRET-TOKEN"));
    }
}
