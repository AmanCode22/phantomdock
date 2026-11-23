//! End-to-end WebSocket bridge tests against a real bound localhost server:
//! token gating, origin enforcement, hello payload, tool_call round trips,
//! manifest delivery, and graceful handling of unknown request types.

use futures::{SinkExt, StreamExt};
use phantomdock_cli::server::{self, test_support};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

#[tokio::test]
async fn ws_round_trip_hello_tools_manifest_and_auth() {
    // 1. Spin up a real server on an ephemeral localhost port.
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "hello workspace\n").unwrap();

    let state = test_support::make_state(
        tmp.path().canonicalize().unwrap(),
        false,
        "pairing-token-123",
    );
    let app = server::build_router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service()).await;
    });

    // 2. Wrong token must be rejected at the HTTP upgrade step.
    let bad = with_origin(
        format!("ws://{addr}/ws?token=wrong-token").into_client_request().unwrap(),
        "chrome-extension://abc",
    );
    assert!(tokio_tungstenite::connect_async(bad).await.is_err());

    // 3. Web origin must be rejected even with a valid token.
    let evil = with_origin(
        format!("ws://{addr}/ws?token=pairing-token-123").into_client_request().unwrap(),
        "https://evil.example",
    );
    assert!(tokio_tungstenite::connect_async(evil).await.is_err());

    // 4. Valid origin + token connects and receives hello.
    let good = with_origin(
        format!("ws://{addr}/ws?token=pairing-token-123").into_client_request().unwrap(),
        "chrome-extension://abc",
    );
    let (mut ws, _resp) = tokio_tungstenite::connect_async(good).await.unwrap();

    let hello = next_json(&mut ws).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol_version"], 2);
    assert_eq!(hello["shell_enabled"], false);
    let tools = hello["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "read_file"));
    assert!(!tools.iter().any(|t| t["name"] == "run_shell"));

    // 5. tool_call round trip: read_file works; run_shell is hard-rejected.
    ws.send(Message::text(
        json!({"id": "call_01", "type": "tool_call", "tool": "read_file",
               "args": {"path": "hello.txt"}})
        .to_string(),
    ))
    .await
    .unwrap();
    let res = next_json(&mut ws).await;
    assert_eq!(res["id"], "call_01");
    assert_eq!(res["type"], "tool_result");
    assert_eq!(res["ok"], true, "read_file should succeed: {res}");
    assert!(res["result"]["text"].as_str().unwrap().contains("hello workspace"));

    ws.send(Message::text(
        json!({"id": "call_02", "type": "tool_call", "tool": "run_shell",
               "args": {"command": "echo nope"}})
        .to_string(),
    ))
    .await
    .unwrap();
    let res = next_json(&mut ws).await;
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"]["code"], "SHELL_DISABLED");

    // 6. manifest returns the workspace_context XML.
    ws.send(Message::text(json!({"id": "m1", "type": "manifest"}).to_string()))
        .await
        .unwrap();
    let res = next_json(&mut ws).await;
    assert_eq!(res["type"], "manifest_result");
    let xml = res["xml"].as_str().unwrap();
    assert!(xml.starts_with("<workspace_context"));
    assert!(xml.contains("pdock_call"));
    assert!(xml.ends_with("</workspace_context>"));

    // 7. Unknown request type is rejected gracefully (no disconnect).
    ws.send(Message::text(json!({"id": "x1", "type": "bogus"}).to_string()))
        .await
        .unwrap();
    let res = next_json(&mut ws).await;
    assert_eq!(res["type"], "error");
    assert_eq!(res["error"]["code"], "BAD_REQUEST");
}

fn with_origin(
    mut req: tokio_tungstenite::tungstenite::http::Request<()>,
    origin: &str,
) -> tokio_tungstenite::tungstenite::http::Request<()> {
    req.headers_mut()
        .insert("origin", HeaderValue::from_str(origin).unwrap());
    req
}

type Ws = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for ws message")
            .expect("ws stream ended")
            .expect("ws protocol error");
        match msg {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(c) => panic!("unexpected close: {c:?}"),
            Message::Binary(b) => panic!("unexpected binary frame: {} bytes", b.len()),
        }
    }
}
