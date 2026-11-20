//! A pull request routine end to end in the composed app, with fakes only: the scheduler
//! polls the source, the router admits one run, the run reaches the gate and its draft
//! waits in Needs you; ten more pages of the same pull request leave one run, the rest
//! superseded, and mark the draft stale; the pull request closed expires it; stopping
//! everything and resuming sends nothing. In a dev run nothing is polled and a match is
//! held.

use std::time::Duration;

use eos_domain::routine::run::{Reason, RunState};
use eos_runtime::http::Method;
use eos_testkit::TempHome;
use serde_json::{Value, json};

use crate::rig;
use crate::routines_rig::{
    Fakes, eventually, hand_in, inbox, make, page, pull, review_blueprint, review_doc, runs, working_agents,
};

#[tokio::test(flavor = "multi_thread")]
async fn a_pull_request_runs_once_waits_as_a_draft_goes_stale_and_expires_and_nothing_is_sent() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    fakes.source.page(page(vec![pull(7, "a1", "opened", "Fix the login")], false));

    let routine = make(&app, review_blueprint("Review the pull request.")).await;
    eventually("the scheduler polls and the router admits a run", || async { !runs(&app, &routine).await.is_empty() })
        .await;
    let first = runs(&app, &routine).await.remove(0);
    assert_eq!((first.origin.as_str(), first.item_key.as_deref()), ("trigger", Some("github:pr:acme/game#7")));
    hand_in(&app, &agents, &first.id, "Looks fine", review_doc("Looks fine."), true).await;
    eventually("the draft waits", || async { !inbox(&app).await.is_empty() }).await;
    let items = inbox(&app).await;
    let draft = &items[0];
    assert_eq!((draft["kind"].as_str(), draft["routineId"].as_str()), (Some("draft"), Some(routine.as_str())));
    let item = draft["id"].as_str().expect("an id").to_owned();
    assert_eq!(crate::routines_rig::run(&app, &first.id).await.state, RunState::WaitingForUser);

    // Ten more pages of the same pull request, each a new head, in one poll.
    for n in 0..10 {
        fakes.source.page(page(vec![pull(7, &format!("b{n}"), "updated", "Fix the login")], n < 9));
    }
    fakes.poll_again(&app);
    eventually("the ten pages are read", || async { fakes.source.requests().len() >= 2 }).await;
    eventually("every new head is decided", || async {
        runs(&app, &routine).await.len() >= 2 && signals_routed(&app, &routine).await
    })
    .await;
    let later: Vec<_> = runs(&app, &routine).await.into_iter().filter(|r| r.id != first.id).collect();
    let left: Vec<_> =
        later.iter().filter(|r| !(r.state == RunState::Skipped && r.reason == Some(Reason::Superseded))).collect();
    // Only a queued run is superseded: on a busy computer one head may start before the
    // next is read, and the one slot then keeps the rest queued until the newest wins.
    assert!(left.iter().any(|r| r.input.contains(r#""version":"b9""#)), "the newest head runs: {later:?}");
    assert!(left.len() <= 2 && left.iter().filter(|r| r.state == RunState::Queued).count() <= 1, "{later:?}");
    eventually("the draft is stale", || async { item_of(&app, &item).await["staleAt"].is_i64() }).await;
    assert_eq!(item_of(&app, &item).await["staleReason"], "10 new commits");

    fakes.source.page(page(vec![pull(7, "b9", "closed", "Fix the login")], false));
    fakes.poll_again(&app);
    eventually("the closed pull request expires the draft", || async {
        item_of(&app, &item).await["state"] == "expired"
    })
    .await;

    let (status, halted) = rig::call(&app, Method::Post, "/api/eos/halt", None).await;
    assert_eq!(status, 200, "{halted}");
    let (status, resumed) = rig::call(&app, Method::Post, "/api/eos/resume", None).await;
    assert_eq!(status, 200, "{resumed}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(fakes.channels.sent().is_empty(), "nothing went out");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dev_run_polls_nothing_and_holds_a_match() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, false);
    app.start().await.expect("starts");
    fakes.source.page(page(vec![pull(7, "a1", "opened", "Fix the login")], false));
    let mut blueprint = review_blueprint("Review the pull request.");
    blueprint["when"]["on"]
        .as_array_mut()
        .expect("triggers")
        .push(json!({"schedule": {"every": 10, "days": "all", "zone": "UTC"}}));
    let routine = make(&app, blueprint).await;
    let status = || async {
        let (code, status) = rig::call(&app, Method::Get, &format!("/api/signals/routines/{routine}"), None).await;
        assert_eq!(code, 200, "{status}");
        status
    };
    // Armed by the scheduler, not only foreseen by the route: a schedule armed after the
    // clock moved on fires from then, not for the slot it passed.
    let armed = || async {
        let id = routine.clone();
        let rows = app.store().read(move |tx| tx.signal_schedules().of_routine(&id)).await.expect("reads");
        rows.first().is_some_and(|row| row.next_at.is_some())
    };
    eventually("the scheduler arms the schedule", armed).await;
    fakes.clock.advance(11 * 60_000);
    app.woke(Duration::from_secs(0));

    // The pass that arms the schedule may fire a slot before it makes the source's row, so
    // both are waited for: the slot held, and the source's first poll settled as off.
    let held = || async {
        let status = status().await;
        status["countsToday"]["heldBack"].as_i64().unwrap_or(0) > 0 && status["sources"][0]["state"] == "off"
    };
    eventually("the slot is held and the source is off", held).await;
    let status = status().await;
    assert_eq!(status["countsToday"]["handled"], 0, "{status}");
    assert!(fakes.source.requests().is_empty(), "the source was never read");
    assert!(runs(&app, &routine).await.is_empty(), "no run");
    app.shutdown(Duration::from_secs(5)).await;
}

async fn item_of(app: &eos_app::App, id: &str) -> Value {
    let (status, item) = rig::call(app, Method::Get, &format!("/api/inbox/{id}"), None).await;
    assert_eq!(status, 200, "{item}");
    item["item"].clone()
}

/// Every signal of the routine is decided: the first page's and the ten after it.
async fn signals_routed(app: &eos_app::App, routine: &str) -> bool {
    let (status, rows) = rig::call(app, Method::Get, &format!("/api/signals?routine={routine}"), None).await;
    assert_eq!(status, 200, "{rows}");
    let rows = rows.as_array().cloned().unwrap_or_default();
    rows.len() >= 11 && rows.iter().all(|row| row["state"] == "routed")
}
