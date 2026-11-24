//! MCP (Model Context Protocol) integration: auto-discovers MCP configs from
//! PhantomDock, Claude Code / Claude Desktop, Cursor, Windsurf, VS Code,
//! Gemini CLI, Roo, Cline, and custom TOML `mcp_configs` / `mcp_dirs`.

pub mod client;

use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::config::{expand_tilde, home_dir};
use crate::tools::{ToolError, ToolOk};
use client::{Client, McpServerDef};

const WORKSPACE_MCP_FILES: &[&str] = &[
    "mcp.json",
    ".mcp.json",
    ".phantomdock/mcp.json",
    ".pdock/mcp.json",
    ".claude/mcp.json",
    ".cursor/mcp.json",
    ".vscode/mcp.json",
    ".windsurf/mcp.json",
    ".gemini/settings.json",
    ".roo/mcp.json",
    ".cline/mcp.json",
];

const GLOBAL_MCP_FILES: &[&str] = &[
    ".pdock/mcp.json",
    ".claude.json",
    ".claude/mcp.json",
    ".config/Claude/claude_desktop_config.json",
    "Library/Application Support/Claude/claude_desktop_config.json",
    ".cursor/mcp.json",
    ".codeium/windsurf/mcp_config.json",
    ".gemini/settings.json",
    ".config/phantomdock/mcp.json",
];

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

