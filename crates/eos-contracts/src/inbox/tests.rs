use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::*;
use crate::freedom::Rung;

/// Reads `value` with one key it does not know added, and writes it back
/// without that key, in the same order.
fn round_trip<T: DeserializeOwned + Serialize + Validate>(value: Value) -> T {
    let mut with_extra = value.clone();
    with_extra.as_object_mut().unwrap().insert("later".into(), json!({"x": 1}));
    let read: T = crate::parse(&with_extra).unwrap();
    assert_eq!(serde_json::to_string(&read).unwrap(), serde_json::to_string(&value).unwrap());
    read
}

fn doc() -> Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review",
           "parts": [{"key": "summary", "role": "summary", "text": "Looks fine."}]})
}

fn row() -> Value {
    json!({
        "id": "nd-0a1b2c3d4e5f",
        "kind": "draft",
        "state": "open",
        "attention": "interrupt",
        "routineId": "rt-1",
        "runId": "rn-1",
        "title": "Review of #482",
        "summary": "Two comments",
        "rev": 2,
        "staleAt": 300,
        "staleReason": "3 new commits",
        "laterUntil": 400,
        "expiresAt": 500,
        "createdAt": 100,
        "updatedAt": 200,
    })
}

#[test]
fn a_list_and_an_item_read_and_write_back_in_camel_case() {
    let list: InboxList = round_trip(json!({
        "items": [row()],
        "counts": {"open": 3, "later": 1, "byKind": {"draft": 2, "question": 2}, "byRoutine": {"rt-1": 4}},
        "agentsWaiting": 2,
        "nextCursor": "c-100",
    }));
    assert_eq!(list.items[0].stale_reason.as_deref(), Some("3 new commits"));
    assert_eq!(list.counts.by_kind.keys().collect::<Vec<_>>(), ["draft", "question"], "in the order given");
    round_trip::<InboxItem>(json!({"id": "nd-1", "kind": "notice", "state": "later", "attention": "digest",
                                   "title": "t", "summary": "s", "rev": 0, "createdAt": 1, "updatedAt": 1}));
    let bare: InboxList = round_trip(json!({
        "items": [], "counts": {"open": 0, "later": 0, "byKind": {}, "byRoutine": {}}, "agentsWaiting": 0,
    }));
    assert_eq!(bare.next_cursor, None, "the last page has no cursor");

    let detail: InboxItemDetail = round_trip(json!({
        "item": row(),
        "payload": {"doc": doc()},
        "working": doc(),
        "answeredAt": 600,
        "answeredBy": "phone",
        "answer": {"kind": "run_start", "choice": "skip"},
        "replacedBy": "nd-2",
    }));
    assert_eq!(detail.working.map(|doc| doc.parts.len()), Some(1));
}

#[test]
fn a_draft_is_saved_and_sent_with_the_rev_it_was_made_on() {
    let save: DraftSave = round_trip(json!({"rev": 3, "doc": doc()}));
    assert_eq!(save.doc.kind, "github.review");
    assert!(crate::parse::<DraftSave>(&json!({"doc": doc()})).is_err(), "a save names its rev");
    let send: SendRequest = round_trip(json!({"rev": 3, "doc": doc(), "confirmStale": true}));
    assert_eq!(send.confirm_stale, Some(true));
    let as_it_is: SendRequest = round_trip(json!({"rev": 3}));
    assert_eq!((as_it_is.doc, as_it_is.confirm_stale), (None, None));
    let answer: SendAnswer = round_trip(json!({"deliveries": [
        {"id": "dl-1", "state": "holding", "sendAt": 10_000},
        {"id": "dl-2", "state": "queued"},
    ]}));
    assert_eq!(answer.deliveries[0].send_at, Some(10_000));
}

#[test]
fn an_item_is_put_aside_with_or_without_a_time_and_discarded_on_its_rev() {
    let until: LaterRequest = round_trip(json!({"until": 9_000}));
    assert_eq!(until.until, Some(9_000));
    let digest: LaterRequest = round_trip(json!({}));
    assert_eq!(digest.until, None);
    let discard: DiscardRequest = round_trip(json!({"rev": 2}));
    assert_eq!(discard.rev, 2);
    assert!(crate::parse::<DiscardRequest>(&json!({})).is_err(), "a discard names its rev");
}

