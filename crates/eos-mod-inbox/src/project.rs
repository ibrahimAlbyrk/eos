//! What Needs you shows without keeping it: the permission asks of routine
//! runs and the memory suggestions about the user, each answered through its
//! own recorded route; and the count of what Agents chats wait on.

use std::sync::Arc;

use eos_contracts::{InboxItem, InboxItemDetail, UserMemory, UserMemoryStatus};
use eos_core::Error;
use eos_core::store::Tx;
use eos_domain::PendingPermission;
use eos_domain::inbox::{ItemKind, ItemState, order_rank};
use eos_policy::ask::summarize_pending_input;
use serde_json::{Value, json};

/// A run's permission ask, by its pending id.
const PERMISSION: &str = "perm:";
/// A suggestion about the user, by its memory id.
const SUGGESTION: &str = "sugg:";

/// An item in the list, with its place in the order.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub(crate) rank: i64,
    pub(crate) item: InboxItem,
}

/// What waits outside the items.
#[derive(Debug, Default)]
pub(crate) struct Projection {
    pub(crate) entries: Vec<Entry>,
    /// Open asks and questions of Agents chats.
    pub(crate) agents_waiting: i64,
}

/// The routes that answer a shown item, when `id` names one.
pub(crate) fn own_routes(id: &str) -> Option<Vec<String>> {
    if let Some(pending) = id.strip_prefix(PERMISSION) {
        return Some(vec![format!("POST /pending/{pending}/decision")]);
    }
    let memory = id.strip_prefix(SUGGESTION)?;
    Some(vec![format!("POST /api/user-memories/{memory}/approve"), format!("POST /api/user-memories/{memory}/dismiss")])
}

fn ms(value: f64) -> i64 {
    value as i64
}

fn permission(tx: &dyn Tx, ask: &PendingPermission) -> Result<Option<Entry>, Error> {
    let Some(run) = tx.routine_sessions().run_of(&ask.worker_id)? else { return Ok(None) };
    let (state, attention) = (ItemState::Open, ItemKind::Permission.attention(false));
    let item = InboxItem {
        id: format!("{PERMISSION}{}", ask.id),
        kind: ItemKind::Permission.as_str().to_owned(),
        state: state.as_str().to_owned(),
        attention: attention.as_str().to_owned(),
        routine_id: Some(run.routine_id),
        run_id: Some(run.run_id),
        title: format!("Allow {}?", ask.tool_name),
        summary: summarize_pending_input(&ask.input),
        rev: 1,
        stale_at: None,
        stale_reason: None,
        later_until: None,
        expires_at: None,
        created_at: ask.created_at,
        updated_at: ask.created_at,
    };
    Ok(Some(Entry { rank: order_rank(state, attention), item }))
}

fn suggestion(memory: &UserMemory) -> Entry {
    let (state, attention) = (ItemState::Open, ItemKind::AboutYou.attention(false));
    let item = InboxItem {
        id: format!("{SUGGESTION}{}", memory.id.0),
        kind: ItemKind::AboutYou.as_str().to_owned(),
        state: state.as_str().to_owned(),
        attention: attention.as_str().to_owned(),
        routine_id: None,
        run_id: None,
        title: memory.text.clone(),
        summary: String::new(),
        rev: memory.rev,
        stale_at: None,
        stale_reason: None,
        later_until: None,
        expires_at: None,
        created_at: ms(memory.created_at.0),
        updated_at: ms(memory.updated_at.0),
    };
    Entry { rank: order_rank(state, attention), item }
}

/// The suggestions among `memories`.
pub(crate) fn suggested(memories: Vec<Arc<UserMemory>>) -> Vec<Arc<UserMemory>> {
    memories.into_iter().filter(|memory| memory.status == UserMemoryStatus::Suggested).collect()
}

/// Run asks and suggestions as items; asks and questions of other workers
/// counted. `askers` names the worker of each open question.
pub(crate) fn project(tx: &dyn Tx, askers: &[String], suggestions: &[Arc<UserMemory>]) -> Result<Projection, Error> {
    let mut projection = Projection::default();
    for ask in tx.pending().list_unresolved()? {
        match permission(tx, &ask)? {
            Some(entry) => projection.entries.push(entry),
            None => projection.agents_waiting += 1,
        }
    }
    for asker in askers {
        if tx.routine_sessions().run_of(asker)?.is_none() {
            projection.agents_waiting += 1;
        }
    }
    projection.entries.extend(suggestions.iter().map(|memory| suggestion(memory)));
    Ok(projection)
}

/// A shown item with what it carries; `None` when `id` names none that is
/// shown now.
pub(crate) fn detail(tx: &dyn Tx, id: &str, suggestions: &[Arc<UserMemory>]) -> Result<Option<InboxItemDetail>, Error> {
    let routes = own_routes(id).unwrap_or_default();
    if let Some(pending) = id.strip_prefix(PERMISSION) {
        let Some(ask) = tx.pending().find(pending)?.filter(|ask| !ask.resolved) else { return Ok(None) };
        let Some(entry) = permission(tx, &ask)? else { return Ok(None) };
        let input = serde_json::from_str::<Value>(&ask.input).unwrap_or(Value::String(ask.input.clone()));
        // Allow once and deny only: "always" would widen every chat's policy.
        let payload = json!({
            "pendingId": ask.id,
            "workerId": ask.worker_id,
            "toolName": ask.tool_name,
            "input": input,
            "offers": ["allow_once", "deny"],
            "routes": routes,
        });
        return Ok(Some(shown(entry.item, payload)));
    }
    let Some(memory_id) = id.strip_prefix(SUGGESTION) else { return Ok(None) };
    let Some(memory) = suggestions.iter().find(|memory| memory.id.0 == memory_id) else { return Ok(None) };
    let payload = json!({ "memory": memory.as_ref(), "routes": routes });
    Ok(Some(shown(suggestion(memory).item, payload)))
}

fn shown(item: InboxItem, payload: Value) -> InboxItemDetail {
    InboxItemDetail {
        item,
        payload,
        working: None,
        answered_at: None,
        answered_by: None,
        answer: None,
        replaced_by: None,
    }
}
