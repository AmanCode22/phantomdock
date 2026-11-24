use clap::{Parser, Subcommand};
use phantomdock_cli::config;
use phantomdock_cli::mcp::{self, Manager as McpManager};
use phantomdock_cli::sandbox::Sandbox;
use phantomdock_cli::server::{self, AppState};
use phantomdock_cli::skills::{self, SkillsIndex};
use phantomdock_cli::tools::Registry;
use phantomdock_cli::{PORT_MAX, PORT_MIN, PROTOCOL_VERSION, VERSION};
use rand::RngCore;
use sha2::{Digest, Sha256};

use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(
    name = "pdock",
    version = VERSION,
    about = "PhantomDock daemon — hardened localhost bridge for agentic web-AI automation"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Force a specific port (default: auto-select within 47800-47820)
    #[arg(long)]
    port: Option<u16>,
    /// Enable the run_shell tool (still gated behind manual approval in the extension)
    #[arg(long)]
    allow_shell: bool,
    /// Explicit config file (default: ./phantomdock.toml or ~/.pdock/config.toml)
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    /// Explicit mcp.json path (in addition to auto-discovered agent MCP configs)
    #[arg(long, value_name = "PATH")]
    mcp: Option<PathBuf>,
    /// Extra skills directory (repeatable)
    #[arg(long = "skills-dir", value_name = "DIR")]
    skills_dirs: Vec<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// View or modify ~/.pdock/config.toml
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
    },
}

#[derive(Subcommand, Debug)]
enum ConfigAction {
    /// Print the active config file path and current TOML contents
    Show,
    /// Print the path to ~/.pdock/config.toml
    Path,
    /// Create ~/.pdock/config.toml with defaults if it does not exist
    Init {
        /// Overwrite an existing config file with defaults
        #[arg(long)]
        force: bool,
    },
    /// Read a single config key (e.g. max_inline_chars, skill_dirs, mcp_dirs)
    Get { key: String },
    /// Set a config key in ~/.pdock/config.toml
    Set { key: String, value: String },
    /// Add a custom skills directory to skill_dirs
    AddSkillDir { dir: PathBuf },
    /// Remove a directory from skill_dirs
    RemoveSkillDir { dir: PathBuf },
    /// Add a custom directory of MCP JSON files to mcp_dirs
    AddMcpDir { dir: PathBuf },
    /// Remove a directory from mcp_dirs
    RemoveMcpDir { dir: PathBuf },
    /// Add a custom MCP JSON file path to mcp_configs
    AddMcpConfig { file: PathBuf },
    /// Remove a file path from mcp_configs
    RemoveMcpConfig { file: PathBuf },
    /// Add a glob pattern to sandbox.deny_globs
    AddDenyGlob { glob: String },
    /// Remove a glob pattern from sandbox.deny_globs
    RemoveDenyGlob { glob: String },
    /// Open ~/.pdock/config.toml in $VISUAL or $EDITOR
    Edit,
}

fn target_config_path(explicit: Option<&PathBuf>) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(p) = explicit {
        return Ok(config::expand_tilde(p));
    }
    config::global_config_path()
        .ok_or_else(|| "could not determine home directory for ~/.pdock/config.toml".into())
}