#[test]
fn an_answer_is_tagged_by_the_items_kind() {
    let answers = [
        json!({"kind": "run_start", "choice": "run"}),
        json!({"kind": "question", "answers": {"Which branch?": "main", "Why?": "tests"}}),
        json!({"kind": "capability_install", "choice": "decline"}),
        json!({"kind": "routine_alert", "choice": "keep_paused"}),
        json!({"kind": "freedom_offer", "choice": "not_now"}),
        json!({"kind": "confirm_change", "choice": "confirm"}),
        json!({"kind": "delivery_problem", "choice": "retry", "doc": doc()}),
        json!({"kind": "delivery_problem", "choice": "mark_sent"}),
        json!({"kind": "suggestion", "choice": "make_it"}),
        json!({"kind": "notice", "choice": "dismiss"}),
    ];
    for answer in answers {
        let request: AnswerRequest = crate::parse(&json!({"rev": 4, "answer": answer, "later": 1})).unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), json!({"rev": 4, "answer": answer}));
    }
    let read: AnswerRequest =
        crate::parse(&json!({"rev": 1, "answer": {"kind": "freedom_offer", "choice": "never", "x": 1}})).unwrap();
    assert_eq!(read.answer, InboxAnswer::FreedomOffer { choice: OfferChoice::Never }, "an unknown key is ignored");
    let questions: InboxAnswer = crate::parse(&json!({"kind": "question", "answers": {"b": "2", "a": "1"}})).unwrap();
    assert_eq!(serde_json::to_string(&questions).unwrap(), r#"{"kind":"question","answers":{"b":"2","a":"1"}}"#);

    for refused in [
        json!({"kind": "draft", "choice": "send"}),
        json!({"kind": "permission", "choice": "allow"}),
        json!({"kind": "run_start", "choice": "maybe"}),
        json!({"kind": "notice"}),
        json!({"choice": "run"}),
    ] {
        assert!(crate::parse::<InboxAnswer>(&refused).is_err(), "{refused}");
    }
}

#[test]
fn a_delivery_reads_and_writes_back_in_camel_case() {
    let delivery: Delivery = round_trip(json!({
        "id": "dl-0a1b2c3d4e5f",
        "itemId": "nd-1",
        "runId": "rn-1",
        "routineId": "rt-1",
        "channel": "github",
        "action": "post_review",
        "targetRef": "pr",
        "class": "speak",
        "mode": "grant:docs",
        "state": "sent",
        "body": doc(),
        "sendAt": 100,
        "attempts": 1,
        "lastErrorKind": "rate_limited",
        "receiptUrl": "https://github.com/acme/game/pull/482#pullrequestreview-1",
        "sentAt": 120,
        "undoUntil": 900,
        "undoneAt": 300,
        "approvedAt": 90,
        "createdAt": 90,
        "updatedAt": 300,
    }));
    assert_eq!(delivery.class, crate::ActionClass::Speak);
    round_trip::<Delivery>(json!({
        "id": "dl-2", "runId": "rn-1", "routineId": "rt-1", "channel": "mail", "action": "send",
        "targetRef": "lead", "class": "irreversible", "mode": "auto", "state": "frozen", "body": doc(),
        "attempts": 0, "createdAt": 1, "updatedAt": 1,
    }));
    assert!(crate::parse::<Delivery>(&json!({"id": "dl-3", "class": "send"})).is_err());
}

#[test]
fn the_topic_payloads_carry_ids_states_and_counts() {
    round_trip::<InboxChange>(json!({"id": "nd-1", "kind": "draft", "state": "answered", "routineId": "rt-1",
                                     "rev": 3, "open": 2}));
    round_trip::<InboxChange>(json!({"id": "nd-2", "kind": "notice", "state": "open", "rev": 0, "open": 3}));
    round_trip::<DeliveryChange>(json!({"id": "dl-1", "itemId": "nd-1", "runId": "rn-1", "state": "holding",
                                        "sendAt": 10_000}));
    round_trip::<DeliveryChange>(json!({"id": "dl-2", "runId": "rn-1", "state": "sent"}));
    let freedom: FreedomChange =
        round_trip(json!({"routineId": "rt-1", "rung": "send_then_tell", "streak": 10, "offer": "offered"}));
    assert_eq!(freedom.rung, Rung::SendThenTell);
    round_trip::<HaltState>(json!({"on": true, "since": 100}));
    assert_eq!(round_trip::<HaltState>(json!({"on": false})), HaltState { on: false, since: None });
}

#[test]
fn a_routines_freedom_view_reads_and_writes_back() {
    let view: FreedomView = round_trip(json!({
        "routineId": "rt-1",
        "rung": "draft",
        "grants": [{"id": "docs", "when": {"fact": "paths", "glob": "docs/**"}, "rung": "on_its_own",
                    "coversIrreversible": false}],
        "streak": 9,
        "offer": "offered",
        "offerItemId": "nd-9",
    }));
    assert_eq!(view.grants[0].rung, Rung::OnItsOwn);
    round_trip::<FreedomView>(json!({"routineId": "rt-2", "rung": "ask", "grants": [], "streak": 0,
                                     "offer": "none"}));
}

#[test]
fn attention_settings_take_clock_times_only() {
    let settings: AttentionSettings = round_trip(json!({
        "quietOn": true,
        "quietFrom": "22:00",
        "quietTo": "08:00",
        "digests": ["09:00", "17:00"],
        "interrupts": "urgent",
    }));
    assert_eq!(settings.interrupts, Interrupts::Urgent);
    let mut late = serde_json::to_value(&settings).unwrap();
    late["digests"] = json!(["09:00", "24:00"]);
    late["quietTo"] = json!("8:00");
    let error = crate::parse::<AttentionSettings>(&late).unwrap_err();
    let paths: Vec<String> = error.issues.iter().map(|issue| issue.path.join(".")).collect();
    assert_eq!(paths, ["quietTo", "digests.1"], "{error:?}");
    assert!(crate::parse::<AttentionSettings>(&json!({"quietOn": true})).is_err());
    let none: Interrupts = crate::read(&json!("none")).unwrap();
    assert_eq!(none, Interrupts::None);
}
