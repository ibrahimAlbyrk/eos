//! The model's stage of Which: a signal whose rules pass for a routine that
//! asks is settled by the small model's yes or no, the answer kept for the
//! subject, its spend booked as `match`; facts missing, the day's asks used
//! up, no credential, or outside the installed app leave it undecided, and
//! a day later it is unsorted.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::agent::{OneShotAnswer, OneShotError};
use eos_core::routine::RoutineTriggers;
use eos_domain::worker::Usage;
use eos_mod_signals::{ASKS_PER_DAY, SignalsModule, UNSORTED_AFTER_MS};
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::rig::{Bench, SOURCE_ID, SavedIntake, page, pull, routine};

const QUESTION: &str = "Is it about networking?";

fn asking(rule: Value) -> RoutineTriggers {
    let mut asking = routine("rt-a", RoutineState::Active, &["opened"], Some(rule));
    asking.which.ask = Some(QUESTION.into());
    asking
}

fn passing() -> RoutineTriggers {
    asking(json!({ "fact": "draft", "is": false }))
}

/// `(decision, reason, model asked)` of each route, in order.
fn decisions(bench: &Bench) -> Vec<(String, Option<String>, bool)> {
    let routes = bench.temp.store.read_blocking(|tx| {
        let mut all = Vec::new();
        for id in 1..=20 {
            all.extend(tx.signal_routes().by_signal(id)?);
        }
        Ok(all)
    });
    let routes = routes.expect("reads");
    routes.into_iter().map(|route| (route.decision.as_str().to_owned(), route.reason, route.model_asked)).collect()
}

fn says(matches: bool) -> OneShotAnswer {
    let usage = Usage { tokens_in: 1_000_000, ..Usage::default() };
    OneShotAnswer { structured: Some(json!({ "matches": matches })), usage: Some(usage), ..OneShotAnswer::default() }
}

async fn started(bench: &Bench, autostart: bool) -> SignalsModule {
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), autostart);
    module.after_ready().await.expect("ready");
    module
}

async fn keep(module: &SignalsModule, n: u64, sha: &str) {
    let item = pull(n, sha, "opened", false, &["src/net.rs"]);
    module.ingest(SOURCE_ID, page(vec![item], json!({}))).await.expect("kept");
}

