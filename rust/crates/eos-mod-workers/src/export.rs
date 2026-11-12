//! A conversation as one HTML file to download (`manager/routes/export.ts`):
//! the export page with the worker's timeline (and with `?tree=true` its
//! whole subtree's) in a JSON block the page renders.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_domain::display::sanitize_value;
use eos_domain::time::iso_from_ms;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Map, Value, json};

const TEMPLATE: &str = include_str!("../assets/export.html");
const PLACEHOLDER: &str = r#"<script id="export-data" type="application/json">{}</script>"#;
/// Every row of a timeline.
const ALL_ROWS: i64 = 1_000_000;

/// What the page renders: the workers by id, and every row of their timelines by time.
struct Export {
    workers: Map<String, Value>,
    events: Vec<(i64, Value)>,
    /// The name the file is called after.
    root_name: String,
}

async fn collect(store: &dyn Store, root: String, tree: bool) -> Result<Option<Export>, eos_core::Error> {
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
            let (mut workers, mut events) = (Map::new(), Vec::new());
            for id in ids {
                let Some(w) = tx.workers().find(&id)? else { continue };
                let name = w.name.clone().unwrap_or_else(|| id.clone());
                let looped = tx.loops().find_any_by_worker(&id)?.map(|l| json!({"status": l.status}));
                workers.insert(id.clone(), json!({"name": name, "is_orchestrator": w.is_orchestrator, "loop": looped}));
                let query = EventQuery {
                    worker_id: id.clone(),
                    since: 0,
                    limit: ALL_ROWS,
                    order: EventOrder::Asc,
                    before_id: None,
                    after_id: None,
                };
                for row in tx.events().list(&query)? {
                    let mut payload = match row.payload.as_deref().filter(|p| !p.is_empty()) {
                        Some(text) => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned())),
                        None => Value::Null,
                    };
                    sanitize_value(&mut payload);
                    let event = json!({
                        "worker_id": id, "worker_name": name, "event_id": row.id, "ts": row.ts, "type": row.kind,
                        "payload": payload,
                    });
                    events.push((row.ts, event));
                }
            }
            // A stable sort: rows of the same time keep the walk's order.
            events.sort_by_key(|(ts, _)| *ts);
            Ok(Some(Export { workers, events, root_name }))
        })
        .await
}

/// The page with the data in its JSON block. `<` is escaped, so nothing in the
/// data can close the script element.
fn page(data: &Value) -> String {
    let json = data.to_string().replace('<', "\\u003c");
    match TEMPLATE.find(PLACEHOLDER) {
        Some(at) => format!(
            r#"{}<script id="export-data" type="application/json">{json}</script>{}"#,
            &TEMPLATE[..at],
            &TEMPLATE[at + PLACEHOLDER.len()..]
        ),
        None => TEMPLATE.to_owned(),
    }
}

pub(crate) fn route(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> RouteDef {
    RouteDef::get("/workers/{id}/export", move |req: Request| {
        let (store, clock) = (store.clone(), clock.clone());
        async move {
            let id = req.param("id").unwrap_or_default().to_owned();
            let tree = req.query().get("tree").as_deref() == Some("true");
            let export = collect(store.as_ref(), id, tree).await?;
            let export = export.ok_or_else(|| ApiError::NotFound("worker not found".into()))?;
            let now = iso_from_ms(clock.now_ms());
            let events: Vec<Value> = export.events.into_iter().map(|(_, event)| event).collect();
            let html = page(&json!({"exported_at": now, "workers": export.workers, "events": events}));
            let disposition = format!("attachment; filename=\"export-{}-{}.html\"", export.root_name, &now[..10]);
            Ok(Response::bytes(200, "text/html; charset=utf-8", html).header("content-disposition", disposition))
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
}
