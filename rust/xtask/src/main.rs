//! Repo checks and generators:
//!
//! - `cargo xtask layers` fails when a crate depends on a crate in the same or a higher
//!   layer. Every workspace crate must be listed in `LAYERS`, so a new crate cannot skip
//!   the rule by accident.
//! - `cargo xtask shell` checks the window shell's rules (see `shell.rs`).
//! - `cargo xtask contracts [out dir]` writes what clients outside Rust take from
//!   `eos-contracts`: the JSON Schema bundle, the route table and the dashboard's route
//!   file (default `target/generated/contracts`).
//! - `cargo xtask publish-update <version> --app <Eos.app> …` builds a release of the in-app
//!   update feed into a folder; it uploads nothing (see `publish.rs`).

mod contracts;
mod layers;
mod publish;
mod shell;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("layers") => layers::check(),
        Some("shell") => shell::check(),
        Some("contracts") => contracts::export(args.get(1).map(std::path::PathBuf::from)),
        Some("publish-update") => publish::run(&args[1..]),
        _ => {
            eprintln!("usage: cargo xtask <layers | shell | contracts [out dir] | publish-update …>");
            std::process::exit(2);
        }
    }
}
