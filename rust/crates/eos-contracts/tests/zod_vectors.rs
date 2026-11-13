//! Differential test against Zod: every exported schema of `contracts/src`
//! parsed a set of inputs (`rust/tools/zod-port/vectors.mjs`); the Rust type
//! of the same name must accept and reject the same ones, produce the same
//! JSON for the accepted ones, and word a single failure the same way.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

mod common;
use common::run;

#[derive(Deserialize)]
struct Vector {
    schema: String,
    case: String,
    input: Value,
    ok: bool,
    /// The schema is one option of a tagged union; the Rust type is the union.
    #[serde(default)]
    member: bool,
    output: Option<Value>,
    #[serde(default)]
    issues: Vec<ZodIssue>,
}

#[derive(Deserialize)]
struct ZodIssue {
    path: Vec<String>,
    message: String,
    code: String,
}

/// Failures Zod words in a way a single serde error can be reworded to.
const EXACT_CODES: &[&str] =
    &["too_small", "too_big", "invalid_string", "invalid_type", "invalid_enum_value", "custom"];

/// What carries a goal loop is left out of the types (crates/eos-contracts/README.md).
const NO_GOAL_LOOPS: &str = "the Rust app has no goal loops";

/// Where the Rust type deliberately does not follow the Zod schema: `(schema, case, why)`.
const KNOWN_DIFFERENCES: &[(&str, &str, &str)] = &[
    (
        "ErrorResponseSchema",
        "extra",
        "error bodies on the wire carry more than `error` (path, limit, problems); the type keeps them",
    ),
    ("WorkerRowSchema", "full", NO_GOAL_LOOPS),
    ("WorkerRowSchema", "extra", NO_GOAL_LOOPS),
    ("WorkerListResponseSchema", "full", NO_GOAL_LOOPS),
    ("OrchestratorListResponseSchema", "full", NO_GOAL_LOOPS),
    ("SpawnWorkerRequestSchema", "type:loop", NO_GOAL_LOOPS),
    ("ReportResponseSchema", "full", NO_GOAL_LOOPS),
    ("ReportResponseSchema", "extra", NO_GOAL_LOOPS),
    ("ReportResponseSchema", "type:held", NO_GOAL_LOOPS),
    ("MessageRecordSchema", "option-4", NO_GOAL_LOOPS),
    ("WorkerEventTypeSchema", "enum", NO_GOAL_LOOPS),
    ("WorkerEventPostBodySchema", "enum:type", NO_GOAL_LOOPS),
];

#[test]
fn rust_types_agree_with_zod() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors");
    let mut failures: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let (mut total, mut worded) = (0, 0);
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in files.iter().filter(|f| f.extension().is_some_and(|e| e == "json")) {
        let rows: Vec<Vector> = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        for v in rows {
            if KNOWN_DIFFERENCES.iter().any(|(schema, case, _)| *schema == v.schema && *case == v.case) {
                continue;
            }
            total += 1;
            let at = format!("{} [{}]", v.schema, v.case);
            let Some(got) = run(&v.schema, &v.input) else {
                failures.entry("no Rust type").or_default().push(at);
                continue;
            };
            match (got, v.ok) {
                (Ok(out), true) => {
                    if Some(&out) != v.output.as_ref() {
                        failures
                            .entry("output differs")
                            .or_default()
                            .push(format!("{at}\n      zod:  {}\n      rust: {out}", v.output.as_ref().unwrap()));
                    }
                }
                (Ok(_), false) => failures.entry("Rust accepts, Zod rejects").or_default().push(format!(
                    "{at}: {}",
                    v.issues
                        .iter()
                        .map(|i| format!("{}: {}", i.path.join("."), i.message))
                        .collect::<Vec<_>>()
                        .join("; ")
                )),
                (Err(e), true) => failures.entry("Rust rejects, Zod accepts").or_default().push(format!("{at}: {e}")),
                (Err(e), false) => {
                    let [only] = v.issues.as_slice() else { continue };
                    if v.member || !EXACT_CODES.contains(&only.code.as_str()) {
                        continue;
                    }
                    worded += 1;
                    let want = format!("invalid request: {}: {}", only.path.join("."), only.message);
                    if e.message() != want {
                        failures
                            .entry("message differs")
                            .or_default()
                            .push(format!("{at}\n      zod:  {want}\n      rust: {e}"));
                    }
                }
            }
        }
    }
    let report: String = failures
        .iter()
        .map(|(kind, list)| {
            format!("\n{kind}: {}\n  {}", list.len(), list.iter().take(25).cloned().collect::<Vec<_>>().join("\n  "))
        })
        .collect();
    assert!(failures.is_empty(), "{total} vectors, {worded} messages compared{report}");
    assert!(total > 4000 && worded > 1500, "the corpus shrank: {total} vectors, {worded} messages");
}
