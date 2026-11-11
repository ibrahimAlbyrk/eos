//! Reads `{json, stable}` lines (ts/fuzz-stable.ts) and checks that the Rust
//! stable_stringify gives the same text for the same JSON.

use std::io::BufRead;

use serde_json::Value;
use spike_sync::stable::stable_stringify;

fn main() -> anyhow::Result<()> {
    let (mut n, mut bad) = (0u32, 0u32);
    for line in std::io::stdin().lock().lines() {
        let case: Value = serde_json::from_str(&line?)?;
        let (json, expected) = (case["json"].as_str().unwrap_or(""), case["stable"].as_str().unwrap_or(""));
        let got = stable_stringify(&serde_json::from_str(json)?);
        n += 1;
        if got != expected {
            bad += 1;
            if bad <= 5 {
                eprintln!("differs:\n  json     {json}\n  ts       {expected}\n  rust     {got}");
            }
        }
    }
    println!("{{\"cases\":{n},\"different\":{bad}}}");
    anyhow::ensure!(bad == 0, "{bad} of {n} differ");
    Ok(())
}
