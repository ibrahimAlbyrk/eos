//! Answers, later, discards and saved edits, each on the rev it was made on.

use eos_contracts::{AlertChoice, InboxAnswer, NoticeChoice, ResultDoc};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::Error;

use crate::rig::{Rig, new_item};

fn keep_paused() -> InboxAnswer {
    InboxAnswer::RoutineAlert { choice: AlertChoice::KeepPaused }
}

#[tokio::test]
async fn of_two_answers_on_one_rev_the_first_lands_and_the_second_is_told_who_answered() {
    let rig = Rig::new();
    let item = rig.open(new_item(ItemKind::RoutineAlert, None)).await;
    let alert = keep_paused();
    let (mac, phone) = tokio::join!(
        rig.items.answer(&item.id, 1, &alert, "dashboard"),
        rig.items.answer(&item.id, 1, &alert, "phone")
    );
    let (won, lost, by) = match (mac, phone) {
        (Ok(won), Err(lost)) => (won, lost, "dashboard"),
        (Err(lost), Ok(won)) => (won, lost, "phone"),
        other => panic!("exactly one answer lands: {other:?}"),
    };
    assert_eq!((won.state, won.rev, won.answered_by.as_deref()), (ItemState::Answered, 2, Some(by)));
    assert_eq!(won.answer.as_deref(), Some(r#"{"kind":"routine_alert","choice":"keep_paused"}"#));
    match lost {
        Error::AlreadyAnswered { state, answered_by } => {
            assert_eq!((state, answered_by.as_deref()), (ItemState::Answered, Some(by)));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_answer_on_a_stale_rev_is_refused_with_the_rev_it_has_now() {
    let rig = Rig::new();
    let item = rig.open(new_item(ItemKind::Notice, None)).await;
    rig.items.later(&item.id, Some(5_000_000)).await.expect("put aside");
    let answer = InboxAnswer::Notice { choice: NoticeChoice::Dismiss };
    match rig.items.answer(&item.id, 1, &answer, "phone").await {
        Err(Error::Changed { rev }) => assert_eq!(rev, 2),
        other => panic!("{other:?}"),
    }
    let answered = rig.items.answer(&item.id, 2, &answer, "phone").await.expect("answers from later");
    assert_eq!(answered.state, ItemState::Answered);
}

#[tokio::test]
async fn an_answer_must_be_of_the_items_kind_and_a_kind_answered_here() {
    let rig = Rig::new();
    let alert = rig.open(new_item(ItemKind::RoutineAlert, None)).await;
    let notice = InboxAnswer::Notice { choice: NoticeChoice::Act };
    assert!(matches!(
        rig.items.answer(&alert.id, 1, &notice, "dashboard").await,
        Err(Error::Core(eos_core::Error::Validation(_)))
    ));
    let draft = rig.open(new_item(ItemKind::Draft, None)).await;
    assert!(matches!(
        rig.items.answer(&draft.id, 1, &keep_paused(), "dashboard").await,
        Err(Error::Core(eos_core::Error::Validation(_)))
    ));
    assert!(matches!(
        rig.items.answer("nd-missing", 1, &keep_paused(), "dashboard").await,
        Err(Error::Core(eos_core::Error::NotFound { .. }))
    ));
    assert_eq!(rig.find(&alert.id).await.state, ItemState::Open, "nothing written");
}

#[tokio::test]
async fn later_and_discard_move_the_item_and_an_ended_item_moves_no_more() {
    let rig = Rig::new();
    let item = rig.open(new_item(ItemKind::Draft, None)).await;
    let later = rig.items.later(&item.id, Some(9_000_000)).await.expect("put aside");
    assert_eq!((later.state, later.later_until, later.rev), (ItemState::Later, Some(9_000_000), 2));
    let discarded = rig.items.discard(&item.id, 2, "phone").await.expect("discards");
    assert_eq!((discarded.state, discarded.answer.as_deref()), (ItemState::Answered, Some(r#"{"discard":true}"#)));
    assert!(matches!(rig.items.later(&item.id, None).await, Err(Error::AlreadyAnswered { .. })));
}

#[tokio::test]
async fn a_draft_keeps_the_users_edits_one_rev_up() {
    let rig = Rig::new();
    let item = rig.open(new_item(ItemKind::Draft, None)).await;
    let doc: ResultDoc = serde_json::from_value(serde_json::json!({
        "kind": "github.review", "channel": "github", "action": "post_review",
        "parts": [{"key": "summary", "role": "summary", "text": "Looks good"}]
    }))
    .expect("a result");
    let saved = rig.items.save_draft(&item.id, 1, &doc).await.expect("saves");
    assert_eq!(saved.rev, 2);
    let working: ResultDoc = serde_json::from_str(saved.working.as_deref().expect("kept")).expect("JSON");
    assert_eq!(working, doc);
    assert!(matches!(rig.items.save_draft(&item.id, 1, &doc).await, Err(Error::Changed { rev: 2 })));
    let question = rig.open(new_item(ItemKind::Question, None)).await;
    assert!(matches!(
        rig.items.save_draft(&question.id, 1, &doc).await,
        Err(Error::Core(eos_core::Error::Validation(_)))
    ));
}
