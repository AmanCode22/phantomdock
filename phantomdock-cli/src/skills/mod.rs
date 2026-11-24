//! Agent Skills (`SKILL.md`) discovery with workspace-over-global precedence.
//!
//! Automatically scans PhantomDock, Claude Code, Cursor, Codex, Windsurf,
//! Gemini CLI, OpenCode, Roo, Cline, and `.agents` skill directories (both
//! workspace-local and global under `~/`), plus custom `skill_dirs` configured
//! in `~/.pdock/config.toml` or `--skills-dir`.

pub mod loader;
pub mod splitter;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use crate::config::{expand_tilde, home_dir};

const WORKSPACE_SKILL_DIRS: &[&str] = &[
    ".phantomdock/skills",
    ".pdock/skills",
    ".claude/skills",
    ".agents/skills",
    ".cursor/skills",
    ".codex/skills",
    ".windsurf/skills",
    ".gemini/skills",
    ".opencode/skills",
    ".roo/skills",
    ".cline/skills",
];

const GLOBAL_SKILL_DIRS: &[&str] = &[
    ".pdock/skills",
    ".config/phantomdock/skills",
    ".claude/skills",
    ".agents/skills",
    ".cursor/skills",
    ".codex/skills",
    ".windsurf/skills",
    ".gemini/skills",
    ".config/opencode/skills",
    ".roo/skills",
    ".cline/skills",
];

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Canonical skill root directory (jail root for read_skill_resource).
    pub dir: PathBuf,
    pub content: String,
}

#[derive(Debug, Default)]
pub struct SkillsIndex {
    pub skills: Vec<Skill>,
}

impl SkillsIndex {
    pub fn find(&self, name: &str) -> Option<&Skill> {
        self.skills.iter().find(|s| s.name == name)
    }

    pub fn names(&self) -> Vec<String> {
        self.skills.iter().map(|s| s.name.clone()).collect()
    }
}

pub fn discover(extra_dirs: &[PathBuf]) -> SkillsIndex {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    discover_in(&cwd, extra_dirs)
}

/// Discovery with an explicit workspace root (testable without cwd games).
pub fn discover_in(cwd: &Path, extra_dirs: &[PathBuf]) -> SkillsIndex {
    let mut dirs: Vec<PathBuf> = WORKSPACE_SKILL_DIRS
        .iter()
        .map(|rel| cwd.join(rel))
        .collect();

    for d in extra_dirs {
        let expanded = expand_tilde(d);
        dirs.push(if expanded.is_absolute() {
            expanded
        } else {
            cwd.join(expanded)
        });
    }

    if let Some(home) = home_dir() {
        for rel in GLOBAL_SKILL_DIRS {
            dirs.push(home.join(rel));
        }
    }

    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    let mut by_name: BTreeMap<String, Skill> = BTreeMap::new();
    for d in dirs {
        let canon_dir = d.canonicalize().unwrap_or(d);
        if !seen_dirs.insert(canon_dir.clone()) {
            continue;
        }
        let Ok(read_dir) = std::fs::read_dir(&canon_dir) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = read_dir
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        subdirs.sort();
        for skill_dir in subdirs {
            let skill_md = skill_dir.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let Some(dir_name) = skill_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
            else {
                continue;
            };
            if !valid_skill_name(&dir_name) {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm_name, fm_desc) = parse_frontmatter(&content);
            let name = match fm_name {
                Some(n) if valid_skill_name(&n) => n,
                _ => dir_name,
            };
            if by_name.contains_key(&name) {
                continue; // earlier directory wins (workspace overrides global)
            }
            let description = fm_desc.unwrap_or_else(|| first_meaningful_line(&content));
            let canonical = skill_dir.canonicalize().unwrap_or(skill_dir);
            let skill = Skill {
                name: name.clone(),
                description,
                dir: canonical,
                content,
            };
            by_name.insert(name, skill);
        }
    }
    SkillsIndex {
        skills: by_name.into_values().collect(),
    }
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Parse simple YAML frontmatter (`---` ... `---`) extracting `name` and `description`.
/// Returns `(None, None)` when frontmatter is absent or unterminated.
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let rest = &trimmed[3..];
    let rest = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))
        .unwrap_or(rest);

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in rest.lines() {
        let l = line.trim();
        if l == "---" {
            return (name, description); // properly terminated
        }
        if let Some(v) = l.strip_prefix("name:") {
            if name.is_none() {
                name = Some(clean_fm_value(v));
            }
        } else if let Some(v) = l.strip_prefix("description:") {
            if description.is_none() {
                let mut d = clean_fm_value(v);
                if d.chars().count() > 160 {
                    d = d.chars().take(160).collect();
                }
                description = Some(d);
            }
        }
    }
    (None, None) // unterminated frontmatter — treat as absent
}

