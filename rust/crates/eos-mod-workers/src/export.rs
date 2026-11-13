//! A conversation as one HTML file to download (`manager/routes/export.ts`):
//! the export page with the worker's timeline (and with `?tree=true` its
//! whole subtree's) in a JSON block the page renders.

use std::collections::HashMap;
use std::sync::Arc;

use eos_core::Clock;
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_domain::EventRecord;
use eos_domain::display::sanitize_value;
use eos_domain::time::iso_from_ms;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Body, Request, Response};
use eos_runtime::router::RouteDef;

use crate::stream;
use serde_json::{Map, Value, json};

const TEMPLATE: &str = include_str!("../assets/export.html");
const PLACEHOLDER: &str = r#"<script id="export-data" type="application/json">{}</script>"#;
/// Every row of a timeline.
const ALL_ROWS: i64 = 1_000_000;

/// What the page renders: the workers by id, and where each row of their
/// timelines comes from, in the page's order (by time).
struct Plan {
    workers: Map<String, Value>,
    /// Each row: its worker (an index into `walk`) and its id.
    rows: Vec<(usize, i64)>,
    /// The workers in the walk's order: id and name.
    walk: Vec<(String, String)>,
    /// The name the file is called after.
    root_name: String,
}

async fn plan(store: &dyn Store, root: String, tree: bool) -> Result<Option<Plan>, eos_core::Error> {
    store
        .read(move |tx| {
            let Some(worker) = tx.workers().find(&root)? else { return Ok(None) };
            let root_name = worker.name.clone().unwrap_or_else(|| worker.id.clone());
            // The subtree depth first, each worker before its children, as today's walk.
            let mut ids = Vec::new();
            let mut stack = vec![root];
            while let Some(id) = stack.pop() {
                if tree {
                    stack.extend(tx.workers().find_children_ids(&id)?.into_iter().rev());
                }
                ids.push(id);
            }
            let (mut workers, mut walk, mut rows) = (Map::new(), Vec::new(), Vec::new());
            for id in ids {
                let Some(w) = tx.workers().find(&id)? else { continue };
                let name = w.name.clone().unwrap_or_else(|| id.clone());
                workers.insert(id.clone(), json!({"name": name, "is_orchestrator": w.is_orchestrator}));
                let query = EventQuery {
                    worker_id: id.clone(),
                    since: 0,
                    limit: ALL_ROWS,
                    order: EventOrder::Asc,
                    before_id: None,
                    after_id: None,
                };
                let at = walk.len();
                rows.extend(tx.events().list_ids(&query)?.into_iter().map(|(row, ts)| (ts, at, row)));
                walk.push((id, name));
            }
            // A stable sort: rows of the same time keep the walk's order.
            rows.sort_by_key(|(ts, _, _)| *ts);
            let rows = rows.into_iter().map(|(_, at, row)| (at, row)).collect();
            Ok(Some(Plan { workers, rows, walk, root_name }))
        })
        .await
}

/// One row as the page's data holds it.
fn event(worker_id: &str, worker_name: &str, row: EventRecord) -> Value {
    let mut payload = match row.payload.as_deref().filter(|p| !p.is_empty()) {
        Some(text) => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned())),
        None => Value::Null,
    };
    sanitize_value(&mut payload);
    json!({
        "worker_id": worker_id, "worker_name": worker_name, "event_id": row.id, "ts": row.ts, "type": row.kind,
        "payload": payload,
    })
}

/// The rows of `slice` (worker index and id), in its order.
async fn read_rows(
    store: &dyn Store,
    walk: &[(String, String)],
    slice: &[(usize, i64)],
) -> Result<Vec<(usize, EventRecord)>, eos_core::Error> {
    let mut by_worker: Vec<(usize, Vec<i64>)> = Vec::new();
    for (at, id) in slice {
        match by_worker.iter_mut().find(|(w, _)| w == at) {
            Some((_, ids)) => ids.push(*id),
            None => by_worker.push((*at, vec![*id])),
        }
    }
    let mut found: HashMap<i64, (usize, EventRecord)> = HashMap::new();
    for (at, ids) in by_worker {
        let worker = walk[at].0.clone();
        let rows = store.read(move |tx| tx.events().find_many(&worker, &ids)).await?;
        found.extend(rows.into_iter().map(|row| (row.id, (at, row))));
    }
    // A row pruned since the plan was made is left out.
    Ok(slice.iter().filter_map(|(_, id)| found.remove(id)).collect())
}

/// JSON for inside the page's script element: `<` is escaped, so nothing in
/// the data can close it.
fn escaped(json: &str) -> String {
    json.replace('<', "\\u003c")
}

/// The page with the data in its JSON block.
fn page(data: &Value) -> String {
    let json = escaped(&data.to_string());
    match TEMPLATE.find(PLACEHOLDER) {
        Some(at) => format!(
            r#"{}<script id="export-data" type="application/json">{json}</script>{}"#,
            &TEMPLATE[..at],
            &TEMPLATE[at + PLACEHOLDER.len()..]
        ),
        None => TEMPLATE.to_owned(),
    }
}

