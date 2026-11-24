//! Skill loading: upload bundle compilation, activation (upload / chunked inline)
//! and jailed auxiliary resource reads.

use serde_json::Value;
use std::io::ErrorKind;

use super::splitter;
use crate::tools::{ChunkInfo, Delivery, ToolContext, ToolError, ToolOk};

/// Compile the `<skill-name>-skill.md` bundle: full SKILL.md content plus a
/// generated footer listing bundled `scripts/`, `references/`, and `assets/`.
pub fn bundle(skill: &super::Skill) -> String {
    let mut out = skill.content.clone();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n---\n\n## Bundled Resources\n\n");
    out.push_str("This skill directory may contain `scripts/`, `references/`, and `assets/`. ");
    out.push_str("Read them on demand with `read_skill_resource` (jailed to this skill's root).\n");
    for sub in ["scripts", "references", "assets"] {
        let d = skill.dir.join(sub);
        if let Ok(rd) = std::fs::read_dir(&d) {
            let mut names: Vec<String> = rd
                .flatten()
                .filter(|e| e.path().is_file())
                .take(50)
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            if !names.is_empty() {
                out.push_str(&format!("\n- `{sub}/`: {}\n", names.join(", ")));
            }
        }
    }
    out
}

/// Handle `list_skills {"page?","page_size?","query?"}` with pagination so
/// `<workspace_context>` stays compact even when hundreds of skills are installed.
pub fn list_skills(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let page = crate::tools::opt_usize(args, "page")?.unwrap_or(1).max(1);
    let page_size = crate::tools::opt_usize(args, "page_size")?
        .unwrap_or(25)
        .clamp(1, 100);
    let query = crate::tools::opt_str(args, "query")?
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());

    let filtered: Vec<&super::Skill> = ctx
        .skills
        .skills
        .iter()
        .filter(|s| match &query {
            None => true,
            Some(q) => {
                s.name.to_lowercase().contains(q) || s.description.to_lowercase().contains(q)
            }
        })
        .collect();

    let total = filtered.len();
    if total == 0 {
        return Ok(ToolOk::ok(match &query {
            Some(q) => format!("No skills matched query '{q}'."),
            None => "No skills installed.".to_string(),
        }));
    }

    let total_pages = total.div_ceil(page_size);
    if page > total_pages {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("page {page} out of range 1..={total_pages} ({total} matching skills)"),
        ));
    }

    let start = (page - 1) * page_size;
    let end = (start + page_size).min(total);
    let mut out = format!(
        "Skills (page {page}/{total_pages}, showing {}-{end} of {total}):
",
        start + 1
    );
    for skill in &filtered[start..end] {
        out.push_str(&format!("- {}: {}
", skill.name, skill.description));
    }
    if page < total_pages {
        let next = page + 1;
        match &query {
            Some(q) => out.push_str(&format!(
                "
Call `list_skills` with {{"page":{next},"page_size":{page_size},"query":"{q}"}} for the next page."
            )),
            None => out.push_str(&format!(
                "
Call `list_skills` with {{"page":{next},"page_size":{page_size}}} for the next page."
            )),
        }
    }
    Ok(ToolOk::ok(out))
}

/// Handle `activate_skill {"name", "part?", "mode?"}`.
///
/// - upload mode (default): returns the full bundle for the extension to attach
///   as `<name>-skill.md` via its cascading input → paste → drop uploader.
/// - inline mode (or explicit `part`): returns Markdown-aware chunk `part` of N
///   with a section outline, per the chunked inline delivery protocol.
pub fn activate(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let name = crate::tools::require_str(args, "name")?;
    let part = crate::tools::opt_usize(args, "part")?;
    let mode = args
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("upload")
        .to_string();

    let skill = ctx
        .skills
        .find(&name)
        .ok_or_else(|| ToolError::new("SKILL_NOT_FOUND", skill_not_found(ctx, &name)))?;

    let bundle_text = bundle(skill);
    let chunk = ctx.config.inline_skill_chunk_chars.max(500);

    if mode == "inline" || part.is_some() {
        let p = part.unwrap_or(1).max(1);
        let parts = splitter::split_markdown(&bundle_text, chunk);
        if parts.is_empty() {
            return Err(ToolError::new("INTERNAL", "skill produced no parts"));
        }
        let total = parts.len();
        if p > total {
            return Err(ToolError::new(
                "INVALID_ARGS",
                format!("part {p} out of range 1..={total} for skill '{name}'"),
            ));
        }
        let section = &parts[p - 1];
        let mut header = if total > 1 {
            let mut outline = String::new();
            for (i, h) in section.outline.iter().enumerate() {
                outline.push_str(&format!("  {}. {}\n", i + 1, h));
            }
            format!("[Skill: {name} | Part {p} of {total}]\nOutline of this part:\n{outline}\n")
        } else {
            format!("[Skill: {name} | complete]\n")
        };
        if p < total {
            header.push_str(&format!(
                "Call `activate_skill` with {{\"name\":\"{name}\",\"part\":{}}} for the next part.\n\n",
                p + 1
            ));
        } else if total > 1 {
            header.push_str("(This is the final part.)\n\n");
        }
        return Ok(ToolOk {
            status: "inline_part",
            text: format!("{header}{}", section.text),
            delivery: Some(Delivery::InlinePart {
                part: p,
                total_parts: total,
                outline: section.outline.clone(),
            }),
        });
    }

    // Upload mode: hand the full bundle to the extension for cascading upload.
    let filename = format!("{}-skill.md", skill.name);
    let total_parts = splitter::split_markdown(&bundle_text, chunk).len();
    Ok(ToolOk {
        status: "upload_ready",
        text: format!(
            "Skill `{}` is being attached as `{}` ({} chars). Follow it strictly. \
             If the attachment cannot be delivered, call with mode=\"inline\" for chunked parts.",
            skill.name,
            filename,
            bundle_text.chars().count()
        ),
        delivery: Some(Delivery::Upload {
            filename,
            mime: "text/markdown".to_string(),
            content: bundle_text,
            chunk_info: Some(ChunkInfo {
                chunk_size_chars: chunk,
                total_parts,
            }),
        }),
    })
}

fn skill_not_found(ctx: &ToolContext<'_>, asked: &str) -> String {
    let names = ctx.skills.names();
    if names.is_empty() {
        format!("Skill '{asked}' not found. No skills are installed.")
    } else {
        format!(
            "Skill '{asked}' not found. Available skills: {}",
            names.join(", ")
        )
    }
}

/// Handle `read_skill_resource {"skill_name","resource_path","start_line?","end_line?"}`.
/// Strictly jailed to the skill's canonical root directory.
pub fn read_resource(args: &Value, ctx: &ToolContext<'_>) -> Result<ToolOk, ToolError> {
    let skill_name = crate::tools::require_str(args, "skill_name")?;
    let resource_path = crate::tools::require_str(args, "resource_path")?;
    let start = crate::tools::opt_usize(args, "start_line")?;
    let end = crate::tools::opt_usize(args, "end_line")?;

    let skill = ctx
        .skills
        .find(&skill_name)
        .ok_or_else(|| ToolError::new("SKILL_NOT_FOUND", skill_not_found(ctx, &skill_name)))?;

    let target = skill.dir.join(&resource_path);
    let canon = target.canonicalize().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            ToolError::new(
                "NOT_FOUND",
                format!("resource '{resource_path}' not found in skill '{skill_name}'"),
            )
        } else {
            ToolError::new("IO_ERROR", e.to_string())
        }
    })?;
    if !canon.starts_with(&skill.dir) {
        return Err(ToolError::new(
            "SANDBOX_DENIED",
            format!("resource_path '{resource_path}' escapes skill root"),
        ));
    }
    if canon.is_dir() {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!("resource '{resource_path}' is a directory"),
        ));
    }

    let meta = std::fs::metadata(&canon).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    if meta.len() > 2_000_000 && (start.is_none() || end.is_none()) {
        return Err(ToolError::new(
            "INVALID_ARGS",
            format!(
                "resource is {} bytes; request an explicit start_line/end_line range",
                meta.len()
            ),
        ));
    }

    let raw = std::fs::read(&canon).map_err(|e| ToolError::new("IO_ERROR", e.to_string()))?;
    if raw.contains(&0u8) {
        return Err(ToolError::new(
            "INVALID_ARGS",
            "resource appears to be binary; only text resources are supported",
        ));
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let sliced = crate::tools::fs::slice_lines(&text, start, end);
    Ok(ToolOk::ok(sliced))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::sandbox::Sandbox;
    use crate::skills::{Skill, SkillsIndex};
    use serde_json::json;
    use tempfile::TempDir;

    struct Fixtures {
        index: SkillsIndex,
        sb: Sandbox,
        cfg: Config,
        mcp: crate::mcp::Manager,
    }

    fn fixtures(tmp: &TempDir, body: &str) -> Fixtures {
        let dir = tmp.path().join("grill-me");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
        std::fs::write(
            dir.join("references/cheatsheet.txt"),
            "line1\nline2\nline3\n",
        )
        .unwrap();
        let index = SkillsIndex {
            skills: vec![Skill {
                name: "grill-me".to_string(),
                description: "test skill".into(),
                dir: dir.canonicalize().unwrap(),
                content: body.to_string(),
            }],
        };
        Fixtures {
            index,
            sb: Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap(),
            cfg: Config::default(),
            mcp: crate::mcp::Manager::empty(),
        }
    }

    impl Fixtures {
        fn ctx(&self) -> ToolContext<'_> {
            ToolContext {
                call_id: "test_call".to_string(),
                sandbox: &self.sb,
                config: &self.cfg,
                skills: &self.index,
                mcp: &self.mcp,
                shell_enabled: false,
            }
        }
    }

    #[test]
    fn upload_delivery_contains_bundle_with_footer() {
        let tmp = TempDir::new().unwrap();
        let fx = fixtures(&tmp, "# Grill Me\n\nInterview hard.\n");
        let ctx = fx.ctx();
        let ok = activate(&json!({"name": "grill-me"}), &ctx).unwrap();
        assert_eq!(ok.status, "upload_ready");
        match &ok.delivery.unwrap() {
            Delivery::Upload {
                filename, content, ..
            } => {
                assert_eq!(filename, "grill-me-skill.md");
                assert!(content.contains("# Grill Me"));
                assert!(content.contains("references/"));
            }
            other => panic!("expected upload delivery, got {other:?}"),
        }
    }

    #[test]
    fn inline_mode_chunks_large_skills() {
        let tmp = TempDir::new().unwrap();
        let mut body = String::from("# Grill Me\n\n");
        for i in 0..40 {
            body.push_str(&format!("## Section {i}\n\n{}\n\n", "word ".repeat(200)));
        }
        let fx = fixtures(&tmp, &body);
        let cfg = Config {
            inline_skill_chunk_chars: 3000,
            ..Config::default()
        };
        let sb = Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap();
        let ctx = ToolContext {
            call_id: "c".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &fx.index,
            mcp: &crate::mcp::Manager::empty(),
            shell_enabled: false,
        };

        let p1 = activate(&json!({"name": "grill-me", "mode": "inline"}), &ctx).unwrap();
        assert_eq!(p1.status, "inline_part");
        match &p1.delivery.unwrap() {
            Delivery::InlinePart {
                part, total_parts, ..
            } => {
                assert_eq!(*part, 1);
                assert!(*total_parts > 1);
            }
            other => panic!("expected inline delivery, got {other:?}"),
        }

        let missing = activate(&json!({"name": "grill-me", "part": 999}), &ctx).unwrap_err();
        assert_eq!(missing.code, "INVALID_ARGS");
    }

    #[test]
    fn resource_read_is_jailed_to_skill_root() {
        let tmp = TempDir::new().unwrap();
        let fx = fixtures(&tmp, "# Grill\nbody");
        let ctx = fx.ctx();

        let ok = read_resource(
            &json!({"skill_name": "grill-me", "resource_path": "references/cheatsheet.txt"}),
            &ctx,
        )
        .unwrap();
        assert!(ok.text.contains("line1"));

        let ranged = read_resource(
            &json!({"skill_name": "grill-me", "resource_path": "references/cheatsheet.txt", "start_line": 2, "end_line": 3}),
            &ctx,
        )
        .unwrap();
        assert_eq!(ranged.text, "line2\nline3");

        let escape = read_resource(
            &json!({"skill_name": "grill-me", "resource_path": "../../outside.txt"}),
            &ctx,
        )
        .unwrap_err();
        assert_eq!(escape.code, "NOT_FOUND"); // ../.. escapes skill root and does not exist
    }

    #[test]
    fn list_skills_paginates_and_filters() {
        let tmp = TempDir::new().unwrap();
        let skills: Vec<Skill> = (1..=5)
            .map(|i| Skill {
                name: format!("skill-{i:02}"),
                description: if i == 3 {
                    "special rust helper".into()
                } else {
                    format!("desc {i}")
                },
                dir: tmp.path().to_path_buf(),
                content: "body".into(),
            })
            .collect();
        let index = SkillsIndex { skills };
        let sb = Sandbox::new(tmp.path().to_path_buf(), vec![]).unwrap();
        let cfg = Config::default();
        let mcp = crate::mcp::Manager::empty();
        let ctx = ToolContext {
            call_id: "c".into(),
            sandbox: &sb,
            config: &cfg,
            skills: &index,
            mcp: &mcp,
            shell_enabled: false,
        };

        let p1 = list_skills(&json!({"page": 1, "page_size": 2}), &ctx).unwrap();
        assert!(p1.text.contains("page 1/3"));
        assert!(p1.text.contains("skill-01"));
        assert!(p1.text.contains("skill-02"));
        assert!(!p1.text.contains("skill-03"));
        assert!(p1.text.contains(r#""page":2"#));

        let filtered = list_skills(&json!({"query": "rust"}), &ctx).unwrap();
        assert!(filtered.text.contains("skill-03"));
        assert!(!filtered.text.contains("skill-01"));

        let oob = list_skills(&json!({"page": 9, "page_size": 2}), &ctx).unwrap_err();
        assert_eq!(oob.code, "INVALID_ARGS");
    }
}
