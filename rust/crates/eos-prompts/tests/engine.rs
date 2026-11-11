//! The template language, `when` conditions, frontmatter checks and the
//! memory section against today's TypeScript (`rust/fixtures/prompts/engine.json`,
//! written by `rust/tools/prompt-vectors/generate.mjs`), errors included.

use std::path::PathBuf;

use eos_contracts::Condition;
use eos_core::prompt::{MemoryDoc, MemoryLevel, MemorySnapshot, RawPrompt};
use eos_prompts::condition::evaluate_condition;
use eos_prompts::memory::{compose_appended_prompt, select_injectable_memory};
use eos_prompts::prompt::{dpi_of, layer_name};
use eos_prompts::template::{parse_template, render_template};
use eos_prompts::{VariableScope, parse_prompt};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
struct Template {
    body: String,
    error: Option<String>,
    referenced: Option<Vec<String>>,
    rendered: Option<String>,
    empty: Option<String>,
}

#[derive(Deserialize)]
struct ConditionCase {
    condition: Value,
    valid: bool,
    result: Option<bool>,
}

#[derive(Deserialize)]
struct FrontmatterCase {
    frontmatter: Value,
    valid: bool,
    variables: Option<Vec<String>>,
    warnings: Option<Vec<String>>,
    dpi: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    source_id: String,
    source_label: String,
    native_for: Vec<String>,
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct Snapshot {
    docs: Vec<Doc>,
}

#[derive(Deserialize)]
struct MemoryCase {
    dpi: Option<String>,
    snapshot: Option<Snapshot>,
    kind: String,
    out: Option<String>,
}

#[derive(Deserialize)]
struct Engine {
    scope: VariableScope,
    templates: Vec<Template>,
    facts: Map<String, Value>,
    conditions: Vec<ConditionCase>,
    frontmatters: Vec<FrontmatterCase>,
    memory: Vec<MemoryCase>,
}

fn engine() -> Engine {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/prompts/engine.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("the vectors")).expect("the vectors")
}

#[test]
fn templates_parse_render_and_fail_as_in_typescript() {
    let engine = engine();
    assert!(engine.templates.len() >= 40);
    for case in &engine.templates {
        match (parse_template(&case.body), &case.error) {
            (Err(e), Some(message)) => assert_eq!(&e.to_string(), message, "{:?}", case.body),
            (Ok(template), None) => {
                assert_eq!(Some(&template.referenced), case.referenced.as_ref(), "{:?}", case.body);
                assert_eq!(Some(render_template(&template.nodes, &engine.scope)), case.rendered, "{:?}", case.body);
                assert_eq!(
                    Some(render_template(&template.nodes, &VariableScope::new())),
                    case.empty,
                    "{:?}",
                    case.body
                );
            }
            (ours, theirs) => panic!("{:?}: ours {ours:?}, theirs {theirs:?}", case.body),
        }
    }
}

#[test]
fn conditions_hold_as_in_typescript() {
    let engine = engine();
    assert!(engine.conditions.len() >= 55);
    for case in &engine.conditions {
        let parsed = eos_contracts::validate::parse::<Condition>(&case.condition);
        assert_eq!(parsed.is_ok(), case.valid, "{}", case.condition);
        if let Ok(condition) = parsed {
            assert_eq!(Some(evaluate_condition(&condition, &engine.facts)), case.result, "{}", case.condition);
        }
    }
}

#[test]
fn frontmatter_is_accepted_and_refused_as_in_typescript() {
    for case in engine().frontmatters {
        let raw = RawPrompt {
            id: "p".into(),
            frontmatter: case.frontmatter.clone(),
            body: "{{A}} {{C}}".into(),
            source_path: None,
        };
        let parsed = parse_prompt(&raw);
        assert_eq!(parsed.is_ok(), case.valid, "{}", case.frontmatter);
        let Ok(prompt) = parsed else { continue };
        assert_eq!(Some(prompt.frontmatter.variables.iter().map(|v| v.0.clone()).collect::<Vec<_>>()), case.variables);
        assert_eq!(Some(&prompt.warnings), case.warnings.as_ref(), "{}", case.frontmatter);
        let dpi = dpi_of(&prompt).map(|d| {
            json!({ "layer": layer_name(d.layer), "priority": d.priority, "conditional": d.when.is_some(), "overrides": d.overrides })
        });
        assert_eq!(dpi, case.dpi, "{}", case.frontmatter);
    }
}

#[test]
fn memory_is_folded_behind_the_prompt_as_in_typescript() {
    for case in engine().memory {
        let snapshot = case.snapshot.map(|s| MemorySnapshot {
            docs: s
                .docs
                .into_iter()
                .map(|d| MemoryDoc {
                    source_id: d.source_id,
                    source_label: d.source_label,
                    native_for: d.native_for,
                    path: d.path.into(),
                    level: MemoryLevel::Project,
                    content: d.content,
                })
                .collect(),
        });
        let injectable = snapshot.as_ref().map(|s| select_injectable_memory(s, &case.kind));
        assert_eq!(
            compose_appended_prompt(case.dpi.as_deref(), injectable.as_ref()),
            case.out,
            "{:?} for {}",
            case.dpi,
            case.kind
        );
    }
}
