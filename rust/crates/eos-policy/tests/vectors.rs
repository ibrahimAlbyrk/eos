//! The Rust decisions against the TypeScript's: `rust/fixtures/policy` holds
//! what the real loader and `PolicyGatewayService.evaluate` decided over a
//! matrix of policies, tools, inputs, modes and tool scopes (frozen, see
//! `rust/fixtures/README.md`). Every decision must be equal.

use std::fs;
use std::path::PathBuf;

use eos_contracts::{PermissionMode, ToolScope, UnknownRecord};
use eos_core::policy::PolicyDocument;
use eos_policy::ask::summarize_pending_input;
use eos_policy::glob::matches_tool_pattern;
use eos_policy::mode::{ToolCategory, is_path_inside, parse_mode};
use eos_policy::{Call, Policy, classify_tool, evaluate, load_policy, worker_permissions};
use eos_testkit::TempStore;
use serde::Deserialize;
use serde_json::Value;

fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/policy")).join(name);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[derive(Deserialize)]
struct Loaded {
    default: String,
    #[serde(rename = "ttlMs")]
    ttl_ms: i64,
    rules: usize,
}

#[derive(Deserialize)]
struct PolicyCase {
    parses: bool,
    doc: Value,
    loaded: Loaded,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Switch {
    agent_id: Option<String>,
    full_surface: bool,
    plans_dir: Option<String>,
}

#[derive(Deserialize)]
struct Decisions {
    policies: Vec<PolicyCase>,
    tools: Vec<String>,
    inputs: Vec<UnknownRecord>,
    modes: Vec<String>,
    scopes: Vec<Option<ToolScope>>,
    switches: Vec<Switch>,
    decisions: Vec<Value>,
    cases: Vec<[usize; 7]>,
}

fn policy_of(case: &PolicyCase) -> Policy {
    let source = "policy.yaml".to_owned();
    let document = if case.parses {
        PolicyDocument::Parsed { source, value: case.doc.clone() }
    } else {
        PolicyDocument::Unreadable { source, error: "does not parse".into() }
    };
    load_policy(document, 0)
}

/// TypeScript passes a rule's `reason` through as the YAML value it is; here
/// a denial's message is always text, worded as JavaScript would print it.
fn with_text_message(mut decision: Value) -> Value {
    if let Some(message) = decision.get_mut("message").filter(|m| !m.is_string()) {
        *message = Value::String(eos_policy::js::to_string(message));
    }
    decision
}

#[test]
fn every_decision_equals_typescripts() {
    let corpus: Decisions = fixture("decisions.json");
    assert!(corpus.cases.len() > 40_000, "the corpus is the whole matrix");
    let policies: Vec<Policy> = corpus.policies.iter().map(policy_of).collect();
    for (policy, case) in policies.iter().zip(&corpus.policies) {
        let default = serde_json::to_value(policy.default).expect("a name");
        assert_eq!((default.as_str(), policy.ttl_ms), (Some(case.loaded.default.as_str()), case.loaded.ttl_ms));
        // `rules: none` is no rules here; JavaScript walks the text's characters
        // into rules that match nothing. The decisions below are equal either way.
        if case.doc.get("rules").is_none_or(Value::is_array) {
            assert_eq!(policy.rules.len(), case.loaded.rules);
        }
    }
    let modes: Vec<PermissionMode> = corpus.modes.iter().map(|m| parse_mode(m).expect("a mode")).collect();
    let expected: Vec<Value> = corpus.decisions.iter().cloned().map(with_text_message).collect();

    let mut failures = Vec::new();
    for (n, &[p, t, i, m, s, w, d]) in corpus.cases.iter().enumerate() {
        let switch = &corpus.switches[w];
        let call = Call {
            tool_name: &corpus.tools[t],
            input: &corpus.inputs[i],
            agent_id: switch.agent_id.as_deref(),
            full_surface: switch.full_surface,
            mode: modes[m],
            scope: corpus.scopes[s].as_ref(),
            plans_dir: switch.plans_dir.as_deref(),
        };
        let ours = serde_json::to_value(evaluate(&policies[p], &call)).expect("a decision");
        if ours != expected[d] {
            failures.push(format!(
                "#{n} policy {p} {} {} mode {} scope {s} switch {w}\n  theirs {}\n  ours   {ours}",
                corpus.tools[t],
                serde_json::to_string(&corpus.inputs[i]).expect("json"),
                corpus.modes[m],
                expected[d],
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        corpus.cases.len(),
        failures[..failures.len().min(10)].join("\n")
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Classified {
    tool: String,
    input: UnknownRecord,
    plans_dir: Option<String>,
    category: String,
}

#[derive(Deserialize)]
struct Row {
    id: String,
    parent_id: Option<String>,
    permission_mode: Option<String>,
    tool_scope: Option<String>,
}

#[derive(Deserialize)]
struct Resolved {
    id: String,
    mode: String,
    scope: Option<ToolScope>,
}

#[derive(Deserialize)]
struct Summary {
    input: String,
    summary: String,
}

#[derive(Deserialize)]
struct Units {
    patterns: Vec<String>,
    names: Vec<String>,
    args: Vec<Option<String>>,
    globs: Vec<(String, String, Option<String>)>,
    classify: Vec<Classified>,
    paths: Vec<String>,
    inside: Vec<(String, String)>,
    rows: Vec<Row>,
    chain: Vec<Resolved>,
    summaries: Vec<Summary>,
}

fn category_name(category: ToolCategory) -> &'static str {
    match category {
        ToolCategory::FileEdit => "fileEdit",
        ToolCategory::PlanFile => "planFile",
        ToolCategory::Shell => "shell",
        ToolCategory::Read => "read",
        ToolCategory::BrowserRead => "browserRead",
        ToolCategory::BrowserWrite => "browserWrite",
        ToolCategory::Mcp => "mcp",
        ToolCategory::Network => "network",
        ToolCategory::Other => "other",
    }
}

#[test]
fn tool_patterns_categories_and_paths_equal_typescripts() {
    let units: Units = fixture("units.json");
    for pattern in &units.patterns {
        for name in &units.names {
            for arg in &units.args {
                let theirs = units.globs.contains(&(pattern.clone(), name.clone(), arg.clone()));
                assert_eq!(matches_tool_pattern(name, pattern, arg.as_deref()), theirs, "{pattern:?} {name:?} {arg:?}");
            }
        }
    }
    for c in &units.classify {
        let ours = classify_tool(&c.tool, Some(&c.input), c.plans_dir.as_deref());
        assert_eq!(category_name(ours), c.category, "{} {:?} {:?}", c.tool, c.input, c.plans_dir);
    }
    for child in &units.paths {
        for parent in &units.paths {
            let theirs = units.inside.contains(&(child.clone(), parent.clone()));
            assert_eq!(is_path_inside(child, parent), theirs, "{child:?} inside {parent:?}");
        }
    }
    for s in &units.summaries {
        assert_eq!(summarize_pending_input(&s.input), s.summary, "{:?}", s.input);
    }
}

fn sql_text(value: &Option<String>) -> String {
    value.as_ref().map_or("NULL".to_owned(), |v| format!("'{}'", v.replace('\'', "''")))
}

#[test]
fn a_worker_inherits_its_mode_and_owns_its_scope_as_in_typescript() {
    let units: Units = fixture("units.json");
    let temp = TempStore::new();
    for row in &units.rows {
        temp.exec(&format!(
            "INSERT INTO workers (id, state, prompt, started_at, parent_id, permission_mode, tool_scope) \
             VALUES ('{}', 'IDLE', '', 1, {}, {}, {})",
            row.id,
            sql_text(&row.parent_id),
            sql_text(&row.permission_mode),
            sql_text(&row.tool_scope),
        ));
    }
    for want in &units.chain {
        let id = want.id.clone();
        let ours = temp.store.read_blocking(move |tx| worker_permissions(tx.workers(), &id)).expect("reads");
        assert_eq!(Some(ours.mode), parse_mode(&want.mode), "{}", want.id);
        assert_eq!(ours.scope, want.scope, "{}", want.id);
    }
}