fn clean_fm_value(v: &str) -> String {
    let mut s = v.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s = &s[1..s.len() - 1];
    }
    s.trim().to_string()
}

fn first_meaningful_line(content: &str) -> String {
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() || l == "---" || l.starts_with('#') {
            continue;
        }
        let mut s: String = l.chars().take(160).collect();
        s.truncate(s.len());
        return s;
    }
    "(no description)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn frontmatter_name_and_description() {
        let md = "---\nname: grill-me\ndescription: \"Interview the user relentlessly\"\n---\n\n# Grill Me\nBody.";
        let (n, d) = parse_frontmatter(md);
        assert_eq!(n.as_deref(), Some("grill-me"));
        assert_eq!(d.as_deref(), Some("Interview the user relentlessly"));
    }

    #[test]
    fn frontmatter_absent_and_unterminated() {
        assert_eq!(parse_frontmatter("# Just a heading"), (None, None));
        let unterminated = "---\nname: x\nno close";
        assert_eq!(parse_frontmatter(unterminated), (None, None));
    }

    #[test]
    fn frontmatter_single_quotes_and_trimming() {
        let md = "---\nname:   'my-skill'  \ndescription: short one\n---\n";
        let (n, d) = parse_frontmatter(md);
        assert_eq!(n.as_deref(), Some("my-skill"));
        assert_eq!(d.as_deref(), Some("short one"));
    }

    #[test]
    fn discovery_finds_workspace_claude_agents_and_custom_dirs() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join(".phantomdock/skills/grill-me");
        fs::create_dir_all(&ws).unwrap();
        fs::write(
            ws.join("SKILL.md"),
            "---\nname: grill-me\ndescription: workspace copy\n---\nbody",
        )
        .unwrap();

        let claude = tmp.path().join(".claude/skills/code-review");
        fs::create_dir_all(&claude).unwrap();
        fs::write(
            claude.join("SKILL.md"),
            "---\nname: code-review\ndescription: claude skill\n---\nbody",
        )
        .unwrap();

        let custom_root = tmp.path().join("custom-skills");
        let pdf_dir = custom_root.join("pdf-tools");
        fs::create_dir_all(&pdf_dir).unwrap();
        fs::write(pdf_dir.join("SKILL.md"), "# PDF tools\nWork with PDFs.").unwrap();

        let index = discover_in(tmp.path(), std::slice::from_ref(&custom_root));

        let grill = index.find("grill-me").expect("workspace skill found");
        assert_eq!(grill.description, "workspace copy");
        let review = index.find("code-review").expect("claude skill found");
        assert_eq!(review.description, "claude skill");
        let pdf = index.find("pdf-tools").expect("custom skill found");
        assert!(!pdf.description.is_empty());
        assert!(pdf.dir.starts_with(custom_root.canonicalize().unwrap()));
    }

    #[test]
    fn workspace_overrides_same_named_global_skill() {
        let tmp = TempDir::new().unwrap();
        for (root, desc) in [
            (".phantomdock/skills/grill-me", "workspace copy"),
            (".agents/skills/grill-me", "agents copy"),
        ] {
            let dir = tmp.path().join(root);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: grill-me\ndescription: {desc}\n---\nbody"),
            )
            .unwrap();
        }
        let index = discover_in(tmp.path(), &[]);
        assert_eq!(index.skills.len(), 1, "same-name skills collapse");
        assert_eq!(
            index.find("grill-me").unwrap().description,
            "workspace copy"
        );
    }
}
