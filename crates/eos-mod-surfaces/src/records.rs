//! The record of each press: written when the gate decided, finished when
//! the handler answered, each change announced on `actions:record` after it
//! is saved. What a repeated `clientId` answers is read from its record.

use eos_contracts::{ActionAnswer, ActionRecord, ActionsRecord};
use eos_core::Error;
use eos_core::store::{Outbox, Store, StoredActionRecord};
use serde_json::{Value, json};

use crate::ACTIONS_RECORD;

pub(crate) fn announce(out: &mut Outbox, record: &StoredActionRecord) {
    let change = ActionsRecord {
        record_id: record.id.clone(),
        action_id: record.action_id.clone(),
        status: record.status.clone(),
    };
    out.push(ACTIONS_RECORD.name(), &change);
}

pub(crate) async fn insert(store: &dyn Store, record: StoredActionRecord) -> Result<StoredActionRecord, Error> {
    store
        .write(move |tx, out| {
            tx.action_log().insert(&record)?;
            announce(out, &record);
            Ok(record)
        })
        .await
}

pub(crate) async fn update(store: &dyn Store, record: StoredActionRecord) -> Result<StoredActionRecord, Error> {
    store
        .write(move |tx, out| {
            tx.action_log().update(&record)?;
            announce(out, &record);
            Ok(record)
        })
        .await
}

fn json_of(text: Option<&str>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str(t).ok())
}

/// What a record answers when its press is repeated, or read back.
pub(crate) fn answer_of(record: &StoredActionRecord) -> ActionAnswer {
    let result = json_of(record.result_json.as_deref());
    let id = record.id.clone();
    match record.status.as_str() {
        "done" | "running" => ActionAnswer::Done { record_id: id, result },
        "held" => ActionAnswer::Held {
            record_id: id,
            item_id: result.and_then(|r| r["itemId"].as_str().map(str::to_owned)).unwrap_or_default(),
        },
        _ => ActionAnswer::Refused {
            record_id: Some(id),
            reason: result.and_then(|r| r["reason"].as_str().map(str::to_owned)).unwrap_or_else(|| "Refused".into()),
        },
    }
}

pub(crate) fn reason(text: &str) -> Option<String> {
    Some(json!({ "reason": text }).to_string())
}

pub(crate) fn wire(record: &StoredActionRecord) -> ActionRecord {
    ActionRecord {
        id: record.id.clone(),
        client_id: record.client_id.clone(),
        action_id: record.action_id.clone(),
        surface_id: record.surface_id.clone(),
        issue_id: record.issue_id.clone(),
        routine_id: record.routine_id.clone(),
        origin: record.origin.clone(),
        class: record.class,
        args: json_of(Some(&record.args_json)).unwrap_or(Value::Null),
        decision: record.decision.clone(),
        status: record.status.clone(),
        result: json_of(record.result_json.as_deref()),
        error_kind: record.error_kind.clone(),
        created_at: record.created_at,
        finished_at: record.finished_at,
    }
}