fn run_config_command(
    action: Option<ConfigAction>,
    explicit: Option<&PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = target_config_path(explicit)?;
    let action = action.unwrap_or(ConfigAction::Show);

    match action {
        ConfigAction::Path => {
            println!("{}", path.display());
        }
        ConfigAction::Show => {
            let cfg = config::load_file_or_default(&path)?;
            println!(
                "# File: {} ({})\n",
                path.display(),
                if path.exists() {
                    "exists"
                } else {
                    "not created yet — using defaults"
                }
            );
            print!("{}", config::render_toml(&cfg));
        }
        ConfigAction::Init { force } => {
            if path.exists() && !force {
                println!(
                    "Config already exists at {} (pass --force to reset).",
                    path.display()
                );
                return Ok(());
            }
            config::save(&path, &config::Config::default())?;
            println!("Initialized {}", path.display());
        }
        ConfigAction::Get { key } => {
            let cfg = config::load_file_or_default(&path)?;
            let val = config::get_key(&cfg, &key)?;
            println!("{val}");
        }
        ConfigAction::Set { key, value } => {
            let mut cfg = config::load_file_or_default(&path)?;
            config::set_key(&mut cfg, &key, &value)?;
            config::save(&path, &cfg)?;
            println!("Updated {key} in {}", path.display());
        }
        ConfigAction::AddSkillDir { dir } => {
            let mut cfg = config::load_file_or_default(&path)?;
            if !cfg.skill_dirs.contains(&dir) {
                cfg.skill_dirs.push(dir.clone());
                config::save(&path, &cfg)?;
                println!("Added skill_dir '{}' to {}", dir.display(), path.display());
            } else {
                println!("skill_dir '{}' already configured", dir.display());
            }
        }
        ConfigAction::RemoveSkillDir { dir } => {
            let mut cfg = config::load_file_or_default(&path)?;
            let before = cfg.skill_dirs.len();
            cfg.skill_dirs.retain(|d| d != &dir);
            if cfg.skill_dirs.len() < before {
                config::save(&path, &cfg)?;
                println!("Removed skill_dir '{}' from {}", dir.display(), path.display());
            } else {
                println!("skill_dir '{}' was not in {}", dir.display(), path.display());
            }
        }
        ConfigAction::AddMcpDir { dir } => {
            let mut cfg = config::load_file_or_default(&path)?;
            if !cfg.mcp_dirs.contains(&dir) {
                cfg.mcp_dirs.push(dir.clone());
                config::save(&path, &cfg)?;
                println!("Added mcp_dir '{}' to {}", dir.display(), path.display());
            } else {
                println!("mcp_dir '{}' already configured", dir.display());
            }
        }
        ConfigAction::RemoveMcpDir { dir } => {
            let mut cfg = config::load_file_or_default(&path)?;
            let before = cfg.mcp_dirs.len();
            cfg.mcp_dirs.retain(|d| d != &dir);
            if cfg.mcp_dirs.len() < before {
                config::save(&path, &cfg)?;
                println!("Removed mcp_dir '{}' from {}", dir.display(), path.display());
            } else {
                println!("mcp_dir '{}' was not in {}", dir.display(), path.display());
            }
        }
        ConfigAction::AddMcpConfig { file } => {
            let mut cfg = config::load_file_or_default(&path)?;
            if !cfg.mcp_configs.contains(&file) {
                cfg.mcp_configs.push(file.clone());
                config::save(&path, &cfg)?;
                println!("Added mcp_config '{}' to {}", file.display(), path.display());
            } else {
                println!("mcp_config '{}' already configured", file.display());
            }
        }
        ConfigAction::RemoveMcpConfig { file } => {
            let mut cfg = config::load_file_or_default(&path)?;
            let before = cfg.mcp_configs.len();
            cfg.mcp_configs.retain(|f| f != &file);
            if cfg.mcp_configs.len() < before {
                config::save(&path, &cfg)?;
                println!(
                    "Removed mcp_config '{}' from {}",
                    file.display(),
                    path.display()
                );
            } else {
                println!(
                    "mcp_config '{}' was not in {}",
                    file.display(),
                    path.display()
                );
            }
        }
        ConfigAction::AddDenyGlob { glob } => {
            let mut cfg = config::load_file_or_default(&path)?;
            if !cfg.deny_globs.contains(&glob) {
                cfg.deny_globs.push(glob.clone());
                config::save(&path, &cfg)?;
                println!("Added deny_glob '{glob}' to {}", path.display());
            } else {
                println!("deny_glob '{glob}' already configured");
            }
        }
        ConfigAction::RemoveDenyGlob { glob } => {
            let mut cfg = config::load_file_or_default(&path)?;
            let before = cfg.deny_globs.len();
            cfg.deny_globs.retain(|g| g != &glob);
            if cfg.deny_globs.len() < before {
                config::save(&path, &cfg)?;
                println!("Removed deny_glob '{glob}' from {}", path.display());
            } else {
                println!("deny_glob '{glob}' was not in {}", path.display());
            }
        }
        ConfigAction::Edit => {
            if !path.exists() {
                config::save(&path, &config::Config::default())?;
            }
            let editor = std::env::var("VISUAL")
                .or_else(|_| std::env::var("EDITOR"))
                .unwrap_or_else(|_| "vi".to_string());
            let status = std::process::Command::new(&editor).arg(&path).status()?;
            if !status.success() {
                return Err(format!("editor '{editor}' exited with status {status}").into());
            }
        }
    }
    Ok(())
}

/// Generate a one-time 256-bit pairing token.
/// Returns (hex display form, sha256 of the display form) — only the hash is kept in state.
fn generate_token() -> (String, [u8; 32]) {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let display = hex::encode(raw);
    let mut hasher = Sha256::new();
    hasher.update(display.as_bytes());
    let hash: [u8; 32] = hasher.finalize().into();
    (display, hash)
}

