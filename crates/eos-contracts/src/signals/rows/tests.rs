use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::*;

/// Reads `value` with one key it does not know added, and writes it back
/// without that key, in the same order.
fn round_trip<T: DeserializeOwned + Serialize + Validate>(value: Value) -> T {
    let mut with_extra = value.clone();
    with_extra.as_object_mut().unwrap().insert("later".into(), json!({"x": 1}));
    let read: T = crate::parse(&with_extra).unwrap();
    assert_eq!(serde_json::to_string(&read).unwrap(), serde_json::to_string(&value).unwrap());
    read
}

#[test]
fn a_signal_row_and_its_decisions_read_and_write_back_in_camel_case() {
    let row: SignalRow = round_trip(json!({
        "id": 41,
        "sourceId": "src-0a1b2c3d4e5f",
        "kind": "opened",
        "subject": "github:pr:acme/game#482",
        "version": "9f1a4771",
        "occurredAt": 1_000,
        "receivedAt": 1_200,
        "state": "routed",
        "item": {"kind": "github.pull_request", "key": "github:pr:acme/game#482@9f1a4771", "untrusted": true},
        "decisions": [
            {"routineId": "rt-1", "routineVersion": "rv-1", "decision": "unmatched", "reason": "2",
             "modelAsked": false, "decidedAt": 1_300},
            {"routineId": "rt-2", "routineVersion": "rv-9", "decision": "run", "runId": "rn-1",
             "modelAsked": true, "decidedAt": 1_300},
        ],
    }));
    assert_eq!(row.decisions[1].run_id.as_deref(), Some("rn-1"));
    round_trip::<SignalDecision>(json!({"routineId": "rt-1", "routineVersion": "rv-1", "decision": "held-dev",
                                        "modelAsked": false, "decidedAt": 5}));
}

#[test]
fn a_list_query_takes_its_numbers_as_text() {
    let query: SignalListQuery =
        crate::parse(&json!({"routine": "rt-1", "decision": "over-limit", "before": "120", "limit": "50"})).unwrap();
    assert_eq!((query.before, query.limit), (Some(120), Some(50)));
    let bare: SignalListQuery = crate::parse(&json!({})).unwrap();
    assert_eq!(bare, SignalListQuery { routine: None, decision: None, before: None, limit: None });
}

#[test]
fn a_routines_trigger_status_reads_and_writes_back_in_camel_case() {
    let counts = json!({"handled": 3, "waiting": 1, "ignored": 4, "heldBack": 2, "failed": 0, "missed": 1,
                        "late": 1});
    round_trip::<RoutineTriggerStatus>(json!({
        "routineId": "rt-1",
        "holder": {"deviceId": "d-1", "name": "MacBook Air", "here": false, "awaySince": 7},
        "schedules": [{"slot": 1, "nextAt": 9, "lastAt": 3, "lateByMs": 60_000, "missed": 2,
                       "zone": "Europe/Istanbul", "zoneDiffers": true}],
        "sources": [{"sourceId": "src-1", "kind": "capability", "source": "github.pulls",
                     "state": "needs-attention", "errorKind": "unauthorized", "lastPollAt": 1, "nextPollAt": 2,
                     "lastSignalAt": 1, "catchUp": {"at": 1, "items": 14, "gapMs": 3_600_000}}],
        "batch": {"items": 7, "openedAt": 1, "closesAt": 301},
        "countsToday": counts,
        "counts7d": counts,
    }));
    let bare: RoutineTriggerStatus = round_trip(json!({
        "routineId": "rt-1",
        "schedules": [],
        "sources": [{"sourceId": "src-2", "kind": "clock", "state": "active"}],
        "countsToday": counts,
        "counts7d": counts,
    }));
    assert_eq!((bare.holder, bare.batch), (None, None));
    round_trip::<SignalSummary>(json!({"since": 10, "counts": counts, "byRoutine": {"rt-1": counts}}));
}

#[test]
fn requests_hold_to_their_bounds() {
    let ids: Vec<i64> = (1..=200).collect();
    round_trip::<ReplayRequest>(json!({"routineId": "rt-1", "signalIds": ids}));
    let over: Vec<i64> = (1..=201).collect();
    assert!(crate::parse::<ReplayRequest>(&json!({"routineId": "rt-1", "signalIds": over})).is_err());

    let schedule = json!({"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"});
    round_trip::<SchedulePreviewRequest>(json!({"schedule": schedule, "count": 10}));
    for count in [0, 11] {
        assert!(crate::parse::<SchedulePreviewRequest>(&json!({"schedule": schedule, "count": count})).is_err());
    }
    round_trip::<SchedulePreviewResponse>(json!({"next": [1, 2, 3]}));

    let which = json!({"rule": {"fact": "draft", "is": false}, "ask": "About networking?"});
    round_trip::<WhichPreviewRequest>(json!({"routineId": "rt-1", "which": which, "limit": 200}));
    round_trip::<WhichPreviewRequest>(json!({"which": {}, "limit": 1}));
    assert!(crate::parse::<WhichPreviewRequest>(&json!({"which": which, "limit": 201})).is_err());
    round_trip::<WhichPreviewResponse>(json!({
        "matched": [1, 2],
        "unmatched": [{"rule": 0, "signalIds": [3]}, {"rule": 2, "signalIds": [4, 5]}],
        "undecided": [6],
        "wouldAsk": 2,
    }));
    round_trip::<SignalSettings>(json!({"keepAwakeForSchedules": true}));
}

#[test]
fn the_topic_payloads_read_and_write_back_in_camel_case() {
    let change: SignalChange = round_trip(json!({"routineId": "rt-1", "sourceId": "src-1", "what": "routed"}));
    assert_eq!(change.what, SignalChangeWhat::Routed);
    round_trip::<SignalChange>(json!({"what": "settings"}));
    assert!(crate::parse::<SignalChange>(&json!({"what": "everything"})).is_err());
    round_trip::<SignalSubject>(json!({"subjectKey": "github:pr:acme/game#482", "version": "9f1a", "closed": true}));
    round_trip::<SignalSubject>(json!({"subjectKey": "file:/in/a.pdf", "closed": false}));
}
