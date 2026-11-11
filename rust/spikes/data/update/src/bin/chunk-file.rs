//! Prints `{"sha256", "lengths", "ids"}` for a file, for comparison with
//! ts/chunk-file.ts on inputs too large or too local to keep as fixtures.

use anyhow::Context;
use serde_json::json;
use spike_update::chunker::scan;

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).context("usage: chunk-file <path>")?;
    let data = std::fs::read(&path)?;
    let (sha256, chunks) = scan(&data);
    let lengths: Vec<usize> = chunks.iter().map(|c| c.size).collect();
    let ids: Vec<&str> = chunks.iter().map(|c| c.id.as_str()).collect();
    println!("{}", json!({ "sha256": sha256, "lengths": lengths, "ids": ids }));
    Ok(())
}
