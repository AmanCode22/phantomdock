use clap::Parser;
use phantomdock_cli::config;
use phantomdock_cli::mcp::Manager as McpManager;
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
    /// Force a specific port (default: auto-select within 47800-47820)
    #[arg(long)]
    port: Option<u16>,
    /// Enable the run_shell tool (still gated behind manual approval in the extension)
    #[arg(long)]
    allow_shell: bool,
    /// Explicit config file (default: ./phantomdock.toml or ~/.config/phantomdock/config.toml)
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,
    /// Explicit mcp.json path (default: ./mcp.json if present)
    #[arg(long, value_name = "PATH")]
    mcp: Option<PathBuf>,
    /// Extra skills directory (repeatable)
    #[arg(long = "skills-dir", value_name = "DIR")]
    skills_dirs: Vec<PathBuf>,
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
            Err(last.unwrap_or_else(|| {
                std::io::Error::other("no free port in 47800-47820 range")
            }))
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
        "none (no mcp.json found)".to_string()
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
        config_source.unwrap_or("built-in defaults")
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

    let cwd = std::env::current_dir()?;
    let cwd = cwd.canonicalize().unwrap_or(cwd);

    let (mut config, config_source) = config::load(cli.config.as_deref())?;
    for d in &cli.skills_dirs {
        config.skill_dirs.push(d.clone());
    }

    let skills = Arc::new(skills::discover(&config.skill_dirs));
    let sandbox = Arc::new(Sandbox::new(cwd.clone(), config.deny_globs.clone())?);

    let mcp_path = cli
        .mcp
        .clone()
        .or_else(|| cwd.join("mcp.json").exists().then(|| cwd.join("mcp.json")));
    let mcp = Arc::new(McpManager::start(mcp_path.as_deref()).await);

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
