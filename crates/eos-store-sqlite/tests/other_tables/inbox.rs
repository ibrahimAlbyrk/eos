//! The Needs-you tables: items listed in Needs you's order, an answer that
//! lands once on the rev it was made on, deliveries by state and due time,
//! edits from a cursor, outcomes per routine, offers and the one switch.

use eos_contracts::ActionClass;
use eos_core::store::{
    ItemAnswer, NewEdit, NewOutcome, StoredDelivery, StoredHalt, StoredItem, StoredOffer, StoredOutcome,
};
use eos_domain::inbox::{Attention, ItemKind, ItemState};
use eos_testkit::TempStore;

fn item(id: &str, state: ItemState, attention: Attention, created_at: i64) -> StoredItem {
    StoredItem {
        id: id.into(),
        kind: ItemKind::Draft,
        state,
        producer: "inbox".into(),
        routine_id: Some("rt-1".into()),
        run_id: Some("rn-1".into()),
        subject_key: Some("github:pr:acme/game#482".into()),
        title: "Review of #482".into(),
        summary: "Two comments".into(),
        payload: r#"{"doc":{}}"#.into(),
        working: None,
        rev: 0,
        attention,
        stale_at: None,
        stale_reason: None,
        later_until: None,
        expires_at: Some(created_at + 1_000),
        created_at,
        updated_at: created_at,
        answered_at: None,
        answered_by: None,
        answer: None,
        replaced_by: None,
        consumed_at: None,
        notified_at: None,
    }
}

fn answer(by: &str, at: i64) -> ItemAnswer {
    ItemAnswer { by: by.into(), answer: Some(r#"{"kind":"send"}"#.into()), at }
}

#[test]
fn items_wait_open_before_later_then_loudest_then_newest() {
    let temp = TempStore::new();
    let items = [
        item("nd-later-new", ItemState::Later, Attention::Interrupt, 90),
        item("nd-silent", ItemState::Open, Attention::Silent, 80),
        item("nd-digest-old", ItemState::Open, Attention::Digest, 10),
        item("nd-interrupt-old", ItemState::Open, Attention::Interrupt, 20),
        item("nd-digest-new", ItemState::Open, Attention::Digest, 50),
        item("nd-answered", ItemState::Answered, Attention::Interrupt, 99),
        item("nd-later-old", ItemState::Later, Attention::Silent, 5),
        item("nd-interrupt-new", ItemState::Open, Attention::Interrupt, 60),
    ];
    let (waiting, first_two, found) = temp
        .store
        .write_blocking(move |tx, _| {
            for item in &items {
                tx.inbox_items().insert(item)?;
            }
            Ok((tx.inbox_items().waiting(100)?, tx.inbox_items().waiting(2)?, tx.inbox_items().find("nd-silent")?))
        })
        .expect("writes");
    let ids: Vec<&str> = waiting.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "nd-interrupt-new",
            "nd-interrupt-old",
            "nd-digest-new",
            "nd-digest-old",
            "nd-silent",
            "nd-later-new",
            "nd-later-old"
        ],
        "an answered item no longer waits"
    );
    assert_eq!(first_two.len(), 2);
    assert_eq!(found, Some(item("nd-silent", ItemState::Open, Attention::Silent, 80)), "read back as written");
}