/// Starts another routing pass, and with it the model's stage.
async fn again(bench: &Bench) {
    bench.until(|| bench.sleeper.wake()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_yes_runs_it_a_no_leaves_it_unmatched_and_the_answer_is_kept_for_the_subject() {
    let bench = Bench::new(vec![passing()]);
    bench.model.answer(says(true)).answer(says(false));
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.until(|| bench.decided("run") == 1).await;
    assert_eq!(decisions(&bench), [("run".into(), None, true)]);

    let asked = bench.model.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].model.as_deref(), Some("haiku"));
    assert!(asked[0].prompt.contains(QUESTION));
    assert!(
        asked[0]
            .prompt
            .contains("<untrusted source=\"github:pr:acme/game#1\">repo: acme/game\npaths: src/net.rs</untrusted>"),
        "{}",
        asked[0].prompt
    );
    let spent = bench.temp.count("SELECT count FROM routine_spend WHERE routine_id = 'rt-a' AND kind = 'match'");
    assert_eq!(spent, 1, "the ask's spend is booked");
    let cost = bench.temp.count("SELECT CAST(cost_usd AS INTEGER) FROM routine_spend WHERE kind = 'match'");
    assert_eq!(cost, 1, "a million tokens in at a dollar");

    keep(&module, 1, "def").await;
    bench.until(|| bench.decided("run") == 2).await;
    assert_eq!(bench.model.asked().len(), 1, "the same subject's answer is kept");
    assert_eq!(decisions(&bench)[1], ("run".into(), None, false));

    keep(&module, 2, "abc").await;
    bench.until(|| bench.decided("unmatched") == 1).await;
    assert_eq!(decisions(&bench)[2], ("unmatched".into(), Some("ask".into()), true));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_facts_or_the_days_asks_used_up_leave_it_undecided_until_it_is_unsorted() {
    let bench = Bench::new(vec![asking(json!({ "fact": "size", "gte": 1 }))]);
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.until(|| bench.decided("undecided") == 1).await;
    assert_eq!(decisions(&bench), [("undecided".into(), Some("missing".into()), false)]);
    module.stop().await;

    let bench = Bench::new(vec![passing()]);
    bench.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {ASKS_PER_DAY}) \
         INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, model_asked, decided_at) \
         SELECT 1000 + i, 'rt-a', 'rv-rt-a', 'unmatched', 1, 5000 FROM n"
    ));
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.until(|| decisions(&bench).first().is_some_and(|route| route.1.as_deref() == Some("cap"))).await;
    assert!(bench.model.asked().is_empty(), "the day's asks are used up");

    bench.clock.advance(UNSORTED_AFTER_MS);
    again(&bench).await;
    bench.until(|| bench.decided("unsorted") == 1).await;
    assert!(bench.model.asked().is_empty());
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_credential_it_waits_and_is_asked_again_later() {
    let bench = Bench::new(vec![passing()]);
    bench.model.fail(OneShotError::NoCredential).answer(says(true));
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.model.until_asked(1).await;
    assert_eq!(bench.decided("undecided"), 1);
    again(&bench).await;
    bench.until(|| bench.decided("run") == 1).await;
    assert_eq!(bench.temp.count("SELECT count(*) FROM routine_spend WHERE kind = 'match'"), 1, "one answered ask");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_the_installed_app_the_model_is_never_asked() {
    let bench = Bench::new(vec![passing()]);
    let module = started(&bench, false).await;
    keep(&module, 1, "abc").await;
    bench.until(|| bench.decided("undecided") == 1).await;
    assert_eq!(decisions(&bench), [("undecided".into(), Some("dev-run".into()), false)]);
    again(&bench).await;
    again(&bench).await;
    assert!(bench.model.asked().is_empty());
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_past_its_asks_for_the_day_does_not_keep_another_from_the_model() {
    let mut other = passing();
    other.id = "rt-b".into();
    other.version = "rv-rt-b".into();
    let bench = Bench::new(vec![passing(), other]);
    bench.model.answer(says(true));
    // rt-a used its asks today, and a pass's worth of its decisions wait from before.
    bench.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {ASKS_PER_DAY}) \
         INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, model_asked, decided_at) \
         SELECT 1000 + i, 'rt-a', 'rv-rt-a', 'unmatched', 1, 5000 FROM n"
    ));
    bench.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) \
         INSERT INTO signals (id, source_id, key, subject, version, kind, occurred_at, received_at, item_json, state) \
         SELECT 2000 + i, '{SOURCE_ID}', 'github:pr:acme/game#' || i || '@a', 'github:pr:acme/game#' || i, 'a', \
         'opened', 1000, 5000, 'null', 'routed' FROM n"
    ));
    bench.temp.exec(
        "INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, reason, model_asked, decided_at) \
         SELECT id, 'rt-a', 'rv-rt-a', 'undecided', 'ask', 0, 5000 FROM signals WHERE id > 2000",
    );
    let module = started(&bench, true).await;
    keep(&module, 900, "abc").await;
    bench
        .until(|| {
            bench.sleeper.wake();
            !bench.model.asked().is_empty()
        })
        .await;
    assert!(bench.model.asked()[0].prompt.contains("github:pr:acme/game#900"), "rt-b's signal is asked about");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn two_asks_at_once_never_pass_the_days_asks_together() {
    let bench = Bench::new(vec![passing()]);
    bench.model.answer(says(true)).answer(says(true));
    bench.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {}) \
         INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, model_asked, decided_at) \
         SELECT 1000 + i, 'rt-a', 'rv-rt-a', 'unmatched', 1, 5000 FROM n",
        ASKS_PER_DAY - 1
    ));
    let module = started(&bench, true).await;
    let items =
        vec![pull(1, "abc", "opened", false, &["src/net.rs"]), pull(2, "abc", "opened", false, &["src/net.rs"])];
    module.ingest(SOURCE_ID, page(items, json!({}))).await.expect("kept");
    bench.until(|| bench.decided("run") == 1).await;
    bench.until(|| decisions(&bench).iter().any(|route| route.1.as_deref() == Some("cap"))).await;
    assert_eq!(bench.model.asked().len(), 1, "the last ask of the day is asked once");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_that_comes_after_eos_was_stopped_is_still_booked_as_spent() {
    let bench = Bench::new(vec![passing()]);
    let release = bench.model.hold();
    bench.model.answer(says(true));
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.model.until_asked(1).await;
    bench.temp.exec("INSERT INTO inbox_halt (id, \"on\", since, by, updated_at) VALUES (1, 1, 1, 'dashboard', 1)");
    release.notify_one();
    bench.until(|| bench.temp.count("SELECT count(*) FROM routine_spend WHERE kind = 'match'") == 1).await;
    assert_eq!(bench.decided("run"), 0, "nothing starts while Eos is stopped");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_answer_does_not_hold_up_routing() {
    let mut plain = routine("rt-b", RoutineState::Active, &["opened"], None);
    plain.version = "rv-rt-b".into();
    let bench = Bench::new(vec![passing(), plain]);
    let release = bench.model.hold();
    bench.model.answer(says(true));
    let module = started(&bench, true).await;
    keep(&module, 1, "abc").await;
    bench.model.until_asked(1).await;
    let draft = pull(2, "abc", "opened", true, &["src/net.rs"]);
    module.ingest(SOURCE_ID, page(vec![draft], json!({}))).await.expect("kept");
    bench.until(|| bench.decided("run") == 2).await;
    assert_eq!(bench.decided("undecided"), 1, "the first still waits for the model");
    release.notify_one();
    bench.until(|| bench.decided("run") == 3).await;
    module.stop().await;
}
