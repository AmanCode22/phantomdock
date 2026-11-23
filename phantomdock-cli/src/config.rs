//! Configuration loading: defaults ← config file ← CLI overrides.
//!
//! Config file search order (first found wins):
//!   1. explicit `--config PATH`
//!   2. `./phantomdock.toml` (workspace)
//!   3. `~/.config/phantomdock/config.toml` (global)
//!
//! A workspace `.phantomdockignore` file always contributes extra deny globs.

use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};

pub const DEFAULT_DENY_GLOBS: &[&str] = &[".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".git/**"];

#[derive(Debug, Clone)]
pub struct Config {
    pub max_inline_chars: usize,
    pub inline_skill_chunk_chars: usize,
    pub mcp_tool_timeout_secs: u64,
    pub skill_dirs: Vec<PathBuf>,
    pub deny_globs: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_inline_chars: 16_000,
            inline_skill_chunk_chars: 6_000,
            mcp_tool_timeout_secs: 30,
            skill_dirs: Vec::new(),
            deny_globs: DEFAULT_DENY_GLOBS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Parse(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "config io error: {e}"),
            ConfigError::Parse(e) => write!(f, "config parse error: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Deserialize, Default)]
struct FileConfig {
    max_inline_chars: Option<usize>,
    inline_skill_chunk_chars: Option<usize>,
    mcp_tool_timeout_secs: Option<u64>,
    skill_dirs: Option<Vec<PathBuf>>,
    sandbox: Option<FileSandbox>,
}

#[derive(Deserialize, Default)]
struct FileSandbox {
    deny_globs: Option<Vec<String>>,
}

/// Load configuration. Returns the merged config plus a human-readable source label.
pub fn load(explicit: Option<&Path>) -> Result<(Config, Option<String>), ConfigError> {
    let mut cfg = Config::default();
    let mut source: Option<String> = None;

    let chosen: Option<PathBuf> = match explicit {
        Some(p) => Some(p.to_path_buf()),
        None => {
            let local = PathBuf::from("phantomdock.toml");
            if local.exists() {
                Some(local)
            } else if let Some(home) = std::env::var_os("HOME") {
                let global = PathBuf::from(home).join(".config/phantomdock/config.toml");
                global.exists().then_some(global)
            } else {
                None
            }
        }
    };

    if let Some(path) = chosen {
        let raw = std::fs::read_to_string(&path).map_err(ConfigError::Io)?;
        apply_file(&mut cfg, &raw)?;
        source = Some(path.display().to_string());
    }

    // Workspace .phantomdockignore always contributes extra globs.
    if Path::new(".phantomdockignore").exists() {
        if let Ok(raw) = std::fs::read_to_string(".phantomdockignore") {
            apply_ignore(&mut cfg, &raw);
        }
    }

    Ok((cfg, source))
}

/// Parse and merge a TOML config body into `cfg` (testable without touching the fs).
pub fn apply_file(cfg: &mut Config, raw: &str) -> Result<(), ConfigError> {
    let parsed: FileConfig = toml::from_str(raw).map_err(|e| ConfigError::Parse(e.to_string()))?;
    if let Some(v) = parsed.max_inline_chars {
        cfg.max_inline_chars = v;
    }
    if let Some(v) = parsed.inline_skill_chunk_chars {
        cfg.inline_skill_chunk_chars = v;
    }
    if let Some(v) = parsed.mcp_tool_timeout_secs {
        cfg.mcp_tool_timeout_secs = v;
    }
    if let Some(v) = parsed.skill_dirs {
        cfg.skill_dirs.extend(v);
    }
    if let Some(s) = parsed.sandbox {
        if let Some(globs) = s.deny_globs {
            // Explicit deny-list replaces the default (per spec: overridable).
            cfg.deny_globs = globs;
        }
    }
    Ok(())
}

/// Merge `.phantomdockignore` body (one glob per line, `#` comments).
pub fn apply_ignore(cfg: &mut Config, raw: &str) {
    for line in raw.lines() {
        let l = line.trim();
        if !l.is_empty() && !l.starts_with('#') {
            cfg.deny_globs.push(l.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec() {
        let c = Config::default();
        assert_eq!(c.max_inline_chars, 16_000);
        assert_eq!(c.inline_skill_chunk_chars, 6_000);
        assert_eq!(c.mcp_tool_timeout_secs, 30);
        assert!(c.deny_globs.contains(&".env".to_string()));
        assert!(c.deny_globs.contains(&".git/**".to_string()));
    }

    #[test]
    fn file_overrides_defaults() {
        let mut c = Config::default();
        let toml = r#"
max_inline_chars = 8000
inline_skill_chunk_chars = 3000
mcp_tool_timeout_secs = 10
skill_dirs = ["/tmp/extra-skills"]

[sandbox]
deny_globs = ["secrets/**"]
"#;
        apply_file(&mut c, toml).unwrap();
        assert_eq!(c.max_inline_chars, 8000);
        assert_eq!(c.inline_skill_chunk_chars, 3000);
        assert_eq!(c.mcp_tool_timeout_secs, 10);
        assert_eq!(c.skill_dirs, vec![PathBuf::from("/tmp/extra-skills")]);
        // Explicit deny list replaces defaults entirely.
        assert_eq!(c.deny_globs, vec!["secrets/**".to_string()]);
    }

    #[test]
    fn ignore_file_appends_globs() {
        let mut c = Config::default();
        let n = c.deny_globs.len();
        apply_ignore(&mut c, "# comment\n\n*.vault\nprivate-*\n");
        assert_eq!(c.deny_globs.len(), n + 2);
        assert!(c.deny_globs.contains(&"*.vault".to_string()));
        assert!(c.deny_globs.contains(&"private-*".to_string()));
    }
}
