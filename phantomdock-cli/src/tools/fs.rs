//! Built-in filesystem tools: read_file, write_file, exact-once edit_file,
//! list_dir, search_files — all jailed by the Sandbox and filtered by the
//! secret deny-list.

use regex::Regex;
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use super::{opt_str, opt_usize, require_str, ToolContext, ToolError, ToolOk};
use crate::sandbox::SandboxError;

fn map_sandbox(e: SandboxError) -> ToolError {
    match e {
        SandboxError::OutsideWorkspace { path } => ToolError::new(
            "SANDBOX_DENIED",
            format!("path '{}' escapes the workspace jail", path.display()),
        ),
        SandboxError::DeniedSecret { path, glob } => ToolError::new(
            "DENIED_SECRET",
            format!("path '{path}' matches sensitive deny-list glob '{glob}'"),
        ),
        SandboxError::Io(io) => ToolError::new("IO_ERROR", io.to_string()),
    }
}

fn resolve_existing(ctx: &ToolContext<'_>, path: &str) -> Result<PathBuf, ToolError> {
    ctx.sandbox
        .resolve_existing(Path::new(path))
        .map_err(|e| match e {
            SandboxError::Io(io) if io.kind() == ErrorKind::NotFound => ToolError::new(
                "NOT_FOUND",
                format!("path '{path}' does not exist in the workspace"),
            ),
            other => map_sandbox(other),
        })
}

/// 1-based inclusive line slicing shared by read_file / read_skill_resource.
pub fn slice_lines(text: &str, start: Option<usize>, end: Option<usize>) -> String {
    let (Some(s), Some(e)) = (start, end) else {
        return text.to_string();
    };
    if s == 0 || e < s {
        return text.to_string();
    }
    let lines: Vec<&str> = text.lines().collect();
    let from = (s - 1).min(lines.len());
    let to = e.min(lines.len());
    if from >= to {
        return "(empty line range)".to_string();
    }
    lines[from..to].join("\n")
}

fn rel_display(ctx: &ToolContext<'_>, p: &Path) -> String {
    p.strip_prefix(&ctx.sandbox.cwd)
        .map(|r| r.display().to_string())
        .unwrap_or_else(|_| p.display().to_string())
}

pub fn read_file(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let path = require_str(args, "path")?;
    let start = opt_usize(args, "start_line")?;
    let end = opt_usize(args, "end_line")?;

    let target = resolve_existing(ctx, &path)?;
    if target.is_dir() {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("'{path}' is a directory — use list_dir"),
        ));
    }
    let raw = fs::read(&target).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    if raw.contains(&0u8) {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("'{path}' appears to be a binary file"),
        ));
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let sliced = slice_lines(&text, start, end);
    let total = text.lines().count() as u64;
    let mut header = String::new();
    if start.is_some() || end.is_some() {
        header = format!("[{path}: {} of {total} lines]\n", sliced.lines().count());
    }
    Ok(ToolOk::ok(format!("{header}{sliced}")))
}

pub fn write_file(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let path = require_str(args, "path")?;
    let content = require_str(args, "content")?;

    let target = ctx
        .sandbox
        .resolve_for_write(Path::new(&path))
        .map_err(map_sandbox)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    }
    fs::write(&target, &content).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    Ok(ToolOk::ok(format!(
        "Wrote {} bytes to {}",
        content.len(),
        rel_display(ctx, &target)
    )))
}

pub fn edit_file(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let path = require_str(args, "path")?;
    let old_str = require_str(args, "old_str")?;
    let new_str = require_str(args, "new_str")?;
    if old_str.is_empty() {
        return Err(ToolError::new("INVALID_ARGS", "old_str must not be empty"));
    }
    if old_str == new_str {
        return Err(ToolError::new(
            "INVALID_ARGS",
            "old_str and new_str are identical",
        ));
    }

    let target = resolve_existing(ctx, &path)?;
    let content = fs::read_to_string(&target).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;

    // Locate every occurrence (with 1-based line numbers) to enforce exact-once.
    let mut occurrences: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while let Some(p) = content[i..].find(&old_str) {
        occurrences.push(i + p);
        i += p + old_str.len().max(1);
    }

    if occurrences.is_empty() {
        return Err(ToolError::new(
            "EDIT_NOT_FOUND",
            format!("old_str was not found in '{path}'. Read the file (with line ranges) and adjust old_str."),
        ));
    }
    if occurrences.len() > 1 {
        let lines: Vec<String> = occurrences
            .iter()
            .map(|&pos| (content[..pos].matches('\n').count() + 1).to_string())
            .collect();
        return Err(ToolError::new(
            "EDIT_AMBIGUOUS",
            format!(
                "old_str matches {} locations in '{path}' (lines {}). Provide more surrounding context so it matches exactly once.",
                occurrences.len(),
                lines.join(", ")
            ),
        ));
    }

    let updated = content.replacen(&old_str, &new_str, 1);
    fs::write(&target, &updated).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    let removed = old_str.lines().count();
    let added = new_str.lines().count();
    Ok(ToolOk::ok(format!(
        "Edited {} (-{removed} +{added} lines)",
        rel_display(ctx, &target)
    )))
}

