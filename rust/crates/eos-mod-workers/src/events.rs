//! A worker's event log: transcript pages, and the lists that span the whole
//! conversation (the transcript itself is read in pages).

use std::borrow::Cow;
use std::sync::Arc;

use eos_contracts::{WorkerAttachmentsResponse, WorkerEventRow, WorkerEventType};

use crate::stream;
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_domain::EventRecord;
use eos_domain::display::sanitize_event;
use eos_domain::transcript::{
    PROMPT_EVENT_TYPES, SUBAGENT_ROW_KINDS, SubagentRowMeta, attachments_of, select_subagent_ids,
};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;

#[derive(Serialize)]
struct QueuedItem {
    id: i64,
    /// What the composer shows: the text as the user typed it.
    text: String,
    ts: i64,
}

#[derive(Serialize)]
struct QueueResponse {
    messages: Vec<QueuedItem>,
}

const DEFAULT_LIMIT: i64 = 500;
const MAX_LIMIT: i64 = 5000;

/// A query value as `z.coerce.number().int()` reads it: JavaScript's
/// `Number(text)`, which must then be a whole number. `Err` is Zod's message.
fn whole_number(raw: &str) -> Result<i64, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let looks_numeric = trimmed.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'));
    match trimmed.parse::<f64>() {
        Ok(n) if looks_numeric && n.is_finite() && n.fract() == 0.0 => Ok(n as i64),
        Ok(n) if looks_numeric && n.is_finite() => Err("Expected integer, received float"),
        _ => Err("Expected number, received nan"),
    }
}

type Issues = Vec<(&'static str, Cow<'static, str>)>;

/// One numeric query value: absent gives `default`; a value that is not a
/// whole number, or is out of range, is noted in `issues`.
fn number(
    req: &Request,
    key: &'static str,
    default: Option<i64>,
    min: i64,
    max: Option<i64>,
    issues: &mut Issues,
) -> Option<i64> {
    let Some(raw) = req.query().get(key) else { return default };
    let value = match whole_number(&raw) {
        Ok(n) => n,
        Err(message) => {
            issues.push((key, message.into()));
            return default;
        }
    };
    if value < min {
        let bound = if min == 1 { "greater than 0".to_owned() } else { format!("greater than or equal to {min}") };
        issues.push((key, format!("Number must be {bound}").into()));
    } else if let Some(max) = max.filter(|max| value > *max) {
        issues.push((key, format!("Number must be less than or equal to {max}").into()));
    }
    Some(value)
}

/// The page a transcript request asks for (`EventsQuerySchema`). Every broken
/// value is reported, in the schema's order and Zod's words.
fn page_query(worker_id: &str, req: &Request) -> Result<EventQuery, ApiError> {
    let mut issues = Issues::new();
    let since = number(req, "since", Some(0), 0, None, &mut issues).unwrap_or(0);
    let limit = number(req, "limit", Some(DEFAULT_LIMIT), 1, Some(MAX_LIMIT), &mut issues).unwrap_or(DEFAULT_LIMIT);
    let order = match req.query().get("order").as_deref() {
        None | Some("desc") => EventOrder::Desc,
        Some("asc") => EventOrder::Asc,
        Some(other) => {
            issues.push(("order", format!("Invalid enum value. Expected 'asc' | 'desc', received '{other}'").into()));
            EventOrder::Desc
        }
    };
    let before_id = number(req, "beforeId", None, 1, None, &mut issues);
    let after_id = number(req, "afterId", None, 0, None, &mut issues);
    if !issues.is_empty() {
        return Err(ApiError::invalid(issues));
    }
    Ok(EventQuery { worker_id: worker_id.to_owned(), since, limit, order, before_id, after_id })
}

/// Rows as clients read them: wrappers the model saw are stripped from a
/// copy, the payload stays JSON text.
fn wire(rows: Vec<EventRecord>) -> Vec<WorkerEventRow> {
    rows.into_iter().map(|row| sanitize_event(row).into_row()).collect()
}

/// One row as [`wire`] writes it, inside a list.
fn wire_into(row: EventRecord, buf: &mut Vec<u8>) {
    // A row is plain data: serializing it into memory cannot fail.
    let _ = serde_json::to_writer(buf, &sanitize_event(row).into_row());
}

/// Rows read a slice at a time when a whole log is scanned.
const SCAN: i64 = 1_000;

