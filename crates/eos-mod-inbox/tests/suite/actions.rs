//! Needs you through the direct-action registry: a surface answers or puts
//! aside its own routine's items only, and reads what waits as counts and
//! kinds, with titles of its own routine's items alone.

use eos_domain::inbox::ItemKind;
use eos_runtime::actions::{ActionCall, ActionFailure, QueryCall};
use serde_json::{Value, json};

use crate::rig::{Rig, new_item};

fn call(action: &str, routine: Option<&str>, args: Value) -> ActionCall {
    ActionCall {
        action_id: action.into(),
        routine_id: routine.map(str::to_owned),
        args,
        origin: "phone".into(),
        record_id: "da-1".into(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surface_answers_and_puts_aside_its_own_routines_items_only() {
    let rig = Rig::new().await;
    let registry = rig.runtime.kernel.actions.registry();
    let answer = registry.action("needs_you.answer").expect("declared");
    let later = registry.action("needs_you.later").expect("declared");
    let mine = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let theirs = rig.open(new_item(ItemKind::Notice, "rt-2")).await;

    let refused = answer
        .handler
        .run(call("needs_you.answer", Some("rt-1"), json!({"item": theirs.id, "rev": 1, "choice": "dismiss"})))
        .await;
    assert_eq!(refused, Err(ActionFailure::new("out_of_scope", "That item belongs to another routine")));
    let wrong = answer
        .handler
        .run(call("needs_you.answer", Some("rt-1"), json!({"item": mine.id, "rev": 1, "choice": "resume"})))
        .await;
    assert_eq!(wrong.expect_err("not a notice's choice").kind, "invalid");

    let put_off =
        later.handler.run(call("needs_you.later", Some("rt-1"), json!({"item": mine.id, "until": 9_000_000}))).await;
    assert_eq!(put_off, Ok(json!({"itemId": mine.id, "state": "later"})));
    let done = answer
        .handler
        .run(call("needs_you.answer", Some("rt-1"), json!({"item": mine.id, "rev": 2, "choice": "dismiss"})))
        .await;
    assert_eq!(done, Ok(json!({"itemId": mine.id, "state": "answered"})));
    let again = answer
        .handler
        .run(call("needs_you.answer", Some("rt-1"), json!({"item": mine.id, "rev": 3, "choice": "dismiss"})))
        .await;
    assert_eq!(again, Err(ActionFailure::new("refused", "Already answered")));
    let (_, detail) = rig.ask(eos_runtime::http::Method::Get, &format!("/api/inbox/{}", mine.id), None).await;
    assert_eq!(detail["answeredBy"], "phone");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_summary_counts_everything_and_names_only_the_routines_own() {
    let rig = Rig::new().await;
    let summary = rig.runtime.kernel.actions.registry().query("needs_you.summary").expect("declared");
    let mine = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    rig.open(new_item(ItemKind::RoutineAlert, "rt-2")).await;

    let read = |routine: Option<&str>| QueryCall {
        query_id: "needs_you.summary".into(),
        routine_id: routine.map(str::to_owned),
        args: json!({}),
    };
    let own = summary.handler.read(read(Some("rt-1"))).await.expect("read");
    assert_eq!(
        own,
        json!({"count": 2, "open": 2, "later": 0, "kinds": {"notice": 1, "routine_alert": 1},
               "items": [{"id": mine.id, "kind": "notice", "title": "Review of #482"}]})
    );
    let global = summary.handler.read(read(None)).await.expect("read");
    assert_eq!(global["items"], json!([]), "no titles without a routine");
    assert_eq!(global["count"], 2);
}
