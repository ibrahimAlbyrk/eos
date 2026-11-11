//! Runs every candidate engine over a pattern set and compares with what Node
//! did (ts/regex-expected.ts).
//!
//!   regex-compare <cases.json> <expected.json> [--details]
//!
//! Prints counts per engine; with --details also the patterns that differ
//! (pass it only for sets that are not private).

use std::{panic, time::Instant};

use serde_json::{Value, json};
use spike_jsregex::{
    compare::{Cases, parse_expected, run},
    engines,
};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() >= 2, "usage: regex-compare <cases.json> <expected.json> [--details]");
    let details = args.iter().any(|a| a == "--details");
    let cases: Cases = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let expected = parse_expected(&std::fs::read_to_string(&args[1])?)?;
    let inputs: Vec<String> = match &cases.inputs {
        Some(i) => i.clone(),
        None => {
            let probes: Value = serde_json::from_slice(&std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/regex/probes.json"),
            )?)?;
            serde_json::from_value(probes["inputs"].clone())?
        }
    };

    panic::set_hook(Box::new(|_| {}));
    let mut table = Vec::new();
    for engine in engines::all() {
        let started = Instant::now();
        let rep = run(engine.as_ref(), &cases.patterns, &expected, &inputs);
        table.push(json!({
            "engine": engine.name(), "patterns": rep.patterns, "identical": rep.identical,
            "compileDisagreement": rep.compile_disagreement, "matchDisagreement": rep.match_disagreement,
            "inputsCompared": rep.inputs_compared, "inputsIdentical": rep.inputs_identical, "runtimeErrors": rep.runtime_errors,
            "ms": (started.elapsed().as_secs_f64() * 1000.0).round(),
        }));
        if details {
            eprintln!("\n== {} ==", engine.name());
            for n in &rep.notes {
                eprintln!("  {n}");
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&table)?);
    Ok(())
}
