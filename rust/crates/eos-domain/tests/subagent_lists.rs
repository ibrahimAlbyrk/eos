//! A conversation's subagents and artifacts against what the dashboard derives
//! from the same log (`rust/fixtures/subagent-lists/vectors.json`, frozen from the TypeScript, see `rust/fixtures/README.md`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::path::PathBuf;

use eos_domain::display::sanitize_payload;
use eos_domain::transcript::{ConversationLists, IndexedRow, RowFacts, rows_of_subagent};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    boot_prompt_offset: u32,
    rows: Vec<Row>,
    expected: Value,
}

#[derive(Deserialize, Clone)]
struct Row {
    id: i64,
    ts: i64,
    #[serde(rename = "type")]
    kind: String,
    payload: Option<String>,
}

fn vectors() -> Vec<Case> {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/subagent-lists/vectors.json"));
    let v: Vectors = serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors")).expect("the vectors");
    v.vectors
}

fn indexed(rows: &[Row]) -> Vec<IndexedRow> {
    rows.iter()
        .filter_map(|r| {
            RowFacts::of(&r.kind, r.payload.as_deref()).map(|facts| IndexedRow { id: r.id, ts: r.ts, facts })
        })
        .collect()
}

/// The input each named row's payload carries, read as a client reads the row.
fn inputs(rows: &[Row], ids: &[i64]) -> HashMap<i64, Value> {
    rows.iter()
        .filter(|r| ids.contains(&r.id))
        .filter_map(|r| {
            let text = r.payload.as_deref()?;
            let clean = sanitize_payload(text);
            let payload: Value = serde_json::from_str(clean.as_deref().unwrap_or(text)).ok()?;
            Some((r.id, payload.get("input").cloned().unwrap_or(Value::Null)))
        })
        .collect()
}

fn lists(rows: &[Row], offset: u32) -> Value {
    let index = indexed(rows);
    let lists = ConversationLists::derive(&index, offset);
    let inputs = inputs(rows, &lists.activity_rows());
    json!({ "subagents": lists.subagents(&inputs), "artifacts": lists.artifacts() })
}

#[test]
fn the_lists_are_what_the_dashboard_derives_from_the_same_log() {
    let cases = vectors();
    assert!(cases.len() >= 8);
    for case in &cases {
        assert_eq!(lists(&case.rows, case.boot_prompt_offset), case.expected, "{}", case.name);
    }
}

#[test]
fn a_subagents_own_rows_rebuild_it_as_the_whole_log_does() {
    for case in vectors() {
        let whole = lists(&case.rows, case.boot_prompt_offset);
        let index = indexed(&case.rows);
        let holding = |list: &Value, call: &str| -> Vec<Value> {
            let subagents = list["subagents"].as_array().unwrap().iter();
            subagents
                .filter(|s| s["runs"].as_array().unwrap().iter().any(|r| r["toolUseId"] == call))
                .cloned()
                .collect()
        };
        for subagent in whole["subagents"].as_array().unwrap() {
            for run in subagent["runs"].as_array().unwrap() {
                let call = run["toolUseId"].as_str().unwrap();
                let ids = rows_of_subagent(&index, case.boot_prompt_offset, call);
                let own: Vec<Row> = case.rows.iter().filter(|r| ids.contains(&r.id)).cloned().collect();
                // Its rows hold no prompt or marker: what the passes hid stays hidden.
                let alone = lists(&own, 0);
                assert_eq!(holding(&alone, call), holding(&whole, call), "{}: {call}", case.name);
            }
        }
        assert!(rows_of_subagent(&index, case.boot_prompt_offset, "no-such-call").is_empty());
    }
}
