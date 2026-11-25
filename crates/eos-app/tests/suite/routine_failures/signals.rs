//! A source that stops working or is gone, a capability that broke, a schedule that ran late
//! and more items than a routine may run, each where the user reads it: the routine page's
//! source and schedule lines and Needs you.

use std::sync::Arc;
use std::time::Duration;

use eos_app::App;
use eos_core::signals::SourceError;
use eos_testkit::{FakeCapabilitySecrets, FakeGitHub, ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use super::{items, read};
use crate::planted::sign_in_to_github;
use crate::routines_rig::{Fakes, eventually, make, page, pull, review_blueprint, runs, working_agents};

/// The routine page's trigger lines.
async fn triggers(app: &App, routine: &str) -> Value {
    read(app, &format!("/api/signals/routines/{routine}")).await
}

/// The app signed in to GitHub, and a review of pull requests that needs it.
async fn signed_in(fakes: &Fakes, home: &TempHome, agents: &ScriptedRuntime) -> (App, String) {
    let github = Arc::new(FakeGitHub::new());
    github.set_device_interval(1);
    github.device_answers(vec![FakeGitHub::granted()]);
    let mut options = fakes.options(home.path(), agents, true);
    options.capabilities.github = Some(github);
    options.capabilities.secrets = Some(Arc::new(FakeCapabilitySecrets::new()));
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");
    assert_eq!(sign_in_to_github(&app).await["state"], "signed_in");
    let mut blueprint = review_blueprint("Review the pull request.");
    blueprint["needs"] = json!(["github"]);
    let routine = make(&app, blueprint).await;
    eventually("the source is read once", || async { !fakes.source.requests().is_empty() }).await;
    (app, routine)
}

async fn routine_row(app: &App, routine: &str) -> Value {
    read(app, &format!("/api/routines/{routine}")).await["routine"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_whose_sign_in_stopped_working_shows_on_its_line_and_its_capability_s_item_pauses_the_routine() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let (app, routine) = signed_in(&fakes, &home, &agents).await;

    fakes.source.fail(SourceError::Unauthorized);
    fakes.poll_again(&app);
    eventually("the source line says so", || async {
        triggers(&app, &routine).await["sources"][0]["errorKind"] == "unauthorized"
    })
    .await;

    eventually("the capability's item opens", || async { !items(&app, "capability_attention").await.is_empty() }).await;
    let attention = items(&app, "capability_attention").await;
    assert_eq!(attention.len(), 1, "one item for the capability: {attention:?}");
    eventually("the routine that needs it pauses", || async { routine_row(&app, &routine).await["state"] == "paused" })
        .await;
    assert_eq!(routine_row(&app, &routine).await["pausedReason"], "capability:github");
    let line = triggers(&app, &routine).await["sources"][0].clone();
    assert_eq!(line["errorKind"], "unauthorized", "the line still says why: {line}");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_whose_repository_is_gone_says_so_on_its_line() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let (app, routine) = signed_in(&fakes, &home, &agents).await;

    fakes.source.fail(SourceError::Gone);
    fakes.poll_again(&app);
    eventually("the source line says it is gone", || async {
        triggers(&app, &routine).await["sources"][0]["errorKind"] == "gone"
    })
    .await;
    eventually("the capability's item opens", || async { !items(&app, "capability_attention").await.is_empty() }).await;
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_that_ran_over_half_an_hour_late_shows_on_its_line_and_offers_to_keep_the_mac_awake() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let mut blueprint = review_blueprint("Review the pull request.");
    let hourly = json!({"schedule": {"every": 60, "days": "all", "zone": "UTC"}});
    blueprint["when"]["on"].as_array_mut().expect("triggers").push(hourly);
    let routine = make(&app, blueprint).await;
    let next_at = || async { triggers(&app, &routine).await["schedules"][0]["nextAt"].as_i64() };
    eventually("the schedule is armed", || async { next_at().await.is_some() }).await;

    // The Mac slept through the slot and woke 40 minutes after it.
    let slot = next_at().await.expect("a slot");
    fakes.clock.set(slot + 40 * 60_000);
    app.woke(Duration::from_secs(0));
    eventually("the slot fires late", || async {
        triggers(&app, &routine).await["schedules"][0]["lastAt"].as_i64() == Some(slot)
    })
    .await;
    let line = triggers(&app, &routine).await["schedules"][0].clone();
    assert!(line["lateByMs"].as_i64().is_some_and(|late| late >= 30 * 60_000), "{line}");
    eventually("one notice offers to keep the Mac awake", || async { !late_notices(&app).await.is_empty() }).await;
    let offer = late_notices(&app).await.remove(0);
    assert!(offer["item"]["title"].as_str().is_some_and(|t| t.contains("40 min late")), "{offer}");
    app.shutdown(Duration::from_secs(5)).await;
}

async fn late_notices(app: &App) -> Vec<Value> {
    let notices = items(app, "notice").await;
    notices.into_iter().filter(|n| n["item"]["title"].as_str().is_some_and(|t| t.contains("late"))).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn more_items_than_a_routine_may_run_open_one_notice_for_the_day() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let mut blueprint = review_blueprint("Review the pull request.");
    blueprint["when"]["limits"] = json!({"perHour": 1, "queued": 1});
    let routine = make(&app, blueprint).await;
    let pulls = (1..=4).map(|n| pull(n, &format!("s{n}"), "opened", "A change")).collect();
    fakes.source.page(page(pulls, false));
    fakes.poll_again(&app);
    eventually("one run is admitted", || async { !runs(&app, &routine).await.is_empty() }).await;
    eventually("a notice says what waits", || async { !over_limit(&app).await.is_empty() }).await;

    let read_before = fakes.source.requests().len();
    fakes.source.page(page(vec![pull(5, "s5", "opened", "Another")], false));
    fakes.poll_again(&app);
    eventually("the fifth is read", || async { fakes.source.requests().len() > read_before }).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(over_limit(&app).await.len(), 1, "one notice for the day");
    assert_eq!(runs(&app, &routine).await.len(), 1, "the rest wait");
    app.shutdown(Duration::from_secs(5)).await;
}

async fn over_limit(app: &App) -> Vec<Value> {
    let notices = items(app, "notice").await;
    notices.into_iter().filter(|n| n["item"]["title"].as_str().is_some_and(|t| t.contains("more items"))).collect()
}
