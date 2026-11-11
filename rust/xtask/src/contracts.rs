//! What clients outside Rust take from `eos-contracts`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Context;
use eos_contracts::routes::{ROUTES, Route};
use serde_json::{Value, json};

/// Writes `schema.json`, `routes.json` and `routes.js` into `out` (default
/// `target/generated/contracts`). The dashboard's checked-in
/// `app/ui/src/api/routes.js` is not touched: a test compares the two.
pub(crate) fn export(out: Option<PathBuf>) -> anyhow::Result<()> {
    let out = out.unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/generated/contracts"));
    std::fs::create_dir_all(&out).with_context(|| format!("creating {}", out.display()))?;
    let pretty = |v: &Value| serde_json::to_string_pretty(v).map(|s| s + "\n");
    std::fs::write(out.join("schema.json"), pretty(&eos_contracts::schema::json_schema_bundle())?)?;
    std::fs::write(out.join("routes.json"), pretty(&routes_json())?)?;
    std::fs::write(out.join("routes.js"), routes_js())?;
    println!("contracts written to {}", out.display());
    Ok(())
}

fn routes_json() -> Value {
    ROUTES
        .iter()
        .map(|r| {
            json!({
                "name": r.name,
                "path": r.path,
                "params": r.params().collect::<Vec<_>>(),
                "methods": r.methods,
                "encoded": r.encoded,
                "prefix": r.prefix,
            })
        })
        .collect()
}

/// `app/ui/src/api/routes.js`: a string per fixed path, a function per path
/// with parameters.
fn routes_js() -> String {
    let mut out = String::from(
        "// The daemon's route table: the single place URLs live in the frontend.\n\
         // Written by `cargo xtask contracts` from rust/crates/eos-contracts/src/routes. Do not edit.\n\n\
         export const ROUTES = {\n",
    );
    for route in ROUTES {
        let _ = writeln!(out, "  {}: {},", route.name, js_value(route));
    }
    out.push_str("};\n");
    out
}

fn js_value(route: &Route) -> String {
    let params: Vec<_> = route.params().collect();
    if params.is_empty() {
        return format!("\"{}\"", route.path);
    }
    let mut template = String::new();
    for seg in route.path.split('/').skip(1) {
        template.push('/');
        match seg.strip_prefix(':') {
            Some(name) if route.encoded.contains(&name) => {
                let _ = write!(template, "${{encodeURIComponent({name})}}");
            }
            Some(name) => {
                let _ = write!(template, "${{{name}}}");
            }
            None => template.push_str(seg),
        }
    }
    format!("({}) => `{template}`", params.join(", "))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// One `key: value,` line of a routes file: its parameters and its path
    /// with `:name` / `:name!` (percent-encoded) for each of them.
    type Entry = (Vec<String>, String);

    fn parse(text: &str) -> BTreeMap<String, Entry> {
        let mut out = BTreeMap::new();
        for line in text.lines().map(str::trim) {
            let Some((key, value)) = line.split_once(": ") else { continue };
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            let value = value.trim_end_matches(',');
            if let Some(path) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
                out.insert(key.to_owned(), (Vec::new(), path.to_owned()));
            } else if let Some((params, template)) = value.strip_prefix('(').and_then(|v| v.split_once(") => `")) {
                let params: Vec<String> =
                    params.split(',').map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect();
                let mut path = template.trim_end_matches('`').to_owned();
                for p in &params {
                    path = path.replace(&format!("${{encodeURIComponent({p})}}"), &format!(":{p}!"));
                    path = path.replace(&format!("${{{p}}}"), &format!(":{p}"));
                }
                out.insert(key.to_owned(), (params, path));
            }
        }
        out
    }

    /// The generated file against the checked-in one. Equal entry for entry;
    /// what differs, and why:
    /// - order and comments: the generated file follows the table;
    /// - extra keys: the hand-written mirror left out routes the dashboard
    ///   does not call, the generated one is the whole table.
    #[test]
    fn generated_routes_js_matches_the_dashboards_file() {
        let checked_in = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/ui/src/api/routes.js");
        let theirs = parse(&std::fs::read_to_string(checked_in).expect("app/ui/src/api/routes.js"));
        let ours = parse(&routes_js());
        assert!(theirs.len() > 200, "the checked-in file parsed to {} routes", theirs.len());
        assert_eq!(ours.len(), ROUTES.len(), "a generated line did not parse back");
        for (key, entry) in &theirs {
            assert_eq!(ours.get(key), Some(entry), "ROUTES.{key}");
        }
    }

    #[test]
    fn route_export_lists_parameters_and_methods() {
        let routes = routes_json();
        let job = routes.as_array().and_then(|a| a.iter().find(|r| r["name"] == "jobOutput")).expect("jobOutput");
        assert_eq!(
            job,
            &json!({"name": "jobOutput", "path": "/api/jobs/:id/output", "params": ["id"], "methods": ["GET"], "encoded": ["id"], "prefix": false})
        );
    }
}