async fn select_listener(port: Option<u16>) -> std::io::Result<tokio::net::TcpListener> {
    match port {
        Some(p) => tokio::net::TcpListener::bind(("127.0.0.1", p)).await,
        None => {
            let mut last: Option<std::io::Error> = None;
            for p in PORT_MIN..=PORT_MAX {
                match tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                    Ok(l) => return Ok(l),
                    Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => last = Some(e),
                    Err(e) => return Err(e),
                }
            }
            Err(last.unwrap_or_else(|| std::io::Error::other("no free port in 47800-47820 range")))
        }
    }
}

fn print_banner(
    cwd: &std::path::Path,
    port: u16,
    shell_enabled: bool,
    skills: &SkillsIndex,
    mcp: &McpManager,
    token: &str,
    config_source: Option<&str>,
) {
    let mcp_line = if mcp.is_empty() {
        "none (no MCP configs found)".to_string()
    } else {
        mcp.statuses()
            .iter()
            .map(|s| format!("{}: {}", s.name, s.status))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let skill_names: Vec<&str> = skills.skills.iter().map(|s| s.name.as_str()).collect();
    let skills_line = if skill_names.is_empty() {
        "0 discovered".to_string()
    } else {
        format!(
            "{} discovered [{}]",
            skill_names.len(),
            skill_names.join(", ")
        )
    };
    println!("┌──────────────────────────────────────────────────────────────┐");
    println!("│  PhantomDock daemon v{VERSION}  —  protocol v{PROTOCOL_VERSION}            │");
    println!("└──────────────────────────────────────────────────────────────┘");
    println!("  Workspace : {}", cwd.display());
    println!("  Listening : http://127.0.0.1:{port}   (localhost only)");
    println!(
        "  Shell     : {}",
        if shell_enabled {
            "ENABLED (--allow-shell) — run_shell awaits manual approval"
        } else {
            "disabled (launch with --allow-shell to enable run_shell)"
        }
    );
    println!("  Skills    : {skills_line}");
    println!("  MCP       : {mcp_line}");
    println!(
        "  Config    : {}",
        config_source.unwrap_or("built-in defaults (run `pdock config init` to create ~/.pdock/config.toml)")
    );
    println!("───────────────────────────────────────────────────────────────");
    println!("  Pairing token (shown ONCE — paste it into the PhantomDock popup):");
    println!();
    println!("    {token}");
    println!();
    println!("  Open the PhantomDock extension popup on a web-AI tab, pick this");
    println!("  workspace, paste the token, and bind the tab. The token never");
    println!("  leaves localhost and is never exposed via /handshake.");
    println!("───────────────────────────────────────────────────────────────");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    if let Some(Commands::Config { action }) = cli.command {
        return run_config_command(action, cli.config.as_ref());
    }

    let cwd = std::env::current_dir()?;
    let cwd = cwd.canonicalize().unwrap_or(cwd);

    let (mut config, config_source) = config::load(cli.config.as_deref())?;
    for d in &cli.skills_dirs {
        config.skill_dirs.push(d.clone());
    }

    let skills = Arc::new(skills::discover(&config.skill_dirs));
    let sandbox = Arc::new(Sandbox::new(cwd.clone(), config.deny_globs.clone())?);

    let mcp_paths = mcp::discover_config_paths(
        &cwd,
        cli.mcp.as_deref(),
        &config.mcp_configs,
        &config.mcp_dirs,
    );
    let mcp = Arc::new(McpManager::start_multi(&mcp_paths, Some(&cwd)).await);

    let (token_display, token_hash) = generate_token();
    let shell_enabled = cli.allow_shell;

    let listener = select_listener(cli.port).await?;
    let port = listener.local_addr()?.port();

    print_banner(
        &cwd,
        port,
        shell_enabled,
        &skills,
        &mcp,
        &token_display,
        config_source.as_deref(),
    );

    let state = Arc::new(AppState {
        cwd: cwd.clone(),
        pid: std::process::id(),
        port,
        shell_enabled,
        token_hash,
        config: config.clone(),
        sandbox: sandbox.clone(),
        skills: skills.clone(),
        mcp: mcp.clone(),
        registry: Arc::new(Registry::new()),
    });

    let app = server::build_router(state);
    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    println!("\n[pdock] shutdown complete.");
    Ok(())
}
