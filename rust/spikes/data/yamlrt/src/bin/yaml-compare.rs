//! Compares the candidate YAML libraries with what the `yaml` package did
//! (ts/yaml-reference.ts):
//!
//!   yaml-compare <reference.json> [--details]
//!
//! Per library and kind of file: how many parse to the same data, how many are
//! refused, how many re-serialize to the bytes today's writer wrote, and
//! whether what it writes reads back equal in both worlds. --details names the
//! documents that differ (use it only on files that are not private).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;
use spike_yaml::{libs, split_frontmatter};

#[derive(Deserialize)]
struct Doc {
    kind: String,
    name: String,
    yaml: String,
    body: Option<String>,
    parsed: Option<Value>,
    error: Option<String>,
    written: Option<String>,
}

/// Equal as JavaScript would see them: numbers by value, `1` == `1.0`.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

#[derive(Default)]
struct Tally {
    docs: u32,
    same_data: u32,
    refused: u32,
    different_data: u32,
    writes_same_bytes: u32,
    own_output_reads_back: u32,
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(!args.is_empty(), "usage: yaml-compare <reference.json> [--details]");
    let details = args.iter().any(|a| a == "--details");
    let docs: Vec<Doc> = serde_json::from_slice(&std::fs::read(&args[0])?)?;

    // The frontmatter splitter first: same YAML text, same body.
    let (mut split_total, mut split_same) = (0, 0);
    for d in docs.iter().filter(|d| d.kind.ends_with("(split)")) {
        split_total += 1;
        let got = split_frontmatter(&d.yaml);
        let want_yaml = d.parsed.as_ref().and_then(Value::as_str);
        let ok = match (got, want_yaml) {
            (Some((yaml, body)), Some(w)) => yaml == w && Some(body) == d.body.as_deref(),
            (None, None) => true,
            _ => false,
        };
        if ok {
            split_same += 1;
        } else if details {
            eprintln!("split differs: {} {:?}", d.kind, d.name);
        }
    }
    println!("frontmatter split: {split_same}/{split_total} identical");

    for lib in libs::all() {
        let mut by_kind: BTreeMap<&str, Tally> = BTreeMap::new();
        for d in docs.iter().filter(|d| !d.kind.ends_with("(split)")) {
            let t = by_kind.entry(d.kind.as_str()).or_default();
            t.docs += 1;
            let Some(want) = &d.parsed else {
                // `yaml` itself refused it.
                if (lib.parse)(&d.yaml).is_err() && d.error.is_some() {
                    t.same_data += 1;
                }
                continue;
            };
            match (lib.parse)(&d.yaml) {
                Ok(got) if same(&got, want) => t.same_data += 1,
                Ok(_) => {
                    t.different_data += 1;
                    if details {
                        eprintln!("[{}] different data: {} {:?}", lib.name, d.kind, d.name);
                    }
                }
                Err(e) => {
                    t.refused += 1;
                    if details {
                        eprintln!(
                            "[{}] refused: {} {:?} — {}",
                            lib.name,
                            d.kind,
                            d.name,
                            e.lines().next().unwrap_or("")
                        );
                    }
                }
            }
            // Writing: from the data `yaml` parsed, as a Rust store would hold it.
            if let Ok(text) = (lib.write)(want) {
                if d.written.as_deref().map(str::trim_end) == Some(text.trim_end()) {
                    t.writes_same_bytes += 1;
                } else if details && d.kind == "probe" {
                    eprintln!("[{}] writes other bytes: {:?}", lib.name, d.name);
                }
                if (lib.parse)(&text).is_ok_and(|back| same(&back, want)) {
                    t.own_output_reads_back += 1;
                } else if details {
                    eprintln!("[{}] its own output does not read back equal: {} {:?}", lib.name, d.kind, d.name);
                }
            }
        }
        println!("{}", lib.name);
        for (kind, t) in by_kind {
            println!(
                "  {kind:18} {:3} docs | same data {:3}, different {:2}, refused {:2} | writes today's bytes {:3} | own output reads back {:3}",
                t.docs, t.same_data, t.different_data, t.refused, t.writes_same_bytes, t.own_output_reads_back
            );
        }
    }
    Ok(())
}
