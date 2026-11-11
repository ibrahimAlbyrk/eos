//! Resolution, defaults, `provider/model`, the catalog and model tiers
//! against today's TypeScript (`rust/fixtures/workers/vectors.json`, written
//! by `rust/tools/workers-vectors/generate.mjs`).

use std::fs;
use std::path::PathBuf;

use eos_contracts::{ToolScope, WorkerDefinition, WorkerDefinitionRecord};
use eos_domain::{ProviderIdentity, TierSpec};
use eos_workers::catalog::{merge_available, render_catalog};
use eos_workers::resolve::{
    apply_defaults, is_restrictive, materialize_tool_scope, resolve_by_name, resolve_combined_model,
    resolve_definition_name, split_provider_model,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Defaults {
    has: Vec<String>,
    defaults: Value,
}

#[derive(Deserialize)]
struct Resolved {
    slice: usize,
    name: String,
    definition: Option<WorkerDefinition>,
    scope: Option<ToolScope>,
    restrictive: Option<bool>,
    defaults: Option<Vec<Defaults>>,
}

#[derive(Deserialize)]
struct Named {
    from: Option<String>,
    role: Option<String>,
    name: String,
}

#[derive(Deserialize)]
struct Combined {
    model: Option<String>,
    pinned: Option<String>,
    out: Value,
    split: Option<Value>,
}

#[derive(Deserialize)]
struct Merge {
    disk: Vec<WorkerDefinitionRecord>,
    runtime: Vec<WorkerDefinitionRecord>,
    merged: Vec<WorkerDefinitionRecord>,
    catalog: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    persona: String,
    tiers: Vec<Tier>,
    default_tier: Option<String>,
    effort_supported: bool,
}

#[derive(Deserialize)]
struct Tier {
    name: String,
    model: String,
    hint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TierCase {
    identity: Identity,
    default_tier: String,
    default_valid: bool,
    is_claude: bool,
    names: Vec<String>,
    resolved: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
struct Vectors {
    records: Vec<WorkerDefinitionRecord>,
    slices: Vec<usize>,
    resolved: Vec<Resolved>,
    names: Vec<Named>,
    backends: Vec<String>,
    combined: Vec<Combined>,
    merges: Vec<Merge>,
    tiers: Vec<TierCase>,
}

fn vectors() -> Vectors {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/workers/vectors.json"));
    serde_json::from_str(&fs::read_to_string(&path).expect("the vectors")).expect("the vectors")
}

#[test]
fn definitions_resolve_as_typescript_resolves_them() {
    let v = vectors();
    assert!(v.resolved.len() >= 48);
    for case in &v.resolved {
        let records = &v.records[..v.slices[case.slice]];
        let ours = resolve_by_name(&case.name, records);
        assert_eq!(ours, case.definition, "{:?} among the first {}", case.name, records.len());
        let Some(definition) = ours else { continue };
        let scope = materialize_tool_scope(&definition);
        assert_eq!(Some(&scope), case.scope.as_ref(), "{}", case.name);
        assert_eq!(Some(is_restrictive(&scope)), case.restrictive, "{}", case.name);
        for set in case.defaults.as_deref().unwrap_or_default() {
            let d = apply_defaults(&definition, |field| set.has.iter().any(|h| h == field));
            let mut ours = serde_json::Map::new();
            let mut put = |key: &str, value: Option<Value>| {
                if let Some(value) = value {
                    ours.insert(key.to_owned(), value);
                }
            };
            put("model", d.model.map(Value::from));
            put("effort", d.effort.map(|e| json!(e)));
            put("permissionMode", d.permission_mode.map(|m| json!(m)));
            put("backendKind", d.backend_kind.map(Value::from));
            put("backendProfile", d.backend_profile.map(Value::from));
            put("persistent", d.persistent.map(Value::from));
            put("collaborate", d.collaborate.map(Value::from));
            put("isolation", d.isolation.map(|i| json!(i)));
            assert_eq!(Value::Object(ours), set.defaults, "{} when the request has {:?}", case.name, set.has);
        }
    }
}

#[test]
fn names_and_combined_models_as_in_typescript() {
    let v = vectors();
    for n in &v.names {
        assert_eq!(resolve_definition_name(n.from.as_deref(), n.role.as_deref()), n.name, "{:?} {:?}", n.from, n.role);
    }
    let is_backend = |name: &str| v.backends.iter().any(|b| b == name);
    for c in &v.combined {
        let (model, profile) = resolve_combined_model(c.model.as_deref(), c.pinned.as_deref(), is_backend);
        assert_eq!(json!({"model": model, "backendProfile": profile}), c.out, "{:?} pinned {:?}", c.model, c.pinned);
        if let (Some(model), Some(want)) = (&c.model, &c.split) {
            let (profile, bare) = split_provider_model(model, is_backend);
            let mut ours = serde_json::Map::new();
            if let Some(profile) = profile {
                ours.insert("backendProfile".into(), profile.into());
            }
            ours.insert("model".into(), bare.into());
            assert_eq!(&Value::Object(ours), want, "{model:?}");
        }
    }
}

#[test]
fn the_catalog_merges_and_reads_as_in_typescript() {
    for m in vectors().merges {
        let merged = merge_available(m.disk, m.runtime);
        assert_eq!(merged, m.merged);
        assert_eq!(render_catalog(&merged), m.catalog);
    }
}

#[test]
fn tiers_resolve_as_in_typescript() {
    for case in vectors().tiers {
        let identity = ProviderIdentity {
            persona: case.identity.persona,
            tiers: case
                .identity
                .tiers
                .into_iter()
                .map(|t| TierSpec { name: t.name, model: t.model, hint: t.hint })
                .collect(),
            default_tier: case.identity.default_tier,
            effort_supported: case.identity.effort_supported,
        };
        assert_eq!(identity.default_tier_name(), case.default_tier, "{}", identity.persona);
        assert_eq!(identity.default_tier_is_valid(), case.default_valid, "{}", identity.persona);
        assert_eq!(identity.is_claude(), case.is_claude);
        assert_eq!(identity.tier_names(), case.names);
        for (asked, want) in &case.resolved {
            assert_eq!(Some(identity.resolve_tier(asked)), want.as_str(), "{asked:?} on {}", identity.persona);
        }
    }
}
