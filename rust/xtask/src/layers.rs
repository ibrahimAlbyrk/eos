use std::collections::HashMap;
use std::process::Command;

use anyhow::{Context, bail};
use serde::Deserialize;

/// Dependency direction:
/// types → domain → core → service → kit → adapter → runtime → feature → app → host.
///
/// A crate may only depend (normally) on crates in a lower layer, so two
/// features never reach into each other, adapters never see each other and
/// the core never sees an adapter.
///
/// - types: wire shapes, no logic beyond parsing.
/// - domain: pure rules, no async, no I/O.
/// - core: ports (traits) and the errors they share.
/// - service: use-cases over the ports (sessions, policy, prompts, workers).
/// - kit: I/O plumbing several adapters share; the only place OS differences live.
/// - adapter: one outside system each (SQLite, files, git, the agent engine…).
/// - runtime: what a feature may see of the running app (module trait, bus, jobs, stream).
/// - feature: one user-facing feature each, and the agent tools.
/// - app: the composition root that wires everything below it.
/// - host: the window shell, the bridge to the dashboard, the binary.
const LAYERS: &[(&str, Layer)] = &[
    ("eos-contracts", Layer::Types),
    ("eos-kit-fs", Layer::Kit),
    ("eos-kit-net", Layer::Kit),
    ("eos-kit-proc", Layer::Kit),
    ("eos-kit-sqlite", Layer::Kit),
    ("eos-platform", Layer::Kit),
    ("eos-runtime", Layer::Runtime),
    // Test and dev tooling: never a normal dependency of a library crate.
    ("xtask", Layer::Support),
];

// A layer with no crate in it yet is still part of the order.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Layer {
    Types,
    Domain,
    Core,
    Service,
    Kit,
    Adapter,
    Runtime,
    Feature,
    App,
    Host,
    Support,
}

#[derive(Deserialize)]
struct Metadata {
    packages: Vec<Package>,
    workspace_members: Vec<String>,
}

#[derive(Deserialize)]
struct Package {
    id: String,
    name: String,
    dependencies: Vec<Dep>,
}

#[derive(Deserialize)]
struct Dep {
    name: String,
    kind: Option<String>,
}

pub(crate) fn check() -> anyhow::Result<()> {
    let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .context("running cargo metadata")?;
    if !out.status.success() {
        bail!("cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let meta: Metadata = serde_json::from_slice(&out.stdout)?;
    let layers: HashMap<&str, Layer> = LAYERS.iter().copied().collect();

    let mut problems = Vec::new();
    for pkg in meta.packages.iter().filter(|p| meta.workspace_members.contains(&p.id)) {
        let Some(&own) = layers.get(pkg.name.as_str()) else {
            problems.push(format!("{}: not listed in xtask LAYERS", pkg.name));
            continue;
        };
        for dep in &pkg.dependencies {
            let Some(&theirs) = layers.get(dep.name.as_str()) else { continue };
            if let Some(why) = violation(own, theirs, dep.kind.as_deref()) {
                problems.push(format!("{} → {}: {why}", pkg.name, dep.name));
            }
        }
    }

    if problems.is_empty() {
        println!("layers ok");
        Ok(())
    } else {
        bail!("dependency direction violated:\n  {}", problems.join("\n  "))
    }
}

fn violation(own: Layer, theirs: Layer, kind: Option<&str>) -> Option<&'static str> {
    let dev = matches!(kind, Some("dev" | "build"));
    match (own, theirs) {
        // Tooling may use anything; anything may use tooling in tests.
        (Layer::Support, _) => None,
        (_, Layer::Support) if dev => None,
        (_, Layer::Support) => Some("test tooling as a normal dependency"),
        _ if theirs < own => None,
        // Tests may wire same-layer crates together (e.g. a feature test with a real store).
        _ if dev && theirs <= own => None,
        _ => Some("depends on the same or a higher layer"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_rules() {
        assert_eq!(violation(Layer::Domain, Layer::Types, None), None);
        assert!(violation(Layer::Core, Layer::Adapter, None).is_some());
        assert_eq!(violation(Layer::Service, Layer::Core, None), None);
        assert_eq!(violation(Layer::Adapter, Layer::Kit, None), None);
        assert!(violation(Layer::Kit, Layer::Adapter, None).is_some());
        assert!(violation(Layer::Adapter, Layer::Adapter, None).is_some());
        assert_eq!(violation(Layer::Adapter, Layer::Adapter, Some("dev")), None);
        assert!(violation(Layer::Feature, Layer::Feature, None).is_some());
        assert_eq!(violation(Layer::Feature, Layer::Runtime, None), None);
        assert_eq!(violation(Layer::App, Layer::Feature, None), None);
        assert!(violation(Layer::Feature, Layer::App, None).is_some());
        assert!(violation(Layer::Adapter, Layer::Support, None).is_some());
        assert_eq!(violation(Layer::Adapter, Layer::Support, Some("dev")), None);
        assert_eq!(violation(Layer::Host, Layer::App, None), None);
    }
}
