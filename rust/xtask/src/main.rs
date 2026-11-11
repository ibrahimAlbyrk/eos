//! `cargo xtask layers` fails when a crate depends on a crate in the same or
//! a higher layer. Every workspace crate must be listed in `LAYERS`, so a new
//! crate cannot skip the rule by accident.
//!
//! `cargo xtask contracts [out dir]` writes what clients outside Rust take from
//! `eos-contracts`: the JSON Schema bundle, the route table and the dashboard's
//! route file (default `target/generated/contracts`).

mod contracts;
mod layers;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("layers") => layers::check(),
        Some("contracts") => contracts::export(args.get(1).map(std::path::PathBuf::from)),
        _ => {
            eprintln!("usage: cargo xtask <layers | contracts [out dir]>");
            std::process::exit(2);
        }
    }
}
