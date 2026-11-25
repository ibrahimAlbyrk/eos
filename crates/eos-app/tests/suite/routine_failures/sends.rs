//! A send that failed, or that may have gone out through a channel that cannot tell, interrupts in Needs you as a
//! `delivery_problem` that names what went wrong.

use std::time::Duration;

use eos_app::App;
use eos_contracts::ActionClass;
use eos_core::delivery::{ChannelTraits, Idempotency, SendError, SendErrorKind, Undo};
use eos_runtime::http::Method;
use eos_testkit::{FakeChannels, TempHome};
use serde_json::{Value, json};

use super::{by_hand, items};
use crate::rig;
use crate::routines_rig::{Fakes, eventually, hand_in, inbox, make, review_blueprint, review_doc, working_agents};

/// A review held as a draft, then sent by the user while its channel, which keeps its sends
/// apart by `idempotency`, answers `kind`.
async fn sent_into(kind: SendErrorKind, idempotency: Idempotency) -> (TempHome, App, Value) {
    let (home, agents, mut fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let traits = ChannelTraits {
        class: ActionClass::Speak,
        idempotency,
        undo: Undo::Partial,
        undo_window_ms: 0,
        max_bytes: 65_536,
    };
    fakes.channels = FakeChannels::new().with("github", traits);
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let routine = make(&app, review_blueprint("Review the pull request.")).await;
    let run_id = by_hand(&app, &routine, 1).await;
    hand_in(&app, &agents, &run_id, "Looks fine", review_doc("Looks fine."), true).await;
    eventually("the draft waits", || async { !inbox(&app).await.is_empty() }).await;
    let draft = inbox(&app).await.remove(0);
    let (id, rev) = (draft["id"].as_str().expect("an id"), draft["rev"].as_i64().expect("a revision"));

    for _ in 0..8 {
        fakes.channels.script(Err(SendError { kind, detail_kind: "http_500".into() }));
    }
    let body = json!({"rev": rev, "doc": review_doc("Looks fine.")});
    let (status, sent) = rig::call(&app, Method::Post, &format!("/api/inbox/{id}/send"), Some(body)).await;
    assert_eq!(status, 200, "{sent}");
    eventually("the send is tried", || async { !fakes.channels.sent().is_empty() }).await;
    eventually("a delivery problem waits", || async { !items(&app, "delivery_problem").await.is_empty() }).await;
    let problems = items(&app, "delivery_problem").await;
    assert_eq!(problems.len(), 1, "{problems:?}");
    let problem = problems[0].clone();
    assert_eq!(problem["item"]["runId"], run_id.as_str());
    (home, app, problem)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_that_failed_interrupts_as_a_delivery_problem() {
    let (_home, app, problem) = sent_into(SendErrorKind::Permanent, Idempotency::Marker).await;
    assert_eq!(problem["item"]["attention"], "interrupt", "{problem}");
    assert_eq!(problem["item"]["summary"], "It could not be sent.", "{problem}");
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_that_may_have_gone_out_interrupts_as_a_delivery_problem() {
    let (_home, app, problem) = sent_into(SendErrorKind::Uncertain, Idempotency::None).await;
    assert_eq!(problem["item"]["attention"], "interrupt", "{problem}");
    assert!(problem["item"]["summary"].as_str().is_some_and(|s| s.ends_with("Did it go out?")), "{problem}");
    app.shutdown(Duration::from_secs(5)).await;
}
