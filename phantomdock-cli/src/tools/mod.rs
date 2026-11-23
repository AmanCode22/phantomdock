//! Unified ToolRegistry: built-in FS tools + skills + optional shell + MCP.
//! Also builds the `<workspace_context>` prompt manifest injected into web-AI chats.

pub mod fs;
pub mod shell;

use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

use crate::config::Config;
use crate::mcp::Manager as McpManager;
use crate::sandbox::Sandbox;
use crate::skills::SkillsIndex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCategory {
    Fs,
    Skill,
    Shell,
    Mcp,
}

impl ToolCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolCategory::Fs => "fs",
            ToolCategory::Skill => "skill",
            ToolCategory::Shell => "shell",
            ToolCategory::Mcp => "mcp",
        }
    }
}

#[derive(Debug)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Delivery {
    Upload {
        filename: String,
        mime: String,
        content: String,
        chunk_info: Option<ChunkInfo>,
    },
    InlinePart {
        part: usize,
        total_parts: usize,
        outline: Vec<String>,
    },
    Offload {
        path: String,
        total_chars: usize,
    },
}

#[derive(Debug, Serialize)]
pub struct ChunkInfo {
    pub chunk_size_chars: usize,
    pub total_parts: usize,
}

#[derive(Debug)]
pub struct ToolOk {
    pub status: &'static str,
    pub text: String,
    pub delivery: Option<Delivery>,
}

impl ToolOk {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            status: "ok",
            text: text.into(),
            delivery: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let delivery = match &self.delivery {
            Some(d) => serde_json::to_value(d).unwrap_or(Value::Null),
            None => Value::Null,
        };
        json!({ "status": self.status, "text": self.text, "delivery": delivery })
    }
}

pub struct ToolContext<'a> {
    /// Client-supplied call id (sanitized) — used for offload filenames.
    pub call_id: String,
    pub sandbox: &'a Sandbox,
    pub config: &'a Config,
    pub skills: &'a SkillsIndex,
    pub mcp: &'a McpManager,
    pub shell_enabled: bool,
}

pub fn require_str(args: &Value, key: &str) -> Result<String, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            ToolError::new(
                "INVALID_ARGS",
                format!("missing or non-string argument '{key}'"),
            )
        })
}

pub fn opt_str(args: &Value, key: &str) -> Result<Option<String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())).ok_or_else(|| {
            ToolError::new("INVALID_ARGS", format!("argument '{key}' must be a string"))
        }),
    }
}

pub fn opt_usize(args: &Value, key: &str) -> Result<Option<usize>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            if let Some(n) = v.as_u64() {
                Ok(Some(n as usize))
            } else if let Some(n) = v.as_str().and_then(|s| s.parse::<usize>().ok()) {
                Ok(Some(n))
            } else {
                Err(ToolError::new(
                    "INVALID_ARGS",
                    format!("argument '{key}' must be a non-negative number"),
                ))
            }
        }
    }
}

#[derive(Default)]
pub struct Registry;

