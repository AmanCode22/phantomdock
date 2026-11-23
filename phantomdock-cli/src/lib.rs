//! PhantomDock daemon library crate. The `pdock` binary (src/main.rs) is a thin
//! CLI wrapper around these modules.

pub mod config;
pub mod mcp;
pub mod offload;
pub mod sandbox;
pub mod server;
pub mod skills;
pub mod tools;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: u32 = 2;
pub const PORT_MIN: u16 = 47800;
pub const PORT_MAX: u16 = 47820;
