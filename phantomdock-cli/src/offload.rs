//! Oversized output offloading: outputs exceeding `max_inline_chars` are written
//! to `.phantomdock/outputs/<call_id>.txt` (with `.phantomdock/` added to
//! `.git/info/exclude`), returning a compact head/tail preview plus read_file
//! paging instructions.

use std::fs;
use std::path::Path;

use crate::sandbox::Sandbox;
use crate::tools::{Delivery, ToolError, ToolOk};

const HEAD_LINES: usize = 40;
const TAIL_LINES: usize = 20;

pub fn offload(call_id: &str, text: &str, sandbox: &Sandbox) -> Result<ToolOk, ToolError> {
    let safe_id = sanitize_call_id(call_id);
    let rel_path = format!(".phantomdock/outputs/{safe_id}.txt");
    let target = sandbox
        .resolve_for_write(Path::new(&rel_path))
        .map_err(|e| ToolError::new("SANDBOX_DENIED", e.to_string()))?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    }
    fs::write(&target, text).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;

    ensure_git_exclude(&sandbox.cwd);

    let lines: Vec<&str> = text.lines().collect();
    let total_chars = text.chars().count();
    let mut preview = String::new();
    preview.push_str(&format!(
        "[Output offloaded: {total_chars} chars, {} lines → {rel_path}]\n",
        lines.len()
    ));
    if lines.len() <= HEAD_LINES + TAIL_LINES + 4 {
        preview.push_str(text);
    } else {
        for l in &lines[..HEAD_LINES] {
            preview.push_str(l);
            preview.push('\n');
        }
        let omitted = lines.len() - HEAD_LINES - TAIL_LINES;
        preview.push_str(&format!(
            "\n… [{omitted} lines omitted — inspect with read_file line ranges] …\n\n"
        ));
        for l in &lines[lines.len() - TAIL_LINES..] {
            preview.push_str(l);
            preview.push('\n');
        }
    }
    preview.push_str(&format!(
        "\nUse read_file {{\"path\":\"{rel_path}\",\"start_line\":{},\"end_line\":{}}} to page through.",
        HEAD_LINES + 1,
        HEAD_LINES + 40
    ));

    Ok(ToolOk {
        status: "offloaded",
        text: preview,
        delivery: Some(Delivery::Offload {
            path: rel_path,
            total_chars,
        }),
    })
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

/// Ensure `.phantomdock/` is present in `.git/info/exclude` (best-effort hygiene).
fn ensure_git_exclude(cwd: &Path) {
    let git = cwd.join(".git");
    if !git.is_dir() {
        return;
    }
    let info = git.join("info");
    if fs::create_dir_all(&info).is_err() {
        return;
    }
    let excl = info.join("exclude");
    let existing = fs::read_to_string(&excl).unwrap_or_default();
    if !existing.lines().any(|l| l.trim() == ".phantomdock/") {
        let mut updated = existing;
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push('\n');
        }
        updated.push_str(".phantomdock/\n");
        let _ = fs::write(&excl, updated);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::mcp::Manager as McpManager;
    use crate::skills::SkillsIndex;
    use crate::tools::Registry;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn oversized_output_offloads_with_preview() {
        let tmp = TempDir::new().unwrap();
        let sb = Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap();
        let big = (0..500).map(|i| format!("line {i:04} — some content here")).collect::<Vec<_>>().join("\n");

        let ok = offload("call_01", &big, &sb).unwrap();
        assert_eq!(ok.status, "offloaded");
        assert!(ok.text.contains("Output offloaded"));
        assert!(ok.text.contains("line 0000"));
        assert!(ok.text.contains("lines omitted"));
        assert!(ok.text.contains("read_file"));
        match &ok.delivery.unwrap() {
            Delivery::Offload { path, total_chars } => {
                assert_eq!(path, ".phantomdock/outputs/call_01.txt");
                assert!(*total_chars > 10_000);
            }
            other => panic!("expected offload delivery, got {other:?}"),
        }
        assert!(tmp.path().join(".phantomdock/outputs/call_01.txt").exists());
    }

    #[test]
    fn call_id_sanitized_for_filenames() {
        let tmp = TempDir::new().unwrap();
        let sb = Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap();
        let ok = offload("../../etc/evil", &"x".repeat(20000), &sb).unwrap();
        match &ok.delivery.unwrap() {
            Delivery::Offload { path, .. } => {
                assert_eq!(path, ".phantomdock/outputs/etcevil.txt");
                assert!(!path.contains(".."));
                assert!(path.ends_with(".txt"));
            }
            other => panic!("expected offload delivery, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn registry_offloads_large_read_results() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("big.txt"),
            (0..600).map(|i| format!("row {i:03} padding padding padding")).collect::<Vec<_>>().join("\n"),
        )
        .unwrap();
        let sb = Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap();
        let cfg = Config {
            max_inline_chars: 2_000,
            ..Config::default()
        };
        let index = SkillsIndex::default();
        let mcp = McpManager::empty();
        let ctx = crate::tools::ToolContext {
            call_id: "call_big".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: false,
        };
        let reg = Registry::new();
        let ok = reg
            .execute("read_file", &json!({"path": "big.txt"}), &ctx)
            .await
            .unwrap();
        assert_eq!(ok.status, "offloaded");
        assert!(tmp.path().join(".phantomdock/outputs/call_big.txt").exists());
    }
}