/// A page of many rows, written as they are read (`stream`): the same bytes
/// as [`page`] of the whole data. `None` when the page has nowhere to put them.
fn streamed_page(store: Arc<dyn Store>, plan: Plan, now: String) -> Option<Body> {
    let at = TEMPLATE.find(PLACEHOLDER)?;
    let (tx, body) = Body::channel(4);
    // `{"exported_at":…,"workers":{…}` and then the events.
    let head = json!({"exported_at": now, "workers": plan.workers}).to_string();
    let head = escaped(&head[..head.len() - 1]);
    let prefix = format!(r#"{}<script id="export-data" type="application/json">{head},"events":["#, &TEMPLATE[..at]);
    let suffix = format!("]}}</script>{}", &TEMPLATE[at + PLACEHOLDER.len()..]);
    tokio::spawn(async move {
        let mut out = stream::ArrayWriter::over(tx, prefix.as_bytes());
        for slice in plan.rows.chunks(100) {
            let rows = match read_rows(store.as_ref(), &plan.walk, slice).await {
                Ok(rows) => rows,
                Err(e) => return out.fail(e.to_string()).await,
            };
            for (at, row) in rows {
                let (id, name) = &plan.walk[at];
                let text = escaped(&event(id, name, row).to_string());
                if out.item(|buf| buf.extend_from_slice(text.as_bytes())).await.is_err() {
                    return;
                }
            }
        }
        out.finish(suffix.as_bytes()).await;
    });
    Some(body)
}

/// The `content-disposition` of a download called `name` (RFC 6266). A name
/// of plain ASCII goes as today: `filename="…"`. Any other carries the real
/// name in `filename*` (RFC 5987: UTF-8, percent-encoded) and an ASCII stand-in
/// in `filename`, each other character an `_`. `filename*` comes first, so a
/// reader that looks for `filename="` finds the stand-in, never both.
fn attachment(name: &str) -> String {
    let plain = |c: char| c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\';
    if name.chars().all(plain) {
        return format!("attachment; filename=\"{name}\"");
    }
    let stand_in: String = name.chars().map(|c| if plain(c) { c } else { '_' }).collect();
    let mut encoded = String::with_capacity(name.len() * 3);
    for byte in name.bytes() {
        // RFC 5987's attr-char: what may stand as it is.
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename*=UTF-8''{encoded}; filename=\"{stand_in}\"")
}

pub(crate) fn route(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> RouteDef {
    RouteDef::get("/workers/{id}/export", move |req: Request| {
        let (store, clock) = (store.clone(), clock.clone());
        async move {
            let id = req.param("id").unwrap_or_default().to_owned();
            let tree = req.query().get("tree").as_deref() == Some("true");
            let plan = plan(store.as_ref(), id, tree).await?;
            let plan = plan.ok_or_else(|| ApiError::NotFound("worker not found".into()))?;
            let now = iso_from_ms(clock.now_ms());
            let disposition = attachment(&format!("export-{}-{}.html", plan.root_name, &now[..10]));
            const HTML: &str = "text/html; charset=utf-8";
            // A long conversation leaves in slices; a short one at once.
            if plan.rows.len() > stream::STREAM_ROWS {
                if let Some(body) = streamed_page(store.clone(), plan, now) {
                    let response = Response::new(200).header("content-type", HTML).body(body);
                    return Ok(response.header("content-disposition", disposition));
                }
                return Ok(Response::bytes(200, HTML, TEMPLATE).header("content-disposition", disposition));
            }
            let rows = read_rows(store.as_ref(), &plan.walk, &plan.rows).await?;
            let events: Vec<Value> =
                rows.into_iter().map(|(at, row)| event(&plan.walk[at].0, &plan.walk[at].1, row)).collect();
            let html = page(&json!({"exported_at": now, "workers": plan.workers, "events": events}));
            Ok(Response::bytes(200, HTML, html).header("content-disposition", disposition))
        }
    })
    .access(Access::open())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_lands_in_its_block_and_cannot_close_it() {
        let html = page(&json!({"text": "</script><b>"}));
        let escaped = "{\"text\":\"\\u003c/script>\\u003cb>\"}";
        assert!(html.contains(&format!(r#"<script id="export-data" type="application/json">{escaped}</script>"#)));
        assert!(!html.contains(PLACEHOLDER));
    }

    #[test]
    fn a_plain_name_is_sent_as_today_and_any_other_with_its_utf8_form() {
        assert_eq!(
            attachment("export-Notes 1-2026-11-12.html"),
            r#"attachment; filename="export-Notes 1-2026-11-12.html""#
        );
        assert_eq!(
            attachment("export-şişe ğı-2026-11-12.html"),
            "attachment; filename*=UTF-8''export-%C5%9Fi%C5%9Fe%20%C4%9F%C4%B1-2026-11-12.html; \
             filename=\"export-_i_e __-2026-11-12.html\""
        );
        assert_eq!(
            attachment("export-日本 🍾-x.html"),
            "attachment; filename*=UTF-8''export-%E6%97%A5%E6%9C%AC%20%F0%9F%8D%BE-x.html; filename=\"export-__ _-x.html\""
        );
        // A quote or a backslash would end or escape the plain form.
        assert_eq!(
            attachment(r#"export-say "hi"\.html"#),
            "attachment; filename*=UTF-8''export-say%20%22hi%22%5C.html; filename=\"export-say _hi__.html\""
        );
        for name in ["export-şişe.html", "export-日本.html", "export-🍾.html"] {
            assert!(attachment(name).is_ascii(), "a header value is ASCII: {name}");
        }
    }
}