fn worker_id(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

pub(crate) fn routes(store: Arc<dyn Store>) -> Vec<RouteDef> {
    // An unknown worker has an empty log: 200 `[]`, as today.
    let page = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let query = page_query(&worker_id(&req), &req)?;
                // A page of thousands of rows leaves in slices.
                if query.limit > stream::STREAM_ROWS as i64 {
                    let picked = query.clone();
                    let ids = store.read(move |tx| tx.events().list_ids(&picked)).await?;
                    if ids.len() > stream::STREAM_ROWS {
                        let ids = ids.into_iter().map(|(id, _)| id).collect();
                        return Ok(stream::rows(store, query.worker_id, ids, wire_into));
                    }
                }
                let rows = store.read(move |tx| tx.events().list(&query)).await?;
                Ok(Response::json(200, &wire(rows)))
            }
        }
    };

    // The prompts and the markers that hide some of them, for the turn index.
    let prompts = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let id = worker_id(&req);
                let mut rows = store
                    .read(move |tx| {
                        let mut rows = Vec::new();
                        for kind in PROMPT_EVENT_TYPES {
                            rows.extend(tx.events().list_by_type(&id, kind, None)?);
                        }
                        Ok(rows)
                    })
                    .await?;
                rows.sort_by_key(|row| (row.ts, row.id));
                Ok(Response::json(200, &wire(rows)))
            }
        }
    };

    // What the Subagents panel and the Artifacts list need of the whole conversation.
    let subagents = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let id = worker_id(&req);
                // The whole log is judged a slice at a time; only the facts the
                // selection needs are kept of each row.
                let mut facts: Vec<SubagentRowMeta> = Vec::new();
                let mut after = 0;
                loop {
                    let worker = id.clone();
                    let read = store
                        .read(move |tx| {
                            let rows = tx.events().scan(&worker, &SUBAGENT_ROW_KINDS, after, SCAN)?;
                            Ok(rows.iter().map(SubagentRowMeta::of).collect::<Vec<_>>())
                        })
                        .await?;
                    let done = (read.len() as i64) < SCAN;
                    after = read.last().map_or(after, |row| row.id);
                    // Rows from time 0 on, as the whole log was read before.
                    facts.extend(read.into_iter().filter(|row| row.ts > 0));
                    if done {
                        break;
                    }
                }
                let ids = select_subagent_ids(&facts);
                drop(facts);
                if ids.len() > stream::STREAM_ROWS {
                    return Ok(stream::rows(store, id, ids, wire_into));
                }
                let rows = store.read(move |tx| tx.events().find_many(&id, &ids)).await?;
                Ok(Response::json(200, &wire(rows)))
            }
        }
    };

    // The user's messages waiting for a busy worker: the composer's pills. An
    // agent's queued message (a report for a busy parent) is never shown here.
    let queue = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let id = worker_id(&req);
                let waiting = store.read(move |tx| tx.message_queue().list_pending_user_plane(&id)).await?;
                let messages = waiting
                    .into_iter()
                    .map(|m| QueuedItem { id: m.id, text: m.meta.display_text.unwrap_or(m.text), ts: m.created_at })
                    .collect();
                Ok(Response::json(200, &QueueResponse { messages }))
            }
        }
    };

    // Every file attached anywhere in the conversation.
    let attachments = move |req: Request| {
        let store = store.clone();
        async move {
            let id = worker_id(&req);
            let messages =
                store.read(move |tx| tx.events().list_by_type(&id, WorkerEventType::UserMessage, None)).await?;
            Ok(Response::json(200, &WorkerAttachmentsResponse { attachments: attachments_of(&messages) }))
        }
    };

    vec![
        RouteDef::get("/workers/{id}/events", page).access(Access::open().phone(Tier::Read)),
        RouteDef::get("/workers/{id}/queue", queue).access(Access::open().phone(Tier::Read)),
        RouteDef::get("/workers/{id}/prompt-events", prompts).access(Access::open()),
        RouteDef::get("/workers/{id}/subagent-events", subagents).access(Access::open()),
        RouteDef::get("/workers/{id}/attachments", attachments).access(Access::open()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_numbers_read_as_javascript_reads_them() {
        assert_eq!(whole_number("5"), Ok(5));
        assert_eq!(whole_number(" 12 "), Ok(12));
        assert_eq!(whole_number(""), Ok(0));
        assert_eq!(whole_number("1e3"), Ok(1000));
        assert_eq!(whole_number("1.5"), Err("Expected integer, received float"));
        assert_eq!(whole_number("abc"), Err("Expected number, received nan"));
        assert_eq!(whole_number("inf"), Err("Expected number, received nan"));
    }
}
