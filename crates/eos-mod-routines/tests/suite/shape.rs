//! The shape of the result a routine makes, as its channel declares it: the
//! lead's brief and the checker's state it, and a result of another shape
//! is sent back with what to change.

use eos_contracts::RoutineState;
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_domain::result_doc::shape::{MetaShape, MetaValue, PartKey, PartShape, ResultShape};
use eos_domain::routine::run::{RunState, Station};
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

fn comment_key(n: usize) -> String {
    format!("c:{n}")
}

/// A review as a channel could declare it: a summary and line comments.
fn review_shape() -> ResultShape {
    let line = MetaShape {
        name: "line".into(),
        required: true,
        value: MetaValue::Line,
        what: "The line.".into(),
        example: json!(4),
    };
    let part = |key, role: &str, name: &str, required, meta: Vec<MetaShape>| PartShape {
        key,
        role: role.into(),
        name: name.into(),
        required,
        what: format!("The {name}."),
        values: Vec::new(),
        meta,
        otherwise: Some("put general remarks in the summary part".into()),
        example: "Text.".into(),
    };
    ResultShape {
        kind: "github.review".into(),
        channel: "github".into(),
        actions: vec!["post_review".into()],
        parts: vec![
            part(PartKey::One("summary".into()), "summary", "summary", true, Vec::new()),
            part(PartKey::Each(comment_key), "comment", "line comment", false, vec![line]),
        ],
        notes: Vec::new(),
    }
}

fn bench() -> Bench {
    Bench::with_reads(true, FakeCapabilityReads::new().shaping(review_shape()))
}

fn handed(body: Value) -> SubmittedResult {
    SubmittedResult { kind: "github.review".into(), headline: "R".into(), body, files: vec![] }
}

fn fitting() -> Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review",
           "parts": [{"key": "summary", "role": "summary", "text": "Fine."}]})
}

/// The second failed result seen in use: a general remark as a part.
fn general_remark() -> Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review",
           "parts": [{"key": "summary", "role": "summary", "text": "Fine."},
                     {"key": "body", "role": "comment", "text": "Overall fine."}]})
}

async fn working(bench: &Bench) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let id = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(3)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lead_and_the_checker_are_told_the_kind_and_shape_the_channel_declares() {
    let bench = bench();
    let (_, lead) = working(&bench).await;
    let told = review_shape().describe();
    let started = bench.agents.started();
    let brief = started[0].prompt.clone().expect("the brief");
    assert!(brief.contains(&told), "{brief}");
    assert!(told.contains("Hand in kind `github.review`") && told.contains("```json"), "{told}");

    bench.module.tools().submit_result(&lead, handed(fitting())).await.expect("handed in");
    bench.eventually(|| bench.agents.started().len() == 2).await;
    let checker = bench.agents.started()[1].prompt.clone().expect("the checker's brief");
    assert!(checker.contains(&told), "{checker}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_of_another_shape_is_refused_at_once_with_what_to_change() {
    let bench = bench();
    let (run, lead) = working(&bench).await;
    let refused = bench.module.tools().submit_result(&lead, handed(general_remark())).await.expect_err("refused");
    let told = refused.to_string();
    let fix = "part `body`: a line comment needs meta.line; put general remarks in the summary part.";
    assert!(told.contains(fix) && told.contains("call submit_result again"), "{told}");
    let plain = bench.module.tools().submit_result(&lead, handed(json!("Overall fine."))).await.expect_err("refused");
    let told = plain.to_string();
    assert!(told.contains("hand in the whole result as one object with kind, channel, action and parts"), "{told}");
    let at = bench.run(&run);
    assert_eq!((at.state, at.station, at.attempt), (RunState::Running, Some(Station::Work), 1), "no round spent");
    assert_eq!(bench.agents.started().len(), 1, "no checker for a result of the wrong shape");
    bench.module.tools().submit_result(&lead, handed(fitting())).await.expect("the right shape is taken");
    bench.eventually(|| bench.state(&run) == RunState::Checking).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_object_that_is_no_result_is_told_the_field_it_lacks_not_parts_it_has() {
    let bench = bench();
    let (run, lead) = working(&bench).await;
    let roleless = json!({"kind": "github.review", "channel": "github", "action": "post_review",
                          "parts": [{"key": "summary", "text": "Fine."}]});
    let told = bench.module.tools().submit_result(&lead, handed(roleless)).await.expect_err("refused").to_string();
    assert!(told.contains("part `summary`: `role` is missing or not text"), "{told}");
    assert!(!told.contains("is missing: The summary"), "the summary it has is not called missing: {told}");

    let as_text = fitting().to_string();
    let told =
        bench.module.tools().submit_result(&lead, handed(json!(as_text))).await.expect_err("refused").to_string();
    assert!(told.contains("pass the result as one object, not as text holding JSON"), "{told}");
    assert!(!told.contains("part `body`"), "{told}");
    assert_eq!(bench.run(&run).station, Some(Station::Work), "no round spent");
}
