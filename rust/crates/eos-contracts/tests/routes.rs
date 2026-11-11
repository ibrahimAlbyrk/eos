//! The route table against its sources: the keys and templates of `ROUTES` in
//! `contracts/src/http.ts` (exported by `rust/tools/zod-port/vectors.mjs`) and,
//! once the wire fixtures are in the tree, the methods the Node daemon registers.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use eos_contracts::routes::ROUTES;
use serde::Deserialize;

#[derive(Deserialize)]
struct TsRoute {
    name: String,
    path: String,
    params: Vec<String>,
}

#[test]
fn names_paths_and_parameters_are_those_of_the_typescript_table() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/routes.json");
    let ts: Vec<TsRoute> = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    assert_eq!(ts.len(), ROUTES.len());
    for (ours, theirs) in ROUTES.iter().zip(&ts) {
        assert_eq!(ours.name, theirs.name);
        // The TypeScript side filled an encoded parameter with an escaped `:name`.
        assert_eq!(ours.path, theirs.path.replace("%3A", ":"), "{}", ours.name);
        assert_eq!(ours.params().collect::<Vec<_>>(), theirs.params, "{}", ours.name);
    }
}

/// `rust/fixtures/wire` (the wire recorder's output), or `EOS_WIRE_FIXTURES`.
fn wire_fixtures() -> Option<PathBuf> {
    let dir = std::env::var_os("EOS_WIRE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire"));
    dir.join("routes.json").exists().then_some(dir)
}

#[derive(Deserialize)]
struct Recorded {
    routes: Vec<Registered>,
}

#[derive(Deserialize)]
struct Registered {
    method: String,
    template: String,
}

fn shape(template: &str) -> String {
    template.split('/').map(|seg| if seg.starts_with(':') { ":" } else { seg }).collect::<Vec<_>>().join("/")
}

#[test]
fn methods_are_the_ones_the_daemon_registers() {
    let Some(dir) = wire_fixtures() else {
        eprintln!("skipped: no wire fixtures in this tree yet");
        return;
    };
    let recorded: Recorded = serde_json::from_slice(&std::fs::read(dir.join("routes.json")).unwrap()).unwrap();
    let mut registered: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for r in recorded.routes {
        registered.entry(shape(&r.template)).or_default().insert(r.method);
    }
    let mut checked = 0;
    for route in ROUTES {
        // Prefixes and route families have no single registered pattern; the
        // peer routes are served by the peer listener.
        let Some(methods) = registered.get(&shape(route.path)) else { continue };
        let ours: BTreeSet<String> = route.methods.iter().map(ToString::to_string).collect();
        assert_eq!(&ours, methods, "{} {}", route.name, route.path);
        checked += 1;
    }
    assert!(checked > 250, "only {checked} routes matched a registered pattern");
}
