//! MCP (Model Context Protocol) integration: `mcp.json` (Claude/Cursor
//! compatible) parsing, health tracking, and fault-tolerant stdio clients.

pub mod client;

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use crate::tools::{ToolError, ToolOk};
use client::{Client, McpServerDef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Starting,
    Healthy,
    Restarting,
    Failed,
}

impl Health {
    pub fn as_str(&self) -> &'static str {
        match self {
            Health::Starting => "Starting",
            Health::Healthy => "Healthy",
            Health::Restarting => "Restarting",
            Health::Failed => "Failed",
        }
    }
}

pub struct ServerStatus {
    pub name: String,
    pub status: &'static str,
    pub tool_count: usize,
}

pub struct Manager {
    clients: Vec<std::sync::Arc<Client>>,
}

#[derive(Deserialize)]
struct McpFile {
    #[serde(default, alias = "mcpServers")]
    mcp_servers: HashMap<String, McpServerDef>,
}

impl Manager {
    /// Parse mcp.json (if present) and start all stdio servers.
    pub async fn start(path: Option<&Path>) -> Manager {
        let Some(path) = path else {
            return Manager::empty();
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            eprintln!("[pdock] mcp config not readable: {}", path.display());
            return Manager::empty();
        };
        match parse_mcp_config(&raw) {
            Ok(defs) => {
                let mut clients = Vec::new();
                for (name, def) in defs {
                    let client = std::sync::Arc::new(Client::new(name, def));
                    client.spawn_supervisor();
                    clients.push(client);
                }
                Manager { clients }
            }
            Err(e) => {
                eprintln!("[pdock] failed to parse {}: {e}", path.display());
                Manager::empty()
            }
        }
    }

    pub fn empty() -> Manager {
        Manager { clients: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.clients.is_empty()
    }

    pub fn statuses(&self) -> Vec<ServerStatus> {
        self.clients
            .iter()
            .map(|c| ServerStatus {
                name: c.name().to_string(),
                status: c.health().as_str(),
                tool_count: c.tool_count(),
            })
            .collect()
    }

    /// Fully-qualified tool names (`mcp__<server>__<tool>`) with descriptions.
    pub fn tool_names(&self) -> Vec<(String, String)> {
        let mut v = Vec::new();
        for c in &self.clients {
            let server = c.name();
            for t in c.tools() {
                v.push((format!("mcp__{server}__{}", t.name), t.description.clone()));
            }
        }
        v
    }

    /// Fully-qualified tool names with compact inputSchemas for the manifest.
    pub fn tool_schemas(&self) -> Vec<(String, Value)> {
        let mut v = Vec::new();
        for c in &self.clients {
            let server = c.name();
            for t in c.tools() {
                v.push((format!("mcp__{server}__{}", t.name), t.input_schema.clone()));
            }
        }
        v
    }

    pub async fn call_tool(&self, server: &str, tool: &str, args: Value) -> Result<ToolOk, ToolError> {
        let client = self
            .clients
            .iter()
            .find(|c| c.name() == server)
            .ok_or_else(|| {
                ToolError::new(
                    "MCP_UNAVAILABLE",
                    format!("MCP server '{server}' is not configured"),
                )
            })?;
        client.call_tool(tool, args).await
    }
}

fn parse_mcp_config(raw: &str) -> Result<Vec<(String, McpServerDef)>, String> {
    // Primary shape: {"mcpServers": {...}} (Claude/Cursor compatible).
    if let Ok(file) = serde_json::from_str::<McpFile>(raw) {
        if !file.mcp_servers.is_empty() {
            let mut v: Vec<(String, McpServerDef)> = file.mcp_servers.into_iter().collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            return Ok(v);
        }
    }
    // Fallback shape: top-level {"name": {...}} map.
    match serde_json::from_str::<HashMap<String, McpServerDef>>(raw) {
        Ok(map) => {
            let mut v: Vec<(String, McpServerDef)> = map.into_iter().collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(v)
        }
        Err(e) => Err(format!("invalid mcp.json: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_style_config() {
        let raw = r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
                },
                "github": {
                    "command": "docker",
                    "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
                    "env": {"GITHUB_TOKEN": "x"}
                }
            }
        }"#;
        let defs = parse_mcp_config(raw).unwrap();
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].0, "filesystem");
        assert_eq!(defs[1].0, "github");
        assert_eq!(defs[1].1.env.get("GITHUB_TOKEN").map(|s| s.as_str()), Some("x"));
    }

    #[test]
    fn parses_flat_top_level_config() {
        let raw = r#"{"my-server": {"command": "node", "args": ["server.js"]}}"#;
        let defs = parse_mcp_config(raw).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].0, "my-server");
        assert_eq!(defs[0].1.command, "node");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_mcp_config("not json {{{").is_err());
    }

    #[test]
    fn empty_manager_reports_no_tools() {
        let m = Manager::empty();
        assert!(m.is_empty());
        assert!(m.statuses().is_empty());
        assert!(m.tool_names().is_empty());
    }
}
