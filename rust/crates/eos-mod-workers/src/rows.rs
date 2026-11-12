//! Worker rows: the lists and one row.

use std::collections::HashMap;
use std::sync::Arc;

use eos_contracts::{WorkerContext, WorkerRow};
use eos_core::Error;
use eos_core::agent::{ModelCatalog, OpenQuestions};
use eos_core::store::{Store, Tx};
use eos_domain::context::context_pct;
use eos_domain::worker::{Ownership, ownership};
use eos_domain::{Worker, WorkerLoop};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

/// A list row carries this much of the first prompt when the caller asks for
/// brief rows; the whole text is one `GET /workers/{id}` away. The dashboard
/// refetches the list on nearly every change, and most of a row is its prompt.
const PROMPT_PREVIEW_UNITS: usize = 280;

/// The first `max` UTF-16 units of `text` (JavaScript's `slice`), or `None`
/// when it is no longer than that. A character that straddles the cut is left out.
fn clipped(text: &str, max: usize) -> Option<String> {
    if text.encode_utf16().count() <= max {
        return None;
    }
    let mut units = 0;
    let kept = text.chars().take_while(|c| {
        units += c.len_utf16();
        units <= max
    });
    Some(kept.collect())
}

/// Rows as the wire carries them, with the parts a row does not store.
struct Rows {
    rows: Vec<WorkerRow>,
}

impl Rows {
    fn of(workers: &[Worker]) -> Self {
        Self { rows: workers.iter().map(Worker::to_row).collect() }
    }

    /// Each worker's active goal loop. A loop rests between checks, so it
    /// shows whatever the worker's state.
    fn with_loops(mut self, active: &[WorkerLoop]) -> Self {
        let by_worker: HashMap<&str, &WorkerLoop> = active.iter().map(|l| (l.worker_id.as_str(), l)).collect();
        for row in &mut self.rows {
            row.r#loop = by_worker.get(row.id.as_str()).map(|l| l.to_row());
        }
        self
    }

    /// How full each context window is: `{ used, limit, pct }`.
    fn with_context(mut self, models: &dyn ModelCatalog) -> Self {
        for row in &mut self.rows {
            let model = row.model.as_ref().and_then(|m| m.as_deref());
            let limit = models.context_window_for(model);
            let used = row.last_context_tokens.flatten().map_or(0, |n| n.0 as i64);
            row.context = Some(WorkerContext {
                used: used.into(),
                limit: Some(limit.into()),
                pct: context_pct(used, Some(limit)).map(Into::into),
            });
        }
        self
    }

    /// Which workers wait on the user's answer, so the sidebar shows it
    /// without the chat loaded.
    fn with_questions(mut self, questions: Option<&dyn OpenQuestions>) -> Self {
        if let Some(questions) = questions {
            for row in &mut self.rows {
                if questions.has_open(&row.id) {
                    row.awaiting_question = Some(true);
                }
            }
        }
        self
    }

    fn brief(mut self, brief: bool) -> Self {
        if brief {
            for row in &mut self.rows {
                if let Some(preview) = clipped(&row.prompt, PROMPT_PREVIEW_UNITS) {
                    row.prompt = preview;
                    row.prompt_clipped = Some(true);
                }
            }
        }
        self
    }
}

fn wants_brief(req: &Request) -> bool {
    req.query().get("brief").as_deref() == Some("1")
}

fn not_found() -> ApiError {
    ApiError::NotFound("not found".into())
}

/// The rows of `GET /workers`: never archived ones (archived chats are
/// invisible to agents, and both the dashboard's tree and the agents' list
/// read this route).
fn listed(tx: &dyn Tx, parent_id: Option<&str>) -> Result<(Vec<Worker>, Vec<WorkerLoop>), Error> {
    let workers = match parent_id {
        Some(parent) => tx.workers().list_by_parent(parent)?.into_iter().filter(|w| !w.is_archived()).collect(),
        None => tx.workers().list_active()?,
    };
    Ok((workers, tx.loops().list_active()?))
}

pub(crate) fn routes(
    store: Arc<dyn Store>,
    models: Arc<dyn ModelCatalog>,
    questions: Option<Arc<dyn OpenQuestions>>,
) -> Vec<RouteDef> {
    let list = {
        let (store, models) = (store.clone(), models.clone());
        move |req: Request| {
            let (store, models, questions) = (store.clone(), models.clone(), questions.clone());
            async move {
                let parent = req.query().get("parentId").filter(|p| !p.is_empty()).map(|p| p.into_owned());
                let (workers, loops) = store.read(move |tx| listed(tx, parent.as_deref())).await?;
                let rows = Rows::of(&workers)
                    .with_loops(&loops)
                    .with_context(models.as_ref())
                    .with_questions(questions.as_deref())
                    .brief(wants_brief(&req));
                Ok(Response::json(200, &rows.rows))
            }
        }
    };

    // Only the dashboard's Archive view reads this.
    let archived = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let workers = store.read(|tx| tx.workers().list_archived()).await?;
                Ok(Response::json(200, &Rows::of(&workers).brief(wants_brief(&req)).rows))
            }
        }
    };

    let orchestrators = {
        let store = store.clone();
        move |_req: Request| {
            let store = store.clone();
            async move {
                let workers = store.read(|tx| tx.workers().list_orchestrators()).await?;
                Ok(Response::json(200, &Rows::of(&workers).rows))
            }
        }
    };

    let one = move |req: Request| {
        let (store, models) = (store.clone(), models.clone());
        async move {
            let id = req.param("id").unwrap_or_default().to_owned();
            // `actorId` marks an agent reading through its tools: it sees its
            // own row and its workers', and never an archived one.
            let actor = req.query().get("actorId").filter(|a| !a.is_empty()).map(|a| a.into_owned());
            let (worker, active_loop) = store
                .read({
                    let id = id.clone();
                    move |tx| Ok((tx.workers().find(&id)?, tx.loops().find_active_by_worker(&id)?))
                })
                .await?;
            if let Some(actor) = &actor {
                match ownership(worker.as_ref(), &id, actor, true) {
                    Ownership::Owned => {}
                    Ownership::Missing => return Err(Error::not_found("worker", id).into()),
                    Ownership::NotManaged => {
                        return Err(ApiError::PermissionDenied(format!("worker {id} is not managed by {actor}")));
                    }
                }
            }
            let worker = worker.filter(|w| actor.is_none() || !w.is_archived()).ok_or_else(not_found)?;
            let rows = Rows::of(std::slice::from_ref(&worker))
                .with_loops(active_loop.as_slice())
                .with_context(models.as_ref());
            Ok(Response::json(200, &rows.rows[0]))
        }
    };

    let read = Access::open().phone(Tier::Read);
    vec![
        RouteDef::get("/workers", list).access(read),
        RouteDef::get("/workers/archived", archived).access(read),
        RouteDef::get("/workers/{id}", one).access(read),
        RouteDef::get("/orchestrators", orchestrators).access(read),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_is_clipped_by_utf16_units_as_javascript_slices() {
        assert_eq!(clipped("short", 280), None);
        assert_eq!(clipped(&"a".repeat(280), 280), None);
        assert_eq!(clipped(&"a".repeat(281), 280).map(|s| s.len()), Some(280));
        // An emoji is two units: 140 of them fill the preview exactly.
        let emoji = "😀".repeat(141);
        assert_eq!(clipped(&emoji, 280).map(|s| s.chars().count()), Some(140));
        assert_eq!(
            clipped(&format!("a{emoji}"), 280).map(|s| s.chars().count()),
            Some(140),
            "the straddling one is dropped"
        );
    }
}