pub fn list_dir(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let path = opt_str(args, "path")?.unwrap_or_else(|| ".".to_string());
    let depth = opt_usize(args, "depth")?.unwrap_or(1).clamp(1, 6);

    let root = resolve_existing(ctx, &path)?;
    if !root.is_dir() {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("'{path}' is not a directory"),
        ));
    }

    const MAX_ENTRIES: usize = 500;
    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;

    fn walk(
        ctx: &ToolContext<'_>,
        dir: &Path,
        rel: &str,
        depth_left: usize,
        lines: &mut Vec<String>,
        truncated: &mut bool,
    ) {
        if *truncated {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<(PathBuf, bool, u64)> = rd
            .flatten()
            .map(|e| {
                let is_dir = e.path().is_dir();
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                (e.path(), is_dir, size)
            })
            .collect();
        entries.sort_by(|a, b| a.0.file_name().cmp(&b.0.file_name()));
        for (p, is_dir, size) in entries {
            if lines.len() >= MAX_ENTRIES {
                *truncated = true;
                return;
            }
            if ctx.sandbox.denied_glob_for(&p).is_some() {
                continue; // silently skip denied entries
            }
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if is_dir {
                lines.push(format!("[dir]  {child_rel}/"));
                if depth_left > 1 {
                    walk(ctx, &p, &child_rel, depth_left - 1, lines, truncated);
                }
            } else {
                lines.push(format!("[file] {child_rel} ({})", human_size(size)));
            }
        }
    }

    walk(ctx, &root, "", depth, &mut lines, &mut truncated);
    if lines.is_empty() {
        lines.push("(empty directory)".to_string());
    }
    if truncated {
        lines.push(format!("… (listing truncated at {MAX_ENTRIES} entries)"));
    }
    Ok(ToolOk::ok(lines.join("\n")))
}

fn human_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

