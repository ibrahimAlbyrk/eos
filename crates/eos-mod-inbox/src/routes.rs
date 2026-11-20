//! The routes over the items, each item turned into its wire row.

use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::sync::Arc;

use eos_contracts::{
    AnswerRequest, Delivery, DeliveryRef, DiscardRequest, DraftSave, InboxCounts, InboxItem, InboxItemDetail,
    InboxList, LaterRequest, ResultDoc, SendAnswer, SendRequest,
};
use eos_core::store::{ItemPlace, ItemQuery, StoredDelivery, StoredItem};
use eos_domain::inbox::{ItemState, order_rank};
use eos_runtime::access::{Access, Caller, LocalCaller, Tier};
use eos_runtime::http::path::percent_decode;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::Shared;
use crate::project::{self, Entry, own_routes};

/// The items one page lists.
const PAGE: usize = 100;

fn row(item: &StoredItem) -> InboxItem {
    InboxItem {
        id: item.id.clone(),
        kind: item.kind.as_str().to_owned(),
        state: item.state.as_str().to_owned(),
        attention: item.attention.as_str().to_owned(),
        routine_id: item.routine_id.clone(),
        run_id: item.run_id.clone(),
        title: item.title.clone(),
        summary: item.summary.clone(),
        rev: item.rev,
        stale_at: item.stale_at,
        stale_reason: item.stale_reason.clone(),
        later_until: item.later_until,
        expires_at: item.expires_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
    }
}

fn detail(item: &StoredItem) -> InboxItemDetail {
    let json = |text: &str| serde_json::from_str::<Value>(text).ok();
    InboxItemDetail {
        item: row(item),
        payload: json(&item.payload).unwrap_or(Value::Null),
        working: item.working.as_deref().and_then(|text| serde_json::from_str::<ResultDoc>(text).ok()),
        answered_at: item.answered_at,
        answered_by: item.answered_by.clone(),
        answer: item.answer.as_deref().and_then(json),
        replaced_by: item.replaced_by.clone(),
    }
}

/// Who answered, as an item keeps it.
fn answered_by(caller: &Caller) -> &'static str {
    match caller {
        Caller::Local(LocalCaller::Dashboard | LocalCaller::HostView { .. } | LocalCaller::Untrusted) => "dashboard",
        Caller::Phone { .. } => "phone",
        Caller::Peer { .. } => "peer",
        Caller::Internal => "system",
    }
}

fn item_id(req: &Request) -> String {
    let raw = req.param("id").unwrap_or_default();
    percent_decode(raw).map(|id| id.into_owned()).unwrap_or_else(|| raw.to_owned())
}

/// A write on a shown item is answered by its own route, named here.
fn elsewhere(id: &str) -> Option<Response> {
    let routes = own_routes(id)?;
    Some(Response::json(409, &json!({ "error": "answered through its own route", "routes": routes })))
}

