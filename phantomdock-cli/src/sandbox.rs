//! Hardened filesystem sandbox:
//! - Parent-dir jail: every path must canonicalize inside the workspace `cwd`.
//! - Nearest-existing-parent resolution for new files (write_file) with
//!   intermediate-symlink escape detection.
//! - Secret deny-list (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**`, ... plus
//!   user globs from `phantomdock.toml` / `.phantomdockignore`).

use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum SandboxError {
    OutsideWorkspace { path: PathBuf },
    DeniedSecret { path: String, glob: String },
    Io(std::io::Error),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SandboxError::OutsideWorkspace { path } => {
                write!(f, "path '{}' escapes the workspace sandbox", path.display())
            }
            SandboxError::DeniedSecret { path, glob } => {
                write!(f, "path '{path}' matches sensitive deny-list glob '{glob}'")
            }
            SandboxError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for SandboxError {}

impl From<std::io::Error> for SandboxError {
    fn from(e: std::io::Error) -> Self {
        SandboxError::Io(e)
    }
}

pub struct Sandbox {
    /// Canonical workspace root. All access is jailed to this directory.
    pub cwd: PathBuf,
    patterns: Vec<glob::Pattern>,
    raw_globs: Vec<String>,
}

impl Sandbox {
    pub fn new(cwd: PathBuf, deny_globs: Vec<String>) -> Result<Self, SandboxError> {
        let canonical = cwd.canonicalize()?;
        let mut patterns = Vec::new();
        let mut raws = Vec::new();
        for g in deny_globs {
            if let Ok(p) = glob::Pattern::new(&g) {
                patterns.push(p);
                raws.push(g);
            }
        }
        Ok(Self {
            cwd: canonical,
            patterns,
            raw_globs: raws,
        })
    }

    fn absolute(&self, p: &Path) -> PathBuf {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.cwd.join(p)
        }
    }

    /// Resolve + validate a path that must already exist (read/edit/list/search).
    pub fn resolve_existing(&self, p: &Path) -> Result<PathBuf, SandboxError> {
        let target = self.absolute(p);
        let canon = target.canonicalize()?;
        if !canon.starts_with(&self.cwd) {
            return Err(SandboxError::OutsideWorkspace {
                path: p.to_path_buf(),
            });
        }
        self.check_denied(&canon, p)?;
        Ok(canon)
    }

    /// Validate a possibly-not-yet-existing target for writing.
    ///
    /// Walks up to the nearest existing ancestor, canonicalizes it, verifies it is
    /// inside `cwd`, then walks back down component-by-component canonicalizing any
    /// intermediate symlinks so escapes are rejected before the write happens.
    pub fn resolve_for_write(&self, p: &Path) -> Result<PathBuf, SandboxError> {
        let target = self.absolute(p);
        let mut ancestor = target.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while !ancestor.exists() {
            match (ancestor.parent(), ancestor.file_name()) {
                (Some(parent), Some(name)) if parent != ancestor => {
                    tail.push(name.to_os_string());
                    ancestor = parent.to_path_buf();
                }
                _ => {
                    return Err(SandboxError::OutsideWorkspace {
                        path: p.to_path_buf(),
                    });
                }
            }
        }
        let mut cur = ancestor.canonicalize()?;
        if !cur.starts_with(&self.cwd) {
            return Err(SandboxError::OutsideWorkspace {
                path: p.to_path_buf(),
            });
        }
        for name in tail.iter().rev() {
            cur = cur.join(name);
            if cur.exists() {
                cur = cur.canonicalize()?;
                if !cur.starts_with(&self.cwd) {
                    return Err(SandboxError::OutsideWorkspace {
                        path: p.to_path_buf(),
                    });
                }
            }
        }
        self.check_denied(&cur, p)?;
        Ok(cur)
    }

    /// Non-throwing deny check (used by list_dir/search_files to skip secrets).
    pub fn denied_glob_for(&self, canonical: &Path) -> Option<String> {
        let rel = canonical.strip_prefix(&self.cwd).ok()?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let basename = rel
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();

        // Candidate strings: the relative path itself, every ancestor dir,
        // every ancestor's `dir/**` form, and the basename.
        let mut candidates: Vec<String> = vec![rel_str.clone()];
        let mut acc = String::new();
        for comp in rel.components() {
            if let Component::Normal(c) = comp {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(&c.to_string_lossy());
                candidates.push(acc.clone());
                candidates.push(format!("{acc}/**"));
            }
        }

        for (pat, raw) in self.patterns.iter().zip(self.raw_globs.iter()) {
            if pat.matches(&basename) && !basename.is_empty() {
                return Some(raw.clone());
            }
            for cand in &candidates {
                if pat.matches(cand) {
                    return Some(raw.clone());
                }
            }
        }
        None
    }

    fn check_denied(&self, canonical: &Path, display: &Path) -> Result<(), SandboxError> {
        if let Some(glob) = self.denied_glob_for(canonical) {
            return Err(SandboxError::DeniedSecret {
                path: display.display().to_string(),
                glob,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sandbox_in(tmp: &TempDir) -> Sandbox {
        Sandbox::new(
            tmp.path().to_path_buf(),
            DEFAULT_TEST_GLOBS.iter().map(|s| s.to_string()).collect(),
        )
        .unwrap()
    }

    const DEFAULT_TEST_GLOBS: &[&str] = &[".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".git/**"];

    #[test]
    fn existing_paths_inside_cwd_resolve() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("notes.txt"), "hi").unwrap();
        fs::create_dir_all(tmp.path().join("sub")).unwrap();
        let sb = sandbox_in(&tmp);
        let p = sb.resolve_existing(Path::new("notes.txt")).unwrap();
        assert!(p.starts_with(sb.cwd.canonicalize().unwrap()));
        // Relative traversal that stays inside is fine.
        assert!(sb.resolve_existing(Path::new("./sub/../notes.txt")).is_ok());
    }

    #[test]
    fn escape_via_dotdot_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let sb = sandbox_in(&tmp);
        let err = sb
            .resolve_existing(Path::new("../../../etc/passwd"))
            .unwrap_err();
        assert!(matches!(err, SandboxError::OutsideWorkspace { .. }));
    }

    #[test]
    fn absolute_path_outside_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let sb = sandbox_in(&tmp);
        assert!(matches!(
            sb.resolve_existing(Path::new("/etc/passwd")),
            Err(SandboxError::OutsideWorkspace { .. })
        ));
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("evil.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
        #[cfg(unix)]
        {
            let sb = sandbox_in(&tmp);
            assert!(matches!(
                sb.resolve_existing(Path::new("link/evil.txt")),
                Err(SandboxError::OutsideWorkspace { .. })
            ));
            // Writing through a symlink that escapes must be rejected too.
            assert!(matches!(
                sb.resolve_for_write(Path::new("link/newfile.txt")),
                Err(SandboxError::OutsideWorkspace { .. })
            ));
        }
    }

    #[test]
    fn write_into_new_nested_dirs_is_allowed() {
        let tmp = TempDir::new().unwrap();
        let sb = sandbox_in(&tmp);
        let p = sb
            .resolve_for_write(Path::new("src/deep/new/file.txt"))
            .unwrap();
        assert!(p.starts_with(&sb.cwd));
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, "ok").unwrap();
        assert!(sb
            .resolve_existing(Path::new("src/deep/new/file.txt"))
            .is_ok());
    }

    #[test]
    fn deny_list_blocks_secrets() {
        let tmp = TempDir::new().unwrap();
        for name in [
            ".env",
            ".env.production",
            "server.pem",
            "id_rsa",
            "id_rsa.pub",
        ] {
            fs::write(tmp.path().join(name), "secret").unwrap();
        }
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git/config"), "cfg").unwrap();
        fs::write(tmp.path().join("README.md"), "public").unwrap();

        let sb = sandbox_in(&tmp);
        for name in [
            ".env",
            ".env.production",
            "server.pem",
            "id_rsa",
            "id_rsa.pub",
            ".git/config",
        ] {
            let err = sb.resolve_existing(Path::new(name)).unwrap_err();
            assert!(
                matches!(err, SandboxError::DeniedSecret { .. }),
                "{name} should be denied"
            );
        }
        // Nested secrets are caught via basename matching.
        fs::create_dir_all(tmp.path().join("config")).unwrap();
        fs::write(tmp.path().join("config/.env"), "s").unwrap();
        assert!(matches!(
            sb.resolve_existing(Path::new("config/.env")),
            Err(SandboxError::DeniedSecret { .. })
        ));
        // .git directory itself (for list_dir) is denied via ancestor matching.
        assert!(matches!(
            sb.resolve_existing(Path::new(".git")),
            Err(SandboxError::DeniedSecret { .. })
        ));
        // Public files are fine.
        assert!(sb.resolve_existing(Path::new("README.md")).is_ok());
        // Writing a secret path is blocked as well.
        assert!(matches!(
            sb.resolve_for_write(Path::new("newdir/.env")),
            Err(SandboxError::DeniedSecret { .. })
        ));
    }
}
