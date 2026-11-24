//! Configuration loading & management: defaults ← config file ← CLI overrides.
//!
//! Config file search order (first found wins):
//!   1. explicit `--config PATH`
//!   2. `./phantomdock.toml` (workspace)
//!   3. `~/.pdock/config.toml` (primary global config, managed by `pdock config`)
//!   4. `~/.config/phantomdock/config.toml` (legacy global fallback)
//!
//! A workspace `.phantomdockignore` file always contributes extra deny globs.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

pub const DEFAULT_DENY_GLOBS: &[&str] = &[".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".git/**"];

#[derive(Debug, Clone)]
pub struct Config {
    pub max_inline_chars: usize,
    pub inline_skill_chunk_chars: usize,
    pub mcp_tool_timeout_secs: u64,
    pub skill_dirs: Vec<PathBuf>,
    pub mcp_configs: Vec<PathBuf>,
    pub mcp_dirs: Vec<PathBuf>,
    pub deny_globs: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_inline_chars: 16_000,
            inline_skill_chunk_chars: 6_000,
            mcp_tool_timeout_secs: 30,
            skill_dirs: Vec::new(),
            mcp_configs: Vec::new(),
            mcp_dirs: Vec::new(),
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
    mcp_configs: Option<Vec<PathBuf>>,
    mcp_dirs: Option<Vec<PathBuf>>,
    sandbox: Option<FileSandbox>,
}

#[derive(Deserialize, Default)]
struct FileSandbox {
    deny_globs: Option<Vec<String>>,
}

#[derive(Serialize)]
struct SerializedConfig {
    max_inline_chars: usize,
    inline_skill_chunk_chars: usize,
    mcp_tool_timeout_secs: u64,
    skill_dirs: Vec<String>,
    mcp_configs: Vec<String>,
    mcp_dirs: Vec<String>,
    sandbox: SerializedSandbox,
}

#[derive(Serialize)]
struct SerializedSandbox {
    deny_globs: Vec<String>,
}

/// Resolve the user's home directory across Unix (`HOME`) and Windows (`USERPROFILE`).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Primary global configuration path: `~/.pdock/config.toml`.
pub fn global_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".pdock").join("config.toml"))
}

/// Legacy global configuration path: `~/.config/phantomdock/config.toml`.
pub fn legacy_global_config_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".config").join("phantomdock").join("config.toml"))
}

/// Expand leading `~` or `~/...` against the user's home directory.
pub fn expand_tilde(path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path.to_path_buf();
    };
    if s == "~" {
        return home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// Load configuration. Returns the merged config plus a human-readable source label.
pub fn load(explicit: Option<&Path>) -> Result<(Config, Option<String>), ConfigError> {
    let mut cfg = Config::default();
    let mut source: Option<String> = None;

    let chosen: Option<PathBuf> = match explicit {
        Some(p) => Some(expand_tilde(p)),
        None => {
            let local = PathBuf::from("phantomdock.toml");
            if local.exists() {
                Some(local)
            } else if let Some(global) = global_config_path().filter(|p| p.exists()) {
                Some(global)
            } else {
                legacy_global_config_path().filter(|p| p.exists())
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

/// Load a specific TOML config file if it exists, or return defaults if absent.
pub fn load_file_or_default(path: &Path) -> Result<Config, ConfigError> {
    let mut cfg = Config::default();
    if path.exists() {
        let raw = std::fs::read_to_string(path).map_err(ConfigError::Io)?;
        apply_file(&mut cfg, &raw)?;
    }
    Ok(cfg)
}

/// Render `cfg` as clean, human-readable TOML.
pub fn render_toml(cfg: &Config) -> String {
    let ser = SerializedConfig {
        max_inline_chars: cfg.max_inline_chars,
        inline_skill_chunk_chars: cfg.inline_skill_chunk_chars,
        mcp_tool_timeout_secs: cfg.mcp_tool_timeout_secs,
        skill_dirs: cfg
            .skill_dirs
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        mcp_configs: cfg
            .mcp_configs
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        mcp_dirs: cfg
            .mcp_dirs
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        sandbox: SerializedSandbox {
            deny_globs: cfg.deny_globs.clone(),
        },
    };
    let body = toml::to_string_pretty(&ser).unwrap_or_default();
    format!("# PhantomDock configuration (~/.pdock/config.toml)\n# Manage with `pdock config --help`\n\n{body}")
}

/// Write `cfg` to `path`, creating parent directories (e.g. `~/.pdock`) if needed.
pub fn save(path: &Path, cfg: &Config) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(ConfigError::Io)?;
        }
    }
    std::fs::write(path, render_toml(cfg)).map_err(ConfigError::Io)
}

/// Read a single configuration key as a display string (for `pdock config get`).
pub fn get_key(cfg: &Config, key: &str) -> Result<String, String> {
    match key {
        "max_inline_chars" => Ok(cfg.max_inline_chars.to_string()),
        "inline_skill_chunk_chars" => Ok(cfg.inline_skill_chunk_chars.to_string()),
        "mcp_tool_timeout_secs" => Ok(cfg.mcp_tool_timeout_secs.to_string()),
        "skill_dirs" => Ok(format_path_list(&cfg.skill_dirs)),
        "mcp_configs" => Ok(format_path_list(&cfg.mcp_configs)),
        "mcp_dirs" => Ok(format_path_list(&cfg.mcp_dirs)),
        "deny_globs" | "sandbox.deny_globs" => Ok(cfg.deny_globs.join(", ")),
        other => Err(format!(
            "unknown config key '{other}' (valid keys: max_inline_chars, \
             inline_skill_chunk_chars, mcp_tool_timeout_secs, skill_dirs, \
             mcp_configs, mcp_dirs, sandbox.deny_globs)"
        )),
    }
}

/// Set a scalar configuration key (for `pdock config set`).
pub fn set_key(cfg: &mut Config, key: &str, value: &str) -> Result<(), String> {
    match key {
        "max_inline_chars" => {
            cfg.max_inline_chars = value
                .parse::<usize>()
                .map_err(|_| format!("invalid integer for max_inline_chars: '{value}'"))?;
            Ok(())
        }
        "inline_skill_chunk_chars" => {
            cfg.inline_skill_chunk_chars = value
                .parse::<usize>()
                .map_err(|_| format!("invalid integer for inline_skill_chunk_chars: '{value}'"))?;
            Ok(())
        }
        "mcp_tool_timeout_secs" => {
            cfg.mcp_tool_timeout_secs = value
                .parse::<u64>()
                .map_err(|_| format!("invalid integer for mcp_tool_timeout_secs: '{value}'"))?;
            Ok(())
        }
        "skill_dirs" => {
            cfg.skill_dirs = split_csv_paths(value);
            Ok(())
        }
        "mcp_configs" => {
            cfg.mcp_configs = split_csv_paths(value);
            Ok(())
        }
        "mcp_dirs" => {
            cfg.mcp_dirs = split_csv_paths(value);
            Ok(())
        }
        "deny_globs" | "sandbox.deny_globs" => {
            cfg.deny_globs = value
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(())
        }
        other => Err(format!(
            "unknown config key '{other}' (valid keys: max_inline_chars, \
             inline_skill_chunk_chars, mcp_tool_timeout_secs, skill_dirs, \
             mcp_configs, mcp_dirs, sandbox.deny_globs)"
        )),
    }
}

fn format_path_list(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn split_csv_paths(value: &str) -> Vec<PathBuf> {
    value
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
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
    if let Some(v) = parsed.mcp_configs {
        cfg.mcp_configs.extend(v);
    }
    if let Some(v) = parsed.mcp_dirs {
        cfg.mcp_dirs.extend(v);
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
    use tempfile::TempDir;

    #[test]
    fn defaults_match_spec() {
        let c = Config::default();
        assert_eq!(c.max_inline_chars, 16_000);
        assert_eq!(c.inline_skill_chunk_chars, 6_000);
        assert_eq!(c.mcp_tool_timeout_secs, 30);
        assert!(c.mcp_configs.is_empty());
        assert!(c.mcp_dirs.is_empty());
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
mcp_configs = ["~/custom-mcp.json"]
mcp_dirs = ["/tmp/mcp-dir"]

[sandbox]
deny_globs = ["secrets/**"]
"#;
        apply_file(&mut c, toml).unwrap();
        assert_eq!(c.max_inline_chars, 8000);
        assert_eq!(c.inline_skill_chunk_chars, 3000);
        assert_eq!(c.mcp_tool_timeout_secs, 10);
        assert_eq!(c.skill_dirs, vec![PathBuf::from("/tmp/extra-skills")]);
        assert_eq!(c.mcp_configs, vec![PathBuf::from("~/custom-mcp.json")]);
        assert_eq!(c.mcp_dirs, vec![PathBuf::from("/tmp/mcp-dir")]);
        // Explicit deny list replaces defaults entirely.
        assert_eq!(c.deny_globs, vec!["secrets/**".to_string()]);
    }

    #[test]
    fn save_and_reload_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".pdock").join("config.toml");
        let mut c = Config::default();
        set_key(&mut c, "max_inline_chars", "24000").unwrap();
        c.skill_dirs.push(PathBuf::from("~/my-skills"));
        c.mcp_dirs.push(PathBuf::from("~/my-mcps"));
        save(&path, &c).unwrap();

        let reloaded = load_file_or_default(&path).unwrap();
        assert_eq!(reloaded.max_inline_chars, 24_000);
        assert_eq!(reloaded.skill_dirs, vec![PathBuf::from("~/my-skills")]);
        assert_eq!(reloaded.mcp_dirs, vec![PathBuf::from("~/my-mcps")]);
        assert_eq!(get_key(&reloaded, "max_inline_chars").unwrap(), "24000");
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
