//! What a sentence typed at Home asks for: the rules over the user's
//! routines and the items they recognise, the small model's read when the
//! rules are not sure (sure, unsure, too slow, the day's reads used up),
//! its spend, and who may ask.

use eos_contracts::RoutineState;
use eos_core::Clock;
use eos_core::agent::{OneShotAnswer, OneShotError};
use eos_core::capability::ItemRecogniser;
use eos_domain::routine::limits::day_key;
use eos_domain::worker::Usage;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};
use crate::run_routes::Routes;

const NUMBER: &str = r"(?:^|\s)#(\d+)\b";

/// A PR Review routine, alias `review`, whose pull requests are recognised.
fn routes() -> (Routes, String) {
    let reads = FakeCapabilityReads::new().recognising(ItemRecogniser {
        kind: "github.pull_request".into(),
        noun: "pull request".into(),
        patterns: vec![NUMBER.into()],
    });
    let routes = Routes::over(Bench::with_reads(true, reads));
    let mut shape = blueprint(1);
    shape["aliases"] = json!(["review"]);
    let id = routes.bench.routine(RoutineState::Active, shape);
    (routes, id)
}

fn asked(text: &str, seq: i64) -> Value {
    json!({ "text": text, "attachments": [], "seq": seq })
}

/// Today's `intent` spend: (reads, routine ids).
fn intent_spend(routes: &Routes) -> (i64, Vec<String>) {
    let day = day_key(routes.bench.clock.now_ms(), 180);
    let rows = routes.bench.temp.store.read_blocking(move |tx| tx.routine_spend().of_day(&day)).expect("reads");
    let rows: Vec<_> = rows.into_iter().filter(|row| row.kind == "intent").collect();
    (rows.iter().map(|row| row.count).sum(), rows.into_iter().map(|row| row.routine_id).collect())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rules_answer_with_the_routine_its_item_and_the_seq() {
    let (routes, id) = routes();
    let (status, answer) = routes.post("/api/routines/intent", asked("review #470", 7)).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["intent"], "run");
    assert_eq!(answer["certain"], true);
    assert_eq!(answer["routineId"], json!(id));
    assert_eq!(answer["item"], json!({ "kind": "github.pull_request", "text": "#470", "untrusted": false }));
    assert_eq!(answer["line"], "Run PR Review on #470");
    assert_eq!((answer["source"].clone(), answer["seq"].clone()), (json!("rules"), json!(7)));

    let (_, answer) = routes.post("/api/routines/intent", asked("every morning list my meetings", 8)).await;
    assert_eq!((answer["intent"].clone(), answer["seq"].clone()), (json!("make"), json!(8)));
    let (_, answer) = routes.post("/api/routines/intent", asked("tidy the repo", 9)).await;
    assert_eq!((answer["intent"].clone(), answer["certain"].clone()), (json!("unsure"), json!(false)));
    assert_eq!(answer["alternatives"].as_array().map(Vec::len), Some(2), "make, then once");
    assert!(routes.bench.model.asked().is_empty(), "the rules never ask the model");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_model_answers_when_sure_and_its_read_is_booked() {
    let (routes, id) = routes();
    let usage = Usage { tokens_in: 1_000, tokens_out: 50, ..Usage::default() };
    let data =
        json!({ "intent": "run", "routineId": id, "item": "#12", "confidence": 0.9, "line": "Run PR Review on #12" });
    routes.bench.model.answer(OneShotAnswer { structured: Some(data), usage: Some(usage), ..OneShotAnswer::default() });
    let (status, answer) = routes.post("/api/routines/intent/model", asked("the twelfth one please", 3)).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!((answer["intent"].clone(), answer["certain"].clone()), (json!("run"), json!(true)));
    assert_eq!((answer["source"].clone(), answer["seq"].clone()), (json!("model"), json!(3)));
    assert_eq!(answer["item"]["text"], "#12");
    let asked_model = routes.bench.model.asked();
    assert_eq!(asked_model[0].model.as_deref(), Some("haiku"));
    assert!(asked_model[0].prompt.contains("the twelfth one please") && asked_model[0].prompt.contains(&id));
    assert!(asked_model[0].schema.is_some());
    assert_eq!(intent_spend(&routes), (1, vec![id]));
}

#[tokio::test(flavor = "multi_thread")]
async fn below_seven_tenths_the_model_gives_choices() {
    let (routes, id) = routes();
    let data = json!({
        "intent": "run", "routineId": id, "confidence": 0.4, "line": "Run PR Review",
        "choices": [
            { "intent": "run", "routineId": id, "line": "Run PR Review" },
            { "intent": "change", "routineId": "rt-nobody", "line": "Change a routine you lack" },
            { "intent": "once", "line": "Do it once" },
        ],
    });
    routes.bench.model.data(data);
    let (_, answer) = routes.post("/api/routines/intent/model", asked("hmm the pr thing", 4)).await;
    assert_eq!((answer["intent"].clone(), answer["certain"].clone()), (json!("unsure"), json!(false)));
    let intents: Vec<&str> = answer["alternatives"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|choice| choice["intent"].as_str())
        .collect();
    assert_eq!(intents, ["run", "once"], "a choice of a routine the user lacks is left out");
    assert_eq!(intent_spend(&routes), (1, vec![String::new()]), "a read that names no routine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_or_failed_model_leaves_the_rules_choices() {
    let (routes, _) = routes();
    routes.bench.model.fail(OneShotError::TimedOut(std::time::Duration::from_secs(4)));
    let (status, answer) = routes.post("/api/routines/intent/model", asked("tidy the repo", 5)).await;
    assert_eq!(status, 200);
    assert_eq!((answer["intent"].clone(), answer["source"].clone()), (json!("unsure"), json!("rules")));
    assert_eq!(answer["seq"], 5);
    assert_eq!(intent_spend(&routes).0, 1, "the read counts");
}

#[tokio::test(flavor = "multi_thread")]
async fn past_three_hundred_reads_a_day_the_rules_answer_without_the_model() {
    let (routes, _) = routes();
    let day = day_key(routes.bench.clock.now_ms(), 180);
    routes
        .bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            for _ in 0..300 {
                tx.routine_spend().add(&day, "", "intent", 0.001)?;
            }
            Ok(())
        })
        .expect("books");
    routes.bench.model.data(json!({ "intent": "once", "confidence": 1, "line": "Do it once" }));
    let (_, answer) = routes.post("/api/routines/intent/model", asked("tidy the repo", 6)).await;
    assert_eq!((answer["source"].clone(), answer["seq"].clone()), (json!("rules"), json!(6)));
    assert!(routes.bench.model.asked().is_empty(), "the model is not asked");
    assert_eq!(intent_spend(&routes).0, 300);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_users_dashboard_reads_a_sentence() {
    let (routes, _) = routes();
    for path in ["/api/routines/intent", "/api/routines/intent/model"] {
        let status = routes.call(Method::Post, Caller::UNTRUSTED, path, Some(asked("x", 1))).await.0;
        assert_eq!(status, 403, "{path}");
        let phone = Caller::Phone { grant: Tier::High, mutate: true };
        assert_eq!(routes.call(Method::Post, phone, path, Some(asked("x", 1))).await.0, 403, "{path}");
    }
    let too_long = asked(&"x".repeat(2_001), 1);
    assert_eq!(routes.post("/api/routines/intent", too_long).await.0, 400);
}
