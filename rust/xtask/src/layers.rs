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
/// - host: the bridge to the dashboard, then the window shell, then the binary; in that
///   order, so each may use the one before it. The shell and the binary live in the
///   `host/` workspace (Tauri + CEF), checked here as well.
const LAYERS: &[(&str, Layer)] = &[
    ("eos", Layer::Binary),
    ("eos-accounts", Layer::Service),
    ("eos-app", Layer::App),
    ("eos-apply", Layer::Shell),
    ("eos-auth", Layer::Adapter),
    ("eos-bridge", Layer::Bridge),
    ("eos-cef-helper", Layer::Shell),
    ("eos-config", Layer::Adapter),
    ("eos-contracts", Layer::Types),
    ("eos-core", Layer::Core),
    ("eos-domain", Layer::Domain),
    ("eos-engine", Layer::Adapter),
    ("eos-fs", Layer::Adapter),
    ("eos-genui", Layer::Types),
    ("eos-genui-media", Layer::Adapter),
    ("eos-git", Layer::Adapter),
    ("eos-kit-fs", Layer::Kit),
    ("eos-kit-net", Layer::Kit),
    ("eos-kit-proc", Layer::Kit),
    ("eos-kit-sqlite", Layer::Kit),
    ("eos-mod-accounts", Layer::Feature),
    ("eos-mod-agent-jobs", Layer::Feature),
    ("eos-mod-agents", Layer::Feature),
    ("eos-mod-auto-name", Layer::Feature),
    ("eos-mod-browser", Layer::Feature),
    ("eos-mod-btw", Layer::Feature),
    ("eos-mod-compaction", Layer::Feature),
    ("eos-mod-dreams", Layer::Feature),
    ("eos-mod-fs", Layer::Feature),
    ("eos-mod-genui", Layer::Feature),
    ("eos-mod-loops", Layer::Feature),
    ("eos-mod-pages", Layer::Feature),
    ("eos-mod-peer", Layer::Feature),
    ("eos-mod-plugins", Layer::Feature),
    ("eos-mod-policy", Layer::Feature),
    ("eos-mod-profile", Layer::Feature),
    ("eos-mod-projects", Layer::Feature),
    ("eos-mod-prompts", Layer::Feature),
    ("eos-mod-questions", Layer::Feature),
    ("eos-mod-remote", Layer::Feature),
    ("eos-mod-settings", Layer::Feature),
    ("eos-mod-sync", Layer::Feature),
    ("eos-mod-system", Layer::Feature),
    ("eos-mod-templates", Layer::Feature),
    ("eos-mod-terminals", Layer::Feature),
    ("eos-mod-transfer", Layer::Feature),
    ("eos-mod-updates", Layer::Feature),
    ("eos-mod-worker-definitions", Layer::Feature),
    ("eos-mod-workers", Layer::Feature),
    ("eos-mod-workflow-runs", Layer::Feature),
    ("eos-peer", Layer::Adapter),
    ("eos-platform", Layer::Kit),
    ("eos-plugin-build", Layer::Adapter),
    ("eos-plugin-files", Layer::Adapter),
    ("eos-policy", Layer::Service),
    ("eos-profile", Layer::Service),
    ("eos-prompts", Layer::Service),
    ("eos-pty", Layer::Adapter),
    ("eos-relay", Layer::Adapter),
    ("eos-runtime", Layer::Runtime),
    ("eos-sessions", Layer::Service),
    ("eos-shell", Layer::Shell),
    ("eos-store-files", Layer::Adapter),
    ("eos-store-sqlite", Layer::Adapter),
    ("eos-symbols", Layer::Adapter),
    ("eos-sync", Layer::Service),
    ("eos-sync-vault", Layer::Adapter),
    ("eos-tools", Layer::Feature),
    ("eos-transfer-fs", Layer::Adapter),
    ("eos-update", Layer::Adapter),
    ("eos-watch", Layer::Adapter),
    ("eos-workers", Layer::Service),
    // Test and dev tooling: never a normal dependency of a library crate.
    ("eos-testkit", Layer::Support),
    ("wire-recorder", Layer::Support),
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
    // The host layer, in its inner order.
    Bridge,
    Shell,
    Binary,
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

/// The workspaces the rule covers, as manifest paths from the main workspace's root.
/// `cargo metadata --no-deps` only reads manifests, so the host workspace's heavy
/// dependencies are never fetched or built for this check.
const WORKSPACES: &[&str] = &["Cargo.toml", "host/Cargo.toml"];

fn metadata(manifest: &std::path::Path) -> anyhow::Result<Metadata> {
    let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["metadata", "--format-version", "1", "--no-deps", "--manifest-path"])
        .arg(manifest)
        .output()
        .context("running cargo metadata")?;
    if !out.status.success() {
        bail!("cargo metadata failed for {}: {}", manifest.display(), String::from_utf8_lossy(&out.stderr));
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

pub(crate) fn check() -> anyhow::Result<()> {
    // xtask's own manifest sits one level below the main workspace's root.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().context("workspace root")?;
    let layers: HashMap<&str, Layer> = LAYERS.iter().copied().collect();

    let mut problems = Vec::new();
    let mut packages = Vec::new();
    for manifest in WORKSPACES {
        let meta = metadata(&root.join(manifest))?;
        packages.extend(meta.packages.into_iter().filter(|p| meta.workspace_members.contains(&p.id)));
    }
    for pkg in &packages {
        let Some(&own) = layers.get(pkg.name.as_str()) else {
            problems.push(format!("{}: not listed in xtask LAYERS", pkg.name));
            continue;
        };
        for dep in &pkg.dependencies {
            if let Some(why) = engine_violation(&pkg.name, &dep.name) {
                problems.push(format!("{} → {}: {why}", pkg.name, dep.name));
            }
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

/// The agent engine's crates (`eos-agent-*`) and who may depend on them, in
/// tests too: `eos-engine` on any of them (it is the one crate that runs
/// agents); `eos-auth` on the two provider sign-in crates, so the app's own
/// token reads renew a sign-in exactly as an agent's request does. Nobody
/// else: everything above reaches the engine through `eos-core` ports.
const ENGINE_PREFIX: &str = "eos-agent-";
const SIGN_IN_CRATES: &[&str] = &["eos-agent-anthropic", "eos-agent-openai"];

fn engine_violation(crate_name: &str, dep: &str) -> Option<&'static str> {
    if !dep.starts_with(ENGINE_PREFIX) {
        return None;
    }
    match crate_name {
        "eos-engine" => None,
        "eos-auth" if SIGN_IN_CRATES.contains(&dep) => None,
        "eos-auth" => {
            Some("eos-auth may use only the engine's provider sign-in crates (eos-agent-anthropic, eos-agent-openai)")
        }
        _ => Some(
            "only eos-engine (any engine crate) and eos-auth (the provider sign-in crates) may depend on the agent engine",
        ),
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
    fn only_the_engine_adapter_and_the_sign_in_adapter_see_the_agent_engine() {
        assert_eq!(engine_violation("eos-engine", "eos-agent-sdk"), None);
        assert_eq!(engine_violation("eos-engine", "eos-agent-mock-api"), None);
        assert_eq!(engine_violation("eos-auth", "eos-agent-anthropic"), None);
        assert_eq!(engine_violation("eos-auth", "eos-agent-openai"), None);
        assert!(engine_violation("eos-auth", "eos-agent-sdk").is_some());
        assert!(engine_violation("eos-auth", "eos-agent-core").is_some());
        assert!(engine_violation("eos-accounts", "eos-agent-anthropic").is_some());
        assert!(engine_violation("eos-mod-accounts", "eos-agent-sdk").is_some());
        assert_eq!(engine_violation("eos-app", "eos-engine"), None, "the adapter itself is an ordinary crate");
        assert_eq!(engine_violation("eos-app", "eos-agents-unrelated"), None);
    }

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
        assert_eq!(violation(Layer::Bridge, Layer::App, None), None);
        assert_eq!(violation(Layer::Bridge, Layer::Runtime, None), None);
        assert_eq!(violation(Layer::Shell, Layer::Bridge, None), None);
        assert_eq!(violation(Layer::Binary, Layer::Shell, None), None);
        assert!(violation(Layer::Bridge, Layer::Shell, None).is_some());
        assert!(violation(Layer::App, Layer::Bridge, None).is_some());
    }
}
