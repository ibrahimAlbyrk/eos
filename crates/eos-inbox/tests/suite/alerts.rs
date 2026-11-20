//! A routine's alert answered: Resume resumes the routine through its
//! control, refused while too many results still wait; Keep paused leaves
//! it paused.

use eos_contracts::{AlertChoice, InboxAnswer, NoticeChoice};
use eos_core::store::StoredItem;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::{Error, ROUTINE_CAP, TOO_MANY_WAITING};
use eos_testkit::ControlCall;
use serde_json::json;

use crate::rig::{Rig, new_item};

fn answer(choice: AlertChoice) -> InboxAnswer {
    InboxAnswer::RoutineAlert { choice }
}

fn resumed(reason: &str) -> ControlCall {
    ControlCall::Resume { routine_id: "rt-1".into(), reason: reason.into() }
}

async fn alert(rig: &Rig, reason: &str) -> StoredItem {
    let mut new = new_item(ItemKind::RoutineAlert, Some(reason));
    new.payload = json!({ "reason": reason });
    rig.open(new).await
}

#[tokio::test]
async fn resume_on_a_refused_target_alert_resumes_the_routine_and_closes_the_alert() {
    let rig = Rig::new();
    let item = alert(&rig, "target_refused").await;
    rig.items.answer(&item.id, 1, &answer(AlertChoice::Resume), "dashboard").await.expect("answers");
    assert_eq!(rig.control.calls(), [resumed("target_refused")]);
    let item = rig.find(&item.id).await;
    assert_eq!((item.state, item.consumed_at.is_some()), (ItemState::Answered, true));
}

#[tokio::test]
async fn keep_paused_closes_the_alert_and_leaves_the_routine_paused() {
    let rig = Rig::new();
    let item = alert(&rig, "target_refused").await;
    rig.items.answer(&item.id, 1, &answer(AlertChoice::KeepPaused), "phone").await.expect("answers");
    assert!(rig.control.calls().is_empty(), "nothing resumed");
    let item = rig.find(&item.id).await;
    assert_eq!((item.state, item.consumed_at.is_some()), (ItemState::Answered, true));
}

#[tokio::test]
async fn resume_is_refused_while_too_many_results_still_wait() {
    let rig = Rig::new();
    let mut notices = Vec::new();
    for n in 0..=ROUTINE_CAP {
        notices.push(rig.open(new_item(ItemKind::Notice, Some(&format!("subject-{n}")))).await);
    }
    let waiting = rig.temp.port().read(|tx| tx.inbox_items().waiting_of_routine("rt-1")).await.expect("reads");
    let alert = waiting.into_iter().find(|item| item.kind == ItemKind::RoutineAlert).expect("the cap's alert");
    assert_eq!(alert.subject_key.as_deref(), Some(TOO_MANY_WAITING));
    let paused = ControlCall::Pause { routine_id: "rt-1".into(), reason: TOO_MANY_WAITING.into() };
    assert_eq!(rig.control.calls(), std::slice::from_ref(&paused));

    match rig.items.answer(&alert.id, 1, &answer(AlertChoice::Resume), "dashboard").await {
        Err(Error::Core(eos_core::Error::Conflict(reason))) => assert!(reason.contains("still wait"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(rig.find(&alert.id).await.state, ItemState::Open, "nothing written");

    let dismiss = InboxAnswer::Notice { choice: NoticeChoice::Dismiss };
    rig.items.answer(&notices[0].id, 1, &dismiss, "dashboard").await.expect("answers");
    rig.items.answer(&alert.id, 1, &answer(AlertChoice::Resume), "dashboard").await.expect("resumes");
    assert_eq!(rig.control.calls(), [paused, resumed(TOO_MANY_WAITING)]);
}
