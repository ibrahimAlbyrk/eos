//! "Stop everything": the switch freezes every send that has not gone out
//! and the claim takes nothing; resume asks the user about each frozen send
//! and sends nothing by itself; a send frozen by a development run is left.

use eos_contracts::{HaltState, InboxAnswer, ProblemChoice};
use eos_core::Clock;
use eos_domain::inbox::ItemKind;
use eos_inbox::HALTED;

use crate::delivery::Sender;

#[tokio::test]
async fn halt_freezes_what_has_not_gone_out_and_resume_asks_about_each_without_sending() {
    let sender = Sender::new();
    let now = sender.rig.clock.now_ms();
    sender.queue("dl-holding", "github", "pr", "holding", "auto", now + 10_000).await;
    sender.queue("dl-queued", "github", "boss", "queued", "auto", now).await;
    sender.queue("dl-out", "github", "me", "sending", "auto", now).await;
    sender.queue("dl-dev", "github", "other", "frozen", "auto", now).await;
    sender.rig.temp.exec("UPDATE inbox_deliveries SET last_error_kind = 'dev_run' WHERE id = 'dl-dev'");

    let on = sender.rig.items.halt("phone").await.expect("halted");
    assert_eq!(on, HaltState { on: true, since: Some(now) });
    assert_eq!(sender.rig.items.halt_state().await.expect("reads"), on);
    for id in ["dl-holding", "dl-queued"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("frozen", Some(HALTED)), "{id}");
    }
    assert_eq!(sender.row("dl-out").await.state, "sending", "a send on its way finishes");
    sender.rig.clock.advance(60_000);
    sender.pass().await;
    assert!(sender.sent().is_empty());

    let off = sender.rig.items.resume("dashboard").await.expect("resumed");
    assert_eq!(off, HaltState { on: false, since: None });
    sender.pass().await;
    assert!(sender.sent().is_empty(), "nothing goes by itself");
    for id in ["dl-holding", "dl-queued"] {
        let row = sender.row(id).await;
        assert_eq!((row.state.as_str(), row.last_error_kind.as_deref()), ("failed", Some(HALTED)), "{id}");
    }
    let dev = sender.row("dl-dev").await;
    assert_eq!((dev.state.as_str(), dev.last_error_kind.as_deref()), ("frozen", Some("dev_run")));
    let problems = sender.problems().await;
    assert_eq!(problems.len(), 2);
    for (payload, summary) in &problems {
        assert_eq!(summary, "Held when you stopped Eos. Send now?");
        assert_eq!(payload["errorKind"], "internal");
    }

    // Send now goes as any delivery problem's retry does.
    let items = sender.rig.temp.port().read(|tx| tx.inbox_items().waiting(10)).await.expect("reads");
    let problem = items.iter().find(|item| item.kind == ItemKind::DeliveryProblem).expect("a problem");
    let retry = InboxAnswer::DeliveryProblem { choice: ProblemChoice::Retry, doc: None };
    sender.rig.items.answer(&problem.id, problem.rev, &retry, "dashboard").await.expect("answered");
    sender.pass().await;
    assert_eq!(sender.sent().len(), 1);
}

#[tokio::test]
async fn switching_it_twice_changes_nothing_the_second_time() {
    let sender = Sender::new();
    let first = sender.rig.items.halt("dashboard").await.expect("halted");
    sender.rig.clock.advance(5_000);
    assert_eq!(sender.rig.items.halt("phone").await.expect("halted again"), first, "since stays");
    sender.rig.items.resume("dashboard").await.expect("resumed");
    assert_eq!(sender.rig.items.resume("dashboard").await.expect("still off"), HaltState { on: false, since: None });
}