impl Registry {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(
        &self,
        name: &str,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> Result<ToolOk, ToolError> {
        if !args.is_object() {
            return Err(ToolError::new("INVALID_ARGS", "args must be a JSON object"));
        }
        let result = self.execute_inner(name, args, ctx).await?;
        // Central oversized-output offloading for plain text results.
        if result.delivery.is_none() && result.text.chars().count() > ctx.config.max_inline_chars {
            return crate::offload::offload(&ctx.call_id, &result.text, ctx.sandbox);
        }
        Ok(result)
    }

    async fn execute_inner(
        &self,
        name: &str,
        args: &Value,
        ctx: &ToolContext<'_>,
    ) -> Result<ToolOk, ToolError> {
        match name {
            "read_file" => fs::read_file(args, ctx),
            "write_file" => fs::write_file(args, ctx),
            "edit_file" => fs::edit_file(args, ctx),
            "list_dir" => fs::list_dir(args, ctx),
            "search_files" => fs::search_files(args, ctx),
            "activate_skill" => crate::skills::loader::activate(args, ctx),
            "read_skill_resource" => crate::skills::loader::read_resource(args, ctx),
            "run_shell" => {
                if !ctx.shell_enabled {
                    return Err(ToolError::new(
                        "SHELL_DISABLED",
                        "run_shell is disabled: relaunch pdock with --allow-shell (it is always \
                         omitted from the tool manifest and requires manual approval)",
                    ));
                }
                shell::run(args, ctx).await
            }
            other if other.starts_with("mcp__") => {
                let mut it = other.strip_prefix("mcp__").unwrap().splitn(2, "__");
                match (it.next(), it.next()) {
                    (Some(server), Some(tool)) if !server.is_empty() && !tool.is_empty() => {
                        ctx.mcp.call_tool(server, tool, args.clone()).await
                    }
                    _ => Err(ToolError::new(
                        "INVALID_ARGS",
                        format!(
                            "malformed MCP tool name '{other}' (expected mcp__<server>__<tool>)"
                        ),
                    )),
                }
            }
            other => Err(ToolError::new(
                "INVALID_ARGS",
                format!("unknown tool '{other}'"),
            )),
        }
    }
}

pub struct ToolInfo {
    pub name: String,
    pub category: ToolCategory,
    pub readonly: bool,
    pub description: String,
}

pub fn builtin_tool_infos(shell_enabled: bool) -> Vec<ToolInfo> {
    let mut v = vec![
        ToolInfo {
            name: "read_file".into(),
            category: ToolCategory::Fs,
            readonly: true,
            description: "Read a workspace file, with optional 1-based start_line/end_line range."
                .into(),
        },
        ToolInfo {
            name: "write_file".into(),
            category: ToolCategory::Fs,
            readonly: false,
            description: "Write a file inside the workspace (creates parent directories).".into(),
        },
        ToolInfo {
            name: "edit_file".into(),
            category: ToolCategory::Fs,
            readonly: false,
            description: "Exact-once string edit: old_str must match exactly once.".into(),
        },
        ToolInfo {
            name: "list_dir".into(),
            category: ToolCategory::Fs,
            readonly: true,
            description: "List a directory (bounded depth), skipping denied entries.".into(),
        },
        ToolInfo {
            name: "search_files".into(),
            category: ToolCategory::Fs,
            readonly: true,
            description: "Regex search across workspace files, returning file:line:text matches."
                .into(),
        },
        ToolInfo {
            name: "activate_skill".into(),
            category: ToolCategory::Skill,
            readonly: true,
            description: "Attach a skill as <name>-skill.md or fetch an inline part.".into(),
        },
        ToolInfo {
            name: "read_skill_resource".into(),
            category: ToolCategory::Skill,
            readonly: true,
            description: "Read a bundled skill resource (scripts/, references/, assets/).".into(),
        },
    ];
    if shell_enabled {
        v.push(ToolInfo {
            name: "run_shell".into(),
            category: ToolCategory::Shell,
            readonly: false,
            description: "Run a shell command in the workspace (manual approval, timeout-capped)."
                .into(),
        });
    }
    v
}

pub fn tool_infos(shell_enabled: bool, mcp: &McpManager) -> Vec<ToolInfo> {
    let mut v = builtin_tool_infos(shell_enabled);
    for (name, description) in mcp.tool_names() {
        v.push(ToolInfo {
            name,
            category: ToolCategory::Mcp,
            readonly: false,
            description,
        });
    }
    v
}

pub fn tool_infos_json(shell_enabled: bool, mcp: &McpManager) -> Value {
    Value::Array(
        tool_infos(shell_enabled, mcp)
            .into_iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "category": t.category.as_str(),
                    "readonly": t.readonly,
                    "description": t.description,
                })
            })
            .collect(),
    )
}

