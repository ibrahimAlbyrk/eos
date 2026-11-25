//! A run that fails, a check that fails twice, a budget hit, a spent day and a missing
//! sign-in, each where the user reads it: the run view, the routine page, Home's runs and
//! Needs you.

use std::time::Duration;

use eos_app::App;
use eos_domain::worker::Usage;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use super::{by_hand, items, read};
use crate::routines_rig::{
    Fakes, call_tool, eventually, lead, make, page, pull, review_blueprint, review_doc, run, runs, working_agents,
};

/// The run view's run.
async fn shown(app: &App, run_id: &str) -> Value {
    read(app, &format!("/api/runs/{run_id}")).await["run"].clone()
}

/// The routine page's routine.
async fn routine_row(app: &App, routine: &str) -> Value {
    read(app, &format!("/api/routines/{routine}")).await["routine"].clone()
}

/// Waits until the run ends failed, and gives its row as the run view shows it.
async fn failed(app: &App, run_id: &str) -> Value {
    eventually("the run fails", || async { run(app, run_id).await.state.as_str() == "failed" }).await;
    shown(app, run_id).await
}

/// What a session's model cost, as the session service books and announces it.
async fn spends(app: &App, worker_id: &str, usd: f64) {
    let worker = worker_id.to_owned();
    let store = app.store();
    let booked = store.write(move |tx, out| {
        tx.workers().add_usage(&worker, &Usage { cost_usd: usd, ..Usage::default() })?;
        out.push("usage:recorded", &json!({"workerId": worker, "deltaCost": usd}));
        Ok(())
    });
    booked.await.expect("books");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_run_shows_in_the_run_view_the_routine_page_and_home_and_three_pause_it_with_an_alert() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let routine = make(&app, review_blueprint("Review the pull request.")).await;

    let mut ended = Vec::new();
    for n in 1..=3 {
        let run_id = by_hand(&app, &routine, n).await;
        let lead_id = lead(&app, &agents, &run_id).await;
        let reply = call_tool(&app, &agents, &lead_id, "report_failure", json!({"reason": "The diff is gone."})).await;
        assert!(!reply.is_error, "{}", reply.text);
        let row = failed(&app, &run_id).await;
        assert_eq!((row["reason"].as_str(), row["headline"].as_str()), (Some("reported"), Some("The diff is gone.")));
        ended.push(run_id);
    }
    let page = routine_row(&app, &routine).await;
    assert_eq!(page["lastRun"]["id"], ended[2], "the routine page shows its last run: {page}");
    assert_eq!(page["lastRun"]["state"], "failed");
    let home_runs = read(&app, "/api/runs?limit=200").await;
    let listed = home_runs["runs"].as_array().cloned().unwrap_or_default();
    assert!(
        ended
            .iter()
            .all(|id| listed.iter().any(|r| r["id"] == **id && r["state"] == "failed" && r["endedAt"].is_i64())),
        "Home's away list reads each failed run: {home_runs}"
    );

    assert_eq!((page["state"].as_str(), page["pausedReason"].as_str()), (Some("paused"), Some("failures")));
    let alerts = items(&app, "routine_alert").await;
    assert_eq!(alerts.len(), 1, "{alerts:?}");
    assert_eq!(alerts[0]["item"]["routineId"], routine.as_str());
    assert_eq!(alerts[0]["payload"]["reason"], "failures");
    app.shutdown(Duration::from_secs(5)).await;
}

/// The lead of `run_id` hands in a review; the checker's verdict on it.
async fn checked(app: &App, agents: &ScriptedRuntime, lead_id: &str, pass: bool) {
    let checkers =
        || agents.started().into_iter().filter(|s| s.worker_definition.as_deref() == Some("eos-run-checker"));
    let before = checkers().count();
    let result = json!({"kind": "github.review", "headline": "A review", "body": review_doc("Fine.")});
    let reply = call_tool(app, agents, lead_id, "submit_result", result).await;
    assert!(!reply.is_error, "{}", reply.text);
    eventually("a checker starts", || async { checkers().count() > before }).await;
    let checker = checkers().next_back().expect("a checker").worker_id;
    let verdict = match pass {
        true => json!({"pass": true, "checks": [], "mustFix": []}),
        false => json!({"pass": false, "checks": [{"key": "tone", "ok": false, "note": "n"}], "mustFix": ["Say why."]}),
    };
    let reply = call_tool(app, agents, &checker, "submit_verdict", verdict).await;
    assert!(!reply.is_error, "{}", reply.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_twice_failed_check_and_a_spent_budget_name_their_reason_in_the_run_view() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let routine = make(&app, review_blueprint("Review the pull request.")).await;

    let twice = by_hand(&app, &routine, 1).await;
    let lead_id = lead(&app, &agents, &twice).await;
    checked(&app, &agents, &lead_id, false).await;
    checked(&app, &agents, &lead_id, false).await;
    assert_eq!(failed(&app, &twice).await["reason"], "check_failed");

    let spent = by_hand(&app, &routine, 2).await;
    let lead_id = lead(&app, &agents, &spent).await;
    spends(&app, &lead_id, 3.0).await;
    assert_eq!(failed(&app, &spent).await["reason"], "budget_run");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_from_a_trigger_on_a_spent_day_is_skipped_with_one_notice() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let routine = make(&app, review_blueprint("Review the pull request.")).await;
    let spent = by_hand(&app, &routine, 1).await;
    let lead_id = lead(&app, &agents, &spent).await;
    spends(&app, &lead_id, 21.0).await;
    failed(&app, &spent).await;

    fakes.source.page(page(vec![pull(7, "a1", "opened", "Fix the login")], false));
    fakes.poll_again(&app);
    eventually("the trigger's run is skipped", || async {
        runs(&app, &routine).await.iter().any(|r| r.state.as_str() == "skipped")
    })
    .await;
    let skipped = runs(&app, &routine).await.into_iter().find(|r| r.state.as_str() == "skipped").expect("a run");
    assert_eq!(shown(&app, &skipped.id).await["reason"], "day_cap");
    eventually("a notice says the day is spent", || async { !day_cap(&app).await.is_empty() }).await;
    assert_eq!(day_cap(&app).await.len(), 1);
    app.shutdown(Duration::from_secs(5)).await;
}

async fn day_cap(app: &App) -> Vec<Value> {
    let notices = items(app, "notice").await;
    notices.into_iter().filter(|n| n["item"]["title"].as_str().is_some_and(|t| t.contains("budget"))).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_sign_in_runs_fail_at_once_and_three_pause_the_routine_with_a_sign_in_item() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let mut options = fakes.options(home.path(), &agents, true);
    options.agents.credential = None;
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");
    let routine = make(&app, review_blueprint("Review the pull request.")).await;

    for n in 1..=3 {
        let run_id = by_hand(&app, &routine, n).await;
        let row = failed(&app, &run_id).await;
        assert_eq!(row["reason"], "no_credential", "{row}");
        assert!(row["headline"].as_str().is_some_and(|h| h.contains("Settings › Accounts")), "{row}");
    }
    assert!(agents.started().is_empty(), "no session started");
    let page = routine_row(&app, &routine).await;
    assert_eq!((page["state"].as_str(), page["pausedReason"].as_str()), (Some("paused"), Some("sign_in")));
    let alerts = items(&app, "routine_alert").await;
    assert_eq!(alerts.len(), 1, "{alerts:?}");
    assert_eq!(alerts[0]["payload"]["reason"], "sign_in");
    app.shutdown(Duration::from_secs(5)).await;
}
