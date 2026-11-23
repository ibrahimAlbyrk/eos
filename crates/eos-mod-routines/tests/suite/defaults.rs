//! An option set by hand again and again becomes its default: after the
//! same value in 3 of the last 4 starts by hand, a version by Eos with one
//! note; several items started together count once; an undo is not learned
//! again from the same starts.

use eos_contracts::RoutineState;
use serde_json::{Value, json};

use crate::bench::{blueprint, pull_request};
use crate::run_routes::Routes;

fn item(number: u32) -> Value {
    serde_json::to_value(pull_request(number)).expect("json")
}

/// Starts PR Review by hand on `numbers` with `options`.
async fn start(routes: &Routes, routine: &str, numbers: &[u32], options: Value) {
    routes.bench.clock.advance(1_000);
    let items: Vec<Value> = numbers.iter().map(|n| item(*n)).collect();
    let body = json!({"routineId": routine, "input": {"result": "usual", "options": options}, "items": items,
                      "door": "home"});
    let (status, answer) = routes.post("/api/runs", body).await;
    assert_eq!(status, 201, "{answer}");
}

/// The head's version row and its `depth` default.
async fn head(routes: &Routes, routine: &str) -> (Value, Value) {
    let (_, detail) = routes.get(&format!("/api/routines/{routine}")).await;
    let head = detail["head"].clone();
    let depth = head["blueprint"]["options"][0]["default"].clone();
    (head, depth)
}

#[tokio::test(flavor = "multi_thread")]
async fn three_of_four_starts_by_hand_make_the_default_and_an_undo_sticks() {
    let routes = Routes::new();
    let id = routes.bench.routine(RoutineState::Active, blueprint(3));
    let (first, _) = head(&routes, &id).await;
    start(&routes, &id, &[1], json!({"depth": "deep"})).await;
    start(&routes, &id, &[2, 3, 4], json!({"depth": "deep", "long": true})).await;
    start(&routes, &id, &[5], json!({})).await;
    let (unchanged, depth) = head(&routes, &id).await;
    assert_eq!((unchanged["id"].clone(), depth), (first["id"].clone(), json!("quick")), "a batch is one start");

    start(&routes, &id, &[6], json!({"depth": "deep"})).await;
    let (learned, depth) = head(&routes, &id).await;
    assert_eq!(depth, "deep");
    assert_eq!(learned["author"], "eos");
    assert_eq!(learned["note"], "Depth now defaults to deep: you chose it in 3 of your last 4 runs.");
    assert_eq!(learned["blueprint"]["options"][1]["default"], false, "chosen twice is not enough");

    let path = format!("/api/routines/{id}/versions/{}/restore", first["id"].as_str().expect("an id"));
    assert_eq!(routes.post(&path, json!({})).await.0, 200);
    start(&routes, &id, &[7], json!({"depth": "deep"})).await;
    let (restored, depth) = head(&routes, &id).await;
    assert_eq!((restored["author"].clone(), depth), (json!("restore"), json!("quick")), "the undo holds");
}