/// Build the `<workspace_context>` manifest injected as the first chat turn.
pub fn build_workspace_context(
    shell_enabled: bool,
    mcp: &McpManager,
    skills: &SkillsIndex,
    cwd: &Path,
) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "<workspace_context cwd=\"{}\" shell_enabled=\"{}\">\n",
        cwd.display(),
        shell_enabled
    ));
    s.push_str(
        "You have direct access to the user's local workspace, Agent Skills, and MCP tools.\n",
    );
    s.push_str("To invoke one or more tools, output fenced `pdock_call` JSON code blocks and IMMEDIATELY STOP generating text. Wait for the user's `<tool_result>` message before continuing.\n\n");
    s.push_str("Syntax (STRICT — must be a fenced code block with valid JSON):\n");
    s.push_str("```pdock_call\n{\"id\":\"call_01\",\"name\":\"TOOL_NAME\",\"args\":{\"arg\":\"value\"}}\n```\n\n");
    s.push_str("Rules:\n");
    s.push_str("- Never fabricate tool outputs.\n");
    s.push_str("- You may emit multiple `pdock_call` blocks in one turn; all results will be returned together in one reply.\n");
    s.push_str("- When a request matches an installed skill in `<available_skills>`, call `activate_skill` first. If delivered as an uploaded `*-skill.md` file, follow it strictly. If delivered inline in parts (`part 1/N`), call `activate_skill` with `{\"name\":\"...\",\"part\":2}` to read further parts as needed.\n");
    s.push_str("- If a tool result was offloaded to `.phantomdock/outputs/...`, use `read_file` with `start_line` and `end_line` to inspect targeted slices.\n\n");
    s.push_str("Available Tools:\n");
    let mut n = 1;
    for line in [
        r#"read_file: {"path":"string","start_line?":"number","end_line?":"number"}"#,
        r#"write_file: {"path":"string","content":"string"}"#,
        r#"edit_file: {"path":"string","old_str":"string","new_str":"string"} — old_str must match exactly once"#,
        r#"list_dir: {"path?":"string","depth?":"number"}"#,
        r#"search_files: {"pattern":"string","path?":"string"}"#,
        r#"activate_skill: {"name":"string","part?":"number","mode?":"upload|inline"}"#,
        r#"read_skill_resource: {"skill_name":"string","resource_path":"string","start_line?":"number","end_line?":"number"}"#,
    ] {
        s.push_str(&format!("{n}. {line}\n"));
        n += 1;
    }
    if shell_enabled {
        s.push_str(&format!(
            "{n}. run_shell: {{\"command\":\"string\",\"timeout_ms?\":\"number\"}} — requires manual approval\n"
        ));
        n += 1;
    }
    for (name, schema) in mcp.tool_schemas() {
        let compact = serde_json::to_string(&schema).unwrap_or_else(|_| "{}".into());
        s.push_str(&format!("{n}. {name}: {compact}\n"));
        n += 1;
    }
    s.push_str("\n<available_skills>\n");
    if skills.skills.is_empty() {
        s.push_str("- (none installed)\n");
    } else {
        for skill in &skills.skills {
            s.push_str(&format!("- {}: {}\n", skill.name, skill.description));
        }
    }
    s.push_str("</available_skills>\n</workspace_context>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_tool_omitted_when_disabled() {
        let infos = builtin_tool_infos(false);
        assert!(infos.iter().all(|t| t.name != "run_shell"));
        let enabled = builtin_tool_infos(true);
        assert!(enabled.iter().any(|t| t.name == "run_shell"));
    }

    #[test]
    fn workspace_context_lists_skills_and_syntax() {
        let index = SkillsIndex { skills: vec![] };
        let xml = build_workspace_context(false, &McpManager::empty(), &index, Path::new("/w"));
        assert!(xml.starts_with("<workspace_context cwd=\"/w\" shell_enabled=\"false\">"));
        assert!(xml.contains("```pdock_call"));
        assert!(xml.contains("activate_skill"));
        assert!(xml.contains("(none installed)"));
        assert!(!xml.contains("run_shell"));
        assert!(xml.ends_with("</workspace_context>"));

        let xml_shell =
            build_workspace_context(true, &McpManager::empty(), &index, Path::new("/w"));
        assert!(xml_shell.contains("run_shell"));
    }
}