#[test]
fn an_answer_lands_once_and_only_on_the_rev_it_was_made_on() {
    let temp = TempStore::new();
    let mut edited = item("nd-edited", ItemState::Later, Attention::Interrupt, 20);
    edited.rev = 3;
    let (first, second, stale, current) = temp
        .store
        .write_blocking(move |tx, _| {
            let items = tx.inbox_items();
            items.insert(&item("nd-1", ItemState::Open, Attention::Interrupt, 10))?;
            items.insert(&edited)?;
            let first = items.answer("nd-1", 0, &answer("phone", 100))?;
            let second = items.answer("nd-1", 0, &answer("dashboard", 101))?;
            let stale = items.answer("nd-edited", 2, &answer("dashboard", 102))?;
            let current = items.answer("nd-edited", 3, &answer("dashboard", 103))?;
            Ok((first, second, stale, current))
        })
        .expect("writes");
    assert_eq!((first, second), (true, false), "the second answer on the same rev finds it answered");
    assert_eq!((stale, current), (false, true), "an answer made before the last edit changes nothing");

    let (one, edited, again) = temp
        .store
        .write_blocking(|tx, _| {
            let items = tx.inbox_items();
            let again = items.answer("nd-1", 1, &answer("dashboard", 104))?;
            Ok((items.find("nd-1")?, items.find("nd-edited")?, again))
        })
        .expect("writes");
    assert!(!again, "an answered item is not answered again, whatever its rev");
    let one = one.expect("the item");
    assert_eq!(
        (one.state, one.rev, one.answered_by.as_deref(), one.answered_at, one.updated_at),
        (ItemState::Answered, 1, Some("phone"), Some(100), 100),
        "the first answer stays"
    );
    assert_eq!(one.answer.as_deref(), Some(r#"{"kind":"send"}"#));
    let edited = edited.expect("the item");
    assert_eq!((edited.state, edited.rev, edited.answered_at), (ItemState::Answered, 4, Some(103)));
}

fn delivery(id: &str, state: &str, next_attempt_at: Option<i64>, created_at: i64) -> StoredDelivery {
    StoredDelivery {
        id: id.into(),
        item_id: Some("nd-1".into()),
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        channel: "github".into(),
        action: "post_review".into(),
        target_ref: "pr".into(),
        target: r#"{"item":"github:pr:acme/game#482"}"#.into(),
        body: r#"{"kind":"github.review"}"#.into(),
        body_hash: "h1".into(),
        class: ActionClass::Speak,
        mode: "approved".into(),
        state: state.into(),
        send_at: next_attempt_at,
        attempts: 0,
        next_attempt_at,
        last_error_kind: None,
        partial: None,
        receipt: None,
        sent_at: None,
        undo_until: None,
        undone_at: None,
        approved_at: Some(created_at),
        created_at,
        updated_at: created_at,
    }
}

#[test]
fn deliveries_come_due_by_state_and_time() {
    let temp = TempStore::new();
    let mut sent = delivery("dl-sent", "sent", Some(10), 1);
    sent.receipt = Some(r#"{"id":"r-1"}"#.into());
    sent.sent_at = Some(12);
    let rows = [
        delivery("dl-later", "queued", Some(500), 1),
        delivery("dl-second", "queued", Some(100), 3),
        delivery("dl-first", "queued", Some(50), 4),
        delivery("dl-tie", "queued", Some(100), 2),
        delivery("dl-holding", "holding", Some(40), 1),
        delivery("dl-frozen", "frozen", None, 1),
        sent.clone(),
    ];
    let (queued, holding, frozen, found) = temp
        .store
        .write_blocking(move |tx, _| {
            for row in &rows {
                tx.inbox_deliveries().insert(row)?;
            }
            let deliveries = tx.inbox_deliveries();
            Ok((
                deliveries.due("queued", 100, 10)?,
                deliveries.due("holding", 39, 10)?,
                deliveries.due("frozen", i64::MAX, 10)?,
                deliveries.find("dl-sent")?,
            ))
        })
        .expect("writes");
    let ids: Vec<&str> = queued.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["dl-first", "dl-tie", "dl-second"], "the longest due first, then the oldest");
    assert!(holding.is_empty(), "not due before its time");
    assert!(frozen.is_empty(), "a delivery with no next attempt never comes due");
    assert_eq!(found, Some(sent), "read back as written");
}

#[test]
fn the_switch_is_one_row_and_off_until_first_used() {
    let temp = TempStore::new();
    let before = temp.store.read_blocking(|tx| tx.inbox_halt().get()).expect("reads");
    assert_eq!(before, StoredHalt { on: false, since: None, by: None, updated_at: 0 }, "never used: off");
    let on = StoredHalt { on: true, since: Some(100), by: Some("phone".into()), updated_at: 100 };
    let off = StoredHalt { on: false, since: None, by: Some("dashboard".into()), updated_at: 200 };
    let (after_on, after_off) = temp
        .store
        .write_blocking({
            let (on, off) = (on.clone(), off.clone());
            move |tx, _| {
                tx.inbox_halt().put(&on)?;
                let after_on = tx.inbox_halt().get()?;
                tx.inbox_halt().put(&off)?;
                Ok((after_on, tx.inbox_halt().get()?))
            }
        })
        .expect("writes");
    assert_eq!((after_on, after_off), (on, off));
    assert_eq!(temp.count("SELECT COUNT(*) FROM inbox_halt WHERE id = 1"), 1);
    assert_eq!(temp.count("SELECT COUNT(*) FROM inbox_halt"), 1, "one row, however often it is switched");
}

fn outcome(routine_id: &str, outcome: &str, at: i64) -> NewOutcome {
    NewOutcome {
        routine_id: routine_id.into(),
        run_id: format!("rn-{at}"),
        item_id: Some(format!("nd-{at}")),
        delivery_id: None,
        outcome: outcome.into(),
        rung: "draft".into(),
        at,
    }
}

#[test]
fn a_routines_outcomes_are_read_newest_first() {
    let temp = TempStore::new();
    let (ids, last_two, other) = temp
        .store
        .write_blocking(|tx, _| {
            let outcomes = tx.inbox_outcomes();
            let ids = (
                outcomes.insert(&outcome("rt-1", "sent_unedited", 10))?,
                outcomes.insert(&outcome("rt-2", "discarded", 20))?,
                outcomes.insert(&outcome("rt-1", "sent_edited", 30))?,
                outcomes.insert(&outcome("rt-1", "auto_sent", 30))?,
            );
            Ok((ids, outcomes.by_routine("rt-1", 2)?, outcomes.by_routine("rt-2", 10)?))
        })
        .expect("writes");
    assert!(ids.0 < ids.1 && ids.1 < ids.2 && ids.2 < ids.3, "numbered in order: {ids:?}");
    assert_eq!(
        last_two,
        [
            StoredOutcome { id: ids.3, outcome: outcome("rt-1", "auto_sent", 30) },
            StoredOutcome { id: ids.2, outcome: outcome("rt-1", "sent_edited", 30) },
        ],
        "newest first, the later of a tie first"
    );
    assert_eq!(other, [StoredOutcome { id: ids.1, outcome: outcome("rt-2", "discarded", 20) }]);
}

#[test]
fn edits_are_read_from_a_cursor_and_offers_are_kept_per_routine() {
    let temp = TempStore::new();
    let edit = |at: i64| NewEdit {
        item_id: "nd-1".into(),
        delivery_id: Some("dl-1".into()),
        routine_id: "rt-1".into(),
        run_id: "rn-1".into(),
        result_kind: "github.review".into(),
        before: r#"{"parts":[1,2]}"#.into(),
        after: r#"{"parts":[1]}"#.into(),
        ops: r#"[{"key":"c:2","op":"removed"}]"#.into(),
        changed: 0,
        removed: 1,
        added: 0,
        moved: 0,
        derived_from_untrusted: true,
        at,
    };
    let offer = |state: &str, updated_at: i64| StoredOffer {
        routine_id: "rt-1".into(),
        state: state.into(),
        item_id: Some("nd-9".into()),
        streak_at: Some(10),
        next_at: None,
        updated_at,
    };
    let (after_first, found, offered, declined, none) = temp
        .store
        .write_blocking(move |tx, _| {
            let edits = tx.inbox_edits();
            let first = edits.insert(&edit(10))?;
            edits.insert(&edit(20))?;
            edits.insert(&edit(30))?;
            let offers = tx.inbox_offers();
            offers.put(&offer("offered", 40))?;
            let offered = offers.find("rt-1")?;
            offers.put(&offer("declined", 50))?;
            Ok((edits.since(first, 10)?, edits.find(first)?, offered, offers.find("rt-1")?, offers.find("rt-2")?))
        })
        .expect("writes");
    let at: Vec<i64> = after_first.iter().map(|e| e.edit.at).collect();
    assert_eq!(at, [20, 30], "after the cursor, oldest first");
    assert_eq!(found.map(|e| e.edit), Some(edit(10)), "read back as written");
    assert_eq!((offered, declined, none), (Some(offer("offered", 40)), Some(offer("declined", 50)), None));
    assert_eq!(temp.count("SELECT COUNT(*) FROM inbox_offers"), 1, "one row per routine");
}