/// Discover all existing MCP config files in precedence order (earlier wins):
///   1. explicit `--mcp PATH`
///   2. workspace-local agent MCP configs (`mcp.json`, `.mcp.json`, `.claude/mcp.json`, etc.)
///   3. custom `mcp_configs` and `mcp_dirs` from `~/.pdock/config.toml`
///   4. global agent MCP configs (`~/.pdock/mcp.json`, `~/.claude.json`, Claude Desktop, Cursor, Windsurf, Gemini)
pub fn discover_config_paths(
    cwd: &Path,
    explicit: Option<&Path>,
    extra_configs: &[PathBuf],
    extra_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = explicit {
        candidates.push(resolve_path(cwd, p));
    }

    for rel in WORKSPACE_MCP_FILES {
        candidates.push(cwd.join(rel));
    }

    for cfg_path in extra_configs {
        candidates.push(resolve_path(cwd, cfg_path));
    }

    for dir in extra_dirs {
        let resolved_dir = resolve_path(cwd, dir);
        if let Ok(rd) = std::fs::read_dir(&resolved_dir) {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.extension()
                            .and_then(|e| e.to_str())
                            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
                })
                .collect();
            files.sort();
            candidates.extend(files);
        }
    }

    if let Some(home) = home_dir() {
        for rel in GLOBAL_MCP_FILES {
            candidates.push(home.join(rel));
        }
    }

    // Windows Claude Desktop (%APPDATA%/Claude/claude_desktop_config.json)
    if let Some(appdata) = std::env::var_os("APPDATA") {
        candidates.push(
            PathBuf::from(appdata)
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    for p in candidates {
        if !p.is_file() {
            continue;
        }
        let canon = p.canonicalize().unwrap_or(p);
        if seen.insert(canon.clone()) {
            out.push(canon);
        }
    }
    out
}

fn resolve_path(cwd: &Path, path: &Path) -> PathBuf {
    let expanded = expand_tilde(path);
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

impl Manager {
    /// Parse a single mcp.json (if present) and start all stdio servers.
    pub async fn start(path: Option<&Path>) -> Manager {
        let Some(path) = path else {
            return Manager::empty();
        };
        Self::start_multi(&[path.to_path_buf()], None).await
    }

    /// Parse and merge multiple MCP config files (earlier files win on name collisions)
    /// and start all discovered stdio servers.
    pub async fn start_multi(paths: &[PathBuf], cwd: Option<&Path>) -> Manager {
        if paths.is_empty() {
            return Manager::empty();
        }
        let mut merged: BTreeMap<String, McpServerDef> = BTreeMap::new();
        for path in paths {
            let Ok(raw) = std::fs::read_to_string(path) else {
                eprintln!("[pdock] mcp config not readable: {}", path.display());
                continue;
            };
            match parse_mcp_config_for_cwd(&raw, cwd) {
                Ok(defs) => {
                    for (name, def) in defs {
                        merged.entry(name).or_insert(def);
                    }
                }
                Err(e) => {
                    eprintln!("[pdock] skipping {}: {e}", path.display());
                }
            }
        }

        let mut clients = Vec::new();
        for (name, def) in merged {
            let client = std::sync::Arc::new(Client::new(name, def));
            client.spawn_supervisor();
            clients.push(client);
        }
        Manager { clients }
    }

    pub fn empty() -> Manager {
        Manager {
            clients: Vec::new(),
        }
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

    /// Paginated MCP tool listing (`list_mcp_tools`) so `<workspace_context>`
    /// never overflows chat character limits when many MCP servers are configured.
    pub fn list_tools(&self, args: &Value) -> Result<ToolOk, ToolError> {
        let server_filter = crate::tools::opt_str(args, "server")?
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let query = crate::tools::opt_str(args, "query")?
            .map(|q| q.trim().to_lowercase())
            .filter(|q| !q.is_empty());
        let page = crate::tools::opt_usize(args, "page")?.unwrap_or(1).max(1);
        let page_size = crate::tools::opt_usize(args, "page_size")?
            .unwrap_or(20)
            .clamp(1, 50);
        let include_schema = args
            .get("include_schema")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let mut entries: Vec<(String, String, String, Value)> = Vec::new();
        for c in &self.clients {
            let server = c.name().to_string();
            if let Some(ref sf) = server_filter {
                if server.to_lowercase() != *sf {
                    continue;
                }
            }
            for t in c.tools() {
                let fq = format!("mcp__{server}__{}", t.name);
                if let Some(ref q) = query {
                    if !fq.to_lowercase().contains(q)
                        && !t.description.to_lowercase().contains(q)
                    {
                        continue;
                    }
                }
                entries.push((server.clone(), fq, t.description.clone(), t.input_schema.clone()));
            }
        }
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        format_mcp_tool_page(&entries, page, page_size, include_schema, server_filter.as_deref(), query.as_deref())
    }

    pub async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        args: Value,
    ) -> Result<ToolOk, ToolError> {
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

fn format_mcp_tool_page(
    entries: &[(String, String, String, Value)],
    page: usize,
    page_size: usize,
    include_schema: bool,
    server: Option<&str>,
    query: Option<&str>,
) -> Result<ToolOk, ToolError> {
    let total = entries.len();
    if total == 0 {
        let msg = match (server, query) {
            (Some(s), Some(q)) => format!("No MCP tools matched server '{s}' and query '{q}'."),
            (Some(s), None) => format!("No MCP tools available for server '{s}'."),
            (None, Some(q)) => format!("No MCP tools matched query '{q}'."),
            (None, None) => "No MCP tools available.".to_string(),
        };
        return Ok(ToolOk::ok(msg));
    }
    let total_pages = total.div_ceil(page_size);
    if page > total_pages {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("page {page} out of range 1..={total_pages} ({total} matching MCP tools)"),
        ));
    }
    let start = (page - 1) * page_size;
    let end = (start + page_size).min(total);
    let mut out = format!(
        "MCP Tools (page {page}/{total_pages}, showing {}-{end} of {total}):\n",
        start + 1
    );
    for (_, fq, desc, schema) in &entries[start..end] {
        if include_schema {
            let compact = serde_json::to_string(schema).unwrap_or_else(|_| "{}".into());
            out.push_str(&format!("- {fq}: {desc} | schema: {compact}\n"));
        } else {
            out.push_str(&format!("- {fq}: {desc}\n"));
        }
    }
    if page < total_pages {
        let next = page + 1;
        let mut next_args = serde_json::Map::new();
        next_args.insert("page".into(), Value::from(next));
        next_args.insert("page_size".into(), Value::from(page_size));
        if let Some(s) = server {
            next_args.insert("server".into(), Value::from(s));
        }
        if let Some(q) = query {
            next_args.insert("query".into(), Value::from(q));
        }
        let next_json = Value::Object(next_args).to_string();
        out.push_str(&format!(
            "\nCall `list_mcp_tools` with {next_json} for the next page."
        ));
    }
    Ok(ToolOk::ok(out))
}

fn extract_stdio_servers(map: &serde_json::Map<String, Value>, out: &mut BTreeMap<String, McpServerDef>) {
    for (name, val) in map {
        if out.contains_key(name) {
            continue;
        }
        let Some(obj) = val.as_object() else {
            continue;
        };
        if obj.get("disabled").and_then(|d| d.as_bool()) == Some(true) {
            continue;
        }
        // Only spawn stdio servers (skip remote HTTP/SSE configs without `command`).
        let Some(cmd) = obj.get("command").and_then(|c| c.as_str()) else {
            continue;
        };
        if cmd.trim().is_empty() {
            continue;
        }
        if let Ok(def) = serde_json::from_value::<McpServerDef>(val.clone()) {
            out.insert(name.clone(), def);
        }
    }
}

/// Parse MCP server definitions from Claude/Cursor/VS Code/Gemini/PhantomDock JSON.
/// Supports:
/// - `{"mcpServers": {...}}` (Claude Desktop, Claude Code, Cursor, Windsurf, Gemini, PhantomDock)
/// - `{"servers": {...}}` (VS Code `.vscode/mcp.json`)
/// - `{"projects": {"<cwd>": {"mcpServers": {...}}}}` (Claude Code `~/.claude.json`)
/// - flat `{"server-name": {"command": ...}}`
pub fn parse_mcp_config_for_cwd(
    raw: &str,
    cwd: Option<&Path>,
) -> Result<Vec<(String, McpServerDef)>, String> {
    let root: Value = serde_json::from_str(raw).map_err(|e| format!("invalid mcp json: {e}"))?;
    let Some(obj) = root.as_object() else {
        return Err("invalid mcp json: root must be an object".to_string());
    };

    let mut out: BTreeMap<String, McpServerDef> = BTreeMap::new();
    let mut found_container = false;

    // 1. Claude Code per-project servers inside `~/.claude.json` (highest priority within file).
    if let (Some(cwd_path), Some(projects)) = (cwd, obj.get("projects").and_then(|p| p.as_object()))
    {
        found_container = true;
        let cwd_str = cwd_path.to_string_lossy();
        if let Some(proj_servers) = projects
            .get(cwd_str.as_ref())
            .and_then(|p| p.get("mcpServers"))
            .and_then(|s| s.as_object())
        {
            extract_stdio_servers(proj_servers, &mut out);
        }
    }

    // 2. Standard `mcpServers` / `mcp_servers` / `servers` containers.
    for key in ["mcpServers", "mcp_servers", "servers"] {
        if let Some(map) = obj.get(key).and_then(|v| v.as_object()) {
            found_container = true;
            extract_stdio_servers(map, &mut out);
        }
    }

    if found_container {
        return Ok(out.into_iter().collect());
    }

    // 3. Fallback shape: flat top-level `{"name": {"command": ...}}` map.
    match serde_json::from_value::<HashMap<String, McpServerDef>>(root) {
        Ok(map) => {
            let mut v: Vec<(String, McpServerDef)> = map.into_iter().collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(v)
        }
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(test)]
fn parse_mcp_config(raw: &str) -> Result<Vec<(String, McpServerDef)>, String> {
    parse_mcp_config_for_cwd(raw, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

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
        assert_eq!(
            defs[1].1.env.get("GITHUB_TOKEN").map(|s| s.as_str()),
            Some("x")
        );
    }

    #[test]
    fn parses_claude_json_with_projects_and_skips_remote_or_disabled() {
        let raw = r#"{
            "theme": "dark",
            "mcpServers": {
                "global-fs": {"command": "npx", "args": ["fs"]},
                "remote-sse": {"url": "https://example.com/sse"},
                "off": {"command": "node", "disabled": true}
            },
            "projects": {
                "/repo/demo": {
                    "mcpServers": {
                        "proj-db": {"command": "uvx", "args": ["mcp-sqlite"]}
                    }
                }
            }
        }"#;
        let defs = parse_mcp_config_for_cwd(raw, Some(Path::new("/repo/demo"))).unwrap();
        let names: Vec<&str> = defs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["global-fs", "proj-db"]);
    }

    #[test]
    fn parses_vscode_servers_key() {
        let raw = r#"{"servers": {"git": {"command": "uvx", "args": ["mcp-server-git"]}}}"#;
        let defs = parse_mcp_config(raw).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].0, "git");
    }

    #[test]
    fn discovers_workspace_and_custom_mcp_dirs() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        let custom_dir = tmp.path().join("extra-mcps");
        fs::create_dir_all(&custom_dir).unwrap();
        fs::write(custom_dir.join("tools.json"), r#"{"mcpServers":{}}"#).unwrap();

        let found = discover_config_paths(
            tmp.path(),
            None,
            &[],
            std::slice::from_ref(&custom_dir),
        );
        assert!(found.iter().any(|p| p.ends_with(".mcp.json")));
        assert!(found.iter().any(|p| p.ends_with("tools.json")));
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

    #[test]
    fn formats_paginated_mcp_tools() {
        let entries: Vec<(String, String, String, Value)> = (1..=5)
            .map(|i| {
                (
                    "srv".into(),
                    format!("mcp__srv__tool_{i:02}"),
                    format!("desc {i}"),
                    serde_json::json!({"type": "object"}),
                )
            })
            .collect();
        let p1 = format_mcp_tool_page(&entries, 1, 2, true, Some("srv"), None).unwrap();
        assert!(p1.text.contains("page 1/3"));
        assert!(p1.text.contains("mcp__srv__tool_01"));
        assert!(p1.text.contains("schema:"));
        assert!(!p1.text.contains("mcp__srv__tool_03"));
        assert!(p1.text.contains(r#""page":2"#));

        let oob = format_mcp_tool_page(&entries, 9, 2, false, None, None).unwrap_err();
        assert_eq!(oob.code, "INVALID_ARGS");
    }
}