/// A delivery as the dashboard reads it; the receipt shows only where the
/// user sees what went out.
fn delivery(row: StoredDelivery) -> Result<Delivery, ApiError> {
    let body = serde_json::from_str(&row.body).map_err(|e| eos_core::Error::storage(e.to_string()))?;
    let receipt = row.receipt.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok());
    Ok(Delivery {
        id: row.id,
        item_id: row.item_id,
        run_id: row.run_id,
        routine_id: row.routine_id,
        channel: row.channel,
        action: row.action,
        target_ref: row.target_ref,
        class: row.class,
        mode: row.mode,
        state: row.state,
        body,
        send_at: row.send_at,
        attempts: row.attempts,
        last_error_kind: row.last_error_kind,
        receipt_url: receipt.and_then(|receipt| receipt["url"].as_str().map(str::to_owned)),
        sent_at: row.sent_at,
        undo_until: row.undo_until,
        undone_at: row.undone_at,
        approved_at: row.approved_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// The deliveries a send queued.
fn queued(rows: Vec<StoredDelivery>) -> Response {
    let deliveries = rows.into_iter().map(|row| DeliveryRef { id: row.id, state: row.state, send_at: row.send_at });
    Response::json(200, &SendAnswer { deliveries: deliveries.collect() })
}

/// The item as a write left it, or the 409 that says why it did not.
fn written(result: Result<StoredItem, eos_inbox::Error>) -> Result<Response, ApiError> {
    answered(result, |item| Response::json(200, &row(&item)))
}

/// What a write answers, or the 409 that says why it did not land.
fn answered<T>(result: Result<T, eos_inbox::Error>, ok: impl FnOnce(T) -> Response) -> Result<Response, ApiError> {
    match result {
        Ok(done) => Ok(ok(done)),
        Err(eos_inbox::Error::AlreadyAnswered { state, answered_by }) => {
            let mut body = json!({ "error": "already answered", "state": state.as_str() });
            if let Some(by) = answered_by {
                body["answeredBy"] = Value::String(by);
            }
            Ok(Response::json(409, &body))
        }
        Err(eos_inbox::Error::Changed { rev }) => Ok(Response::json(409, &json!({ "error": "changed", "rev": rev }))),
        Err(eos_inbox::Error::Core(e)) => Err(e.into()),
    }
}

/// The order of the list: by place, then newest, then the higher id.
type Key = (i64, Reverse<i64>, Reverse<String>);

fn key(rank: i64, created_at: i64, id: &str) -> Key {
    (rank, Reverse(created_at), Reverse(id.to_owned()))
}

fn cursor(entry: &Entry) -> String {
    format!("{}.{}.{}", entry.rank, entry.item.created_at, entry.item.id)
}

fn place(cursor: &str) -> Option<ItemPlace> {
    let mut parts = cursor.splitn(3, '.');
    let rank = parts.next()?.parse().ok()?;
    let created_at = parts.next()?.parse().ok()?;
    let id = parts.next().filter(|id| !id.is_empty())?.to_owned();
    Some(ItemPlace { rank, created_at, id })
}

struct Filter {
    state: Option<ItemState>,
    routine_id: Option<String>,
    after: Option<ItemPlace>,
}

fn filter(req: &Request) -> Result<Filter, ApiError> {
    let given = |key: &str| req.query().get(key).filter(|value| !value.is_empty());
    let state = given("state")
        .map(|word| ItemState::parse(&word).ok_or_else(|| ApiError::invalid([("state", "Unknown state")])))
        .transpose()?;
    let after = given("cursor")
        .map(|text| place(&text).ok_or_else(|| ApiError::invalid([("cursor", "Unknown cursor")])))
        .transpose()?;
    Ok(Filter { state, routine_id: given("routineId").map(|id| id.into_owned()), after })
}

fn counts(stored: Vec<eos_core::store::WaitingCount>, shown: &[Entry]) -> InboxCounts {
    let (mut open, mut later) = (0, 0);
    let (mut by_kind, mut by_routine) = (BTreeMap::<String, i64>::new(), BTreeMap::<String, i64>::new());
    let shown = shown.iter().map(|entry| (ItemState::Open, entry.item.kind.clone(), entry.item.routine_id.clone(), 1));
    let stored = stored.into_iter().map(|c| (c.state, c.kind.as_str().to_owned(), c.routine_id, c.count));
    for (state, kind, routine_id, count) in stored.chain(shown) {
        match state {
            ItemState::Later => later += count,
            _ => open += count,
        }
        *by_kind.entry(kind).or_default() += count;
        if let Some(routine_id) = routine_id {
            *by_routine.entry(routine_id).or_default() += count;
        }
    }
    InboxCounts {
        open,
        later,
        by_kind: by_kind.into_iter().collect::<IndexMap<_, _>>(),
        by_routine: by_routine.into_iter().collect::<IndexMap<_, _>>(),
    }
}

async fn list(shared: Arc<Shared>, req: Request) -> Result<Response, ApiError> {
    let Filter { state, routine_id, after } = filter(&req)?;
    let askers = shared.questions.open_askers();
    let suggestions = project::suggested(shared.memories.list());
    let query = ItemQuery { state, routine_id: routine_id.clone(), after: after.clone(), limit: PAGE as i64 + 1 };
    let (stored, stored_counts, projection) = shared
        .store
        .read(move |tx| {
            let items = tx.inbox_items();
            Ok((items.page(&query)?, items.counts()?, project::project(tx, &askers, &suggestions)?))
        })
        .await?;
    let counts = counts(stored_counts, &projection.entries);
    let after = after.map(|place| key(place.rank, place.created_at, &place.id));
    let shown = projection.entries.into_iter().filter(|entry| {
        matches!(state, None | Some(ItemState::Open))
            && (routine_id.is_none() || entry.item.routine_id == routine_id)
            && after.as_ref().is_none_or(|after| key(entry.rank, entry.item.created_at, &entry.item.id) > *after)
    });
    let stored = stored.iter().map(|item| Entry { rank: order_rank(item.state, item.attention), item: row(item) });
    let mut entries: Vec<Entry> = stored.chain(shown).collect();
    entries.sort_by_key(|entry| key(entry.rank, entry.item.created_at, &entry.item.id));
    let next_cursor = (entries.len() > PAGE).then(|| cursor(&entries[PAGE - 1]));
    entries.truncate(PAGE);
    let items = entries.into_iter().map(|entry| entry.item).collect();
    Ok(Response::json(200, &InboxList { items, counts, agents_waiting: projection.agents_waiting, next_cursor }))
}

async fn one(shared: Arc<Shared>, req: Request) -> Result<Response, ApiError> {
    let id = item_id(&req);
    if own_routes(&id).is_some() {
        let suggestions = project::suggested(shared.memories.list());
        let found = shared.store.read(move |tx| project::detail(tx, &id, &suggestions)).await?;
        let found = found.ok_or_else(|| ApiError::NotFound("item not found".into()))?;
        return Ok(Response::json(200, &found));
    }
    let lookup = id.clone();
    let item = shared.store.read(move |tx| tx.inbox_items().find(&lookup)).await?;
    let item = item.ok_or_else(|| eos_core::Error::not_found("item", &id))?;
    Ok(Response::json(200, &detail(&item)))
}

pub(crate) fn all(shared: &Arc<Shared>) -> Vec<RouteDef> {
    let at = shared.clone();
    let list = RouteDef::get("/api/inbox", move |req: Request| list(at.clone(), req));
    let at = shared.clone();
    let item = RouteDef::get("/api/inbox/{id}", move |req: Request| one(at.clone(), req));
    let at = shared.clone();
    let draft = RouteDef::put("/api/inbox/{id}/draft", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            if let Some(refused) = elsewhere(&id) {
                return Ok(refused);
            }
            let body: DraftSave = req.parse()?;
            written(at.items.save_draft(&id, body.rev, &body.doc).await)
        }
    });
    let at = shared.clone();
    let later = RouteDef::post("/api/inbox/{id}/later", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            if let Some(refused) = elsewhere(&id) {
                return Ok(refused);
            }
            let body: LaterRequest = req.parse()?;
            written(at.items.later(&id, body.until).await)
        }
    });
    let at = shared.clone();
    let discard = RouteDef::post("/api/inbox/{id}/discard", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            if let Some(refused) = elsewhere(&id) {
                return Ok(refused);
            }
            let body: DiscardRequest = req.parse()?;
            written(at.items.discard(&id, body.rev, answered_by(&req.caller)).await)
        }
    });
    let at = shared.clone();
    let answer = RouteDef::post("/api/inbox/{id}/answer", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            if let Some(refused) = elsewhere(&id) {
                return Ok(refused);
            }
            let body: AnswerRequest = req.parse()?;
            written(at.items.answer(&id, body.rev, &body.answer, answered_by(&req.caller)).await)
        }
    });
    let at = shared.clone();
    let send = RouteDef::post("/api/inbox/{id}/send", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            if let Some(refused) = elsewhere(&id) {
                return Ok(refused);
            }
            let body: SendRequest = req.parse()?;
            answered(at.items.send(&id, body.rev, body.doc, answered_by(&req.caller)).await, queued)
        }
    });
    let at = shared.clone();
    let delivery_read = RouteDef::get("/api/inbox/deliveries/{id}", move |req: Request| {
        let at = at.clone();
        async move {
            let id = item_id(&req);
            let lookup = id.clone();
            let row = at.store.read(move |tx| tx.inbox_deliveries().find(&lookup)).await?;
            let row = row.ok_or_else(|| eos_core::Error::not_found("delivery", &id))?;
            Ok(Response::json(200, &delivery(row)?))
        }
    });
    let user = |tier| Access::ui_token().phone_user(tier);
    vec![
        list.access(user(Tier::Read)),
        item.access(user(Tier::Read)),
        draft.access(user(Tier::Low)),
        later.access(user(Tier::Low)),
        discard.access(user(Tier::Low)),
        answer.access(user(Tier::High)),
        send.access(user(Tier::High)),
        delivery_read.access(user(Tier::Read)),
    ]
}
