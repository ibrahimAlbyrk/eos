//! For the probes (not private): which keys each library reads differently
//! from the `yaml` package. `yaml-probe-diff <reference.json>`; with
//! `--emit <out.json>` also writes what each library serializes, for the
//! `yaml` package to parse.

use serde_json::{Value, json};
use spike_yaml::libs;

fn show(v: Option<&Value>) -> String {
    v.map_or("(absent)".into(), |v| serde_json::to_string(v).unwrap_or_default())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let docs: Vec<Value> = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let emit = args.iter().position(|a| a == "--emit").and_then(|i| args.get(i + 1));
    let mut emitted = Vec::new();
    for lib in libs::all() {
        for d in &docs {
            let kind = d["kind"].as_str().unwrap_or("");
            if kind.ends_with("(split)") || d.get("parsed").is_none() {
                continue;
            }
            let want = &d["parsed"];
            if let Ok(text) = (lib.write)(want) {
                emitted.push(json!({ "lib": lib.name, "kind": kind, "name": d["name"], "text": text, "parsed": want }));
            }
            if kind != "probe" {
                continue;
            }
            match (lib.parse)(d["yaml"].as_str().unwrap_or("")) {
                Err(e) => println!("[{}] {}: refused — {}", lib.name, d["name"], e.lines().next().unwrap_or("")),
                Ok(got) => {
                    let (Some(g), Some(w)) = (got.as_object(), want.as_object()) else { continue };
                    for key in w.keys().chain(g.keys().filter(|k| !w.contains_key(*k))) {
                        let (a, b) = (w.get(key), g.get(key));
                        let equal = match (a, b) {
                            (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
                            _ => a == b,
                        };
                        if !equal {
                            println!(
                                "[{}] {}: key {key:?}: yaml(npm) {} — here {}",
                                lib.name,
                                d["name"],
                                show(a),
                                show(b)
                            );
                        }
                    }
                }
            }
        }
    }
    if let Some(path) = emit {
        std::fs::write(path, serde_json::to_vec(&emitted)?)?;
    }
    Ok(())
}