pub fn search_files(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let pattern = require_str(args, "pattern")?;
    let path = opt_str(args, "path")?.unwrap_or_else(|| ".".to_string());

    let root = resolve_existing(ctx, &path)?;
    let re = Regex::new(&pattern)
        .or_else(|_| Regex::new(&regex::escape(&pattern)))
        .map_err(|_| ToolError::new("INVALID_ARGS", format!("invalid pattern '{pattern}'")))?;

    const MAX_MATCHES: usize = 200;
    const MAX_DEPTH: usize = 10;
    const MAX_FILE_BYTES: u64 = 1_000_000;

    let mut matches: Vec<String> = Vec::new();
    let mut files_scanned = 0usize;

    fn walk(
        ctx: &ToolContext<'_>,
        re: &Regex,
        dir: &Path,
        rel: &str,
        depth_left: usize,
        matches: &mut Vec<String>,
        files_scanned: &mut usize,
    ) {
        if matches.len() >= MAX_MATCHES || depth_left == 0 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            if matches.len() >= MAX_MATCHES {
                return;
            }
            let p = entry.path();
            if ctx.sandbox.denied_glob_for(&p).is_some() {
                continue;
            }
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if p.is_dir() {
                walk(ctx, re, &p, &child_rel, depth_left - 1, matches, files_scanned);
            } else {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                let Ok(raw) = fs::read(&p) else { continue };
                if raw.contains(&0u8) {
                    continue;
                }
                *files_scanned += 1;
                let text = String::from_utf8_lossy(&raw);
                for (idx, line) in text.lines().enumerate() {
                    if re.is_match(line) {
                        if matches.len() >= MAX_MATCHES {
                            return;
                        }
                        let shown: String = line.trim().chars().take(200).collect();
                        matches.push(format!("{child_rel}:{}:{}", idx + 1, shown));
                    }
                }
            }
        }
    }

    walk(ctx, &re, &root, "", MAX_DEPTH, &mut matches, &mut files_scanned);
    let mut out = format!(
        "pattern: {pattern} — {} match(es) in {files_scanned} file(s)\n",
        matches.len()
    );
    out.push_str(&matches.join("\n"));
    if matches.len() >= MAX_MATCHES {
        out.push_str("\n… (match list truncated at 200 — narrow the pattern or path)");
    }
    Ok(ToolOk::ok(out))
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

    fn ctx_in(tmp: &TempDir) -> (Sandbox, Config) {
        (
            Sandbox::new(tmp.path().to_path_buf(), vec![".env".into(), "*.pem".into()]).unwrap(),
            Config::default(),
        )
    }

    fn with_ctx<T>(tmp: &TempDir, f: impl FnOnce(&ToolContext<'_>) -> T) -> T {
        let (sb, cfg) = ctx_in(tmp);
        let index = SkillsIndex::default();
        let mcp = McpManager::empty();
        let ctx = ToolContext {
            call_id: "call_test".to_string(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: false,
        };
        f(&ctx)
    }

    fn setup_workspace(tmp: &TempDir) {
        fs::write(tmp.path().join("app.rs"), "fn main() {\n    let x = 1;\n    println!(\"{{x}}\");\n}\n").unwrap();
        fs::create_dir_all(tmp.path().join("src")).unwrap();
        fs::write(tmp.path().join("src/lib.rs"), "pub fn a() -> u32 { 1 }\npub fn b() -> u32 { 2 }\n").unwrap();
        fs::write(tmp.path().join(".env"), "SECRET=1").unwrap();
        fs::write(tmp.path().join("key.pem"), "-----BEGIN").unwrap();
    }

    #[test]
    fn read_file_full_and_ranged() {
        let tmp = TempDir::new().unwrap();
        setup_workspace(&tmp);
        with_ctx(&tmp, |ctx| {
            let ok = read_file(&json!({"path": "src/lib.rs"}), ctx).unwrap();
            assert!(ok.text.contains("pub fn a()"));
            let ranged = read_file(
                &json!({"path": "src/lib.rs", "start_line": 2, "end_line": 2}),
                ctx,
            )
            .unwrap();
            assert_eq!(ranged.text, "[src/lib.rs: 1 of 2 lines]\npub fn b() -> u32 { 2 }");
        });
    }

    #[test]
    fn read_file_denies_secrets() {
        let tmp = TempDir::new().unwrap();
        setup_workspace(&tmp);
        with_ctx(&tmp, |ctx| {
            for p in [".env", "key.pem"] {
                let err = read_file(&json!({"path": p}), ctx).unwrap_err();
                assert_eq!(err.code, "DENIED_SECRET", "{p} should be denied");
            }
        });
    }

    #[test]
    fn write_file_creates_nested_parents() {
        let tmp = TempDir::new().unwrap();
        with_ctx(&tmp, |ctx| {
            let ok = write_file(
                &json!({"path": "deep/nested/dir/new.txt", "content": "hello"}),
                ctx,
            )
            .unwrap();
            assert!(ok.text.contains("Wrote 5 bytes"));
            assert!(tmp.path().join("deep/nested/dir/new.txt").exists());
        });
    }

    #[test]
    fn edit_file_exact_once_semantics() {
        let tmp = TempDir::new().unwrap();
        with_ctx(&tmp, |ctx| {
            fs::write(tmp.path().join("dup.txt"), "alpha\nbeta\nalpha\n").unwrap();

            let zero = edit_file(
                &json!({"path": "dup.txt", "old_str": "gamma", "new_str": "x"}),
                ctx,
            )
            .unwrap_err();
            assert_eq!(zero.code, "EDIT_NOT_FOUND");

            let amb = edit_file(
                &json!({"path": "dup.txt", "old_str": "alpha", "new_str": "x"}),
                ctx,
            )
            .unwrap_err();
            assert_eq!(amb.code, "EDIT_AMBIGUOUS");
            assert!(amb.message.contains("lines 1, 3"), "got: {}", amb.message);

            let ok = edit_file(
                &json!({"path": "dup.txt", "old_str": "beta", "new_str": "gamma\ndelta"}),
                ctx,
            )
            .unwrap();
            assert!(ok.text.contains("-1 +2"));
            let after = fs::read_to_string(tmp.path().join("dup.txt")).unwrap();
            assert_eq!(after, "alpha\ngamma\ndelta\nalpha\n");
        });
    }

    #[test]
    fn list_dir_skips_denied_entries() {
        let tmp = TempDir::new().unwrap();
        setup_workspace(&tmp);
        with_ctx(&tmp, |ctx| {
            let ok = list_dir(&json!({}), ctx).unwrap();
            assert!(ok.text.contains("[dir]  src/"));
            assert!(ok.text.contains("app.rs"));
            assert!(!ok.text.contains(".env"));
            assert!(!ok.text.contains("key.pem"));
        });
    }

    #[test]
    fn search_files_finds_matches_and_skips_secrets() {
        let tmp = TempDir::new().unwrap();
        setup_workspace(&tmp);
        with_ctx(&tmp, |ctx| {
            let ok = search_files(&json!({"pattern": "pub fn"}), ctx).unwrap();
            assert!(ok.text.contains("src/lib.rs:1:"));
            assert!(ok.text.contains("2 match(es)"));
            // Regex mode works too.
            let re = search_files(&json!({"pattern": "pub fn [ab]"}), ctx).unwrap();
            assert!(re.text.contains("src/lib.rs"));
            // Literal fallback for invalid regex.
            let lit = search_files(&json!({"pattern": "(unclosed"}), ctx).unwrap();
            assert!(lit.text.contains("0 match(es)"));
        });
    }
}
