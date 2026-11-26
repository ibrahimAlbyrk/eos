//! A run that fails and a missing sign-in, each where the user reads it:
//! the run view, the routine page, Home's runs and Needs you.

use std::time::Duration;

use eos_app::App;
use eos_testkit::TempHome;
use serde_json::{Value, json};

use super::{by_hand, items, read};
use crate::routines_rig::{Fakes, call_tool, eventually, lead, make, review_blueprint, run, working_agents};

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
