//! A conversation's subagents and artifacts as summaries, and one subagent's
//! own rows: what the Subagents list, the Environment popover and the
//! artifacts list read, without the whole `subagent-events` answer.
//!
//! `GET /workers/:id/subagents`                 every subagent, in launch order
//! `GET /workers/:id/subagents/:callId/events`  the rows that rebuild one of them
//! `GET /workers/:id/artifacts`                 every artifact, newest first
//!
//! Each reads the facts kept beside the log (`conversation_list_facts`),
//! catching them up first when another build wrote rows since. Derivation runs
//! on the reader's thread, inside the read; what it gives is kept while the
//! worker's facts stay the same ([`Derived`]).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use eos_contracts::{WorkerArtifactsResponse, WorkerSubagentsResponse};
use eos_core::store::{Store, Tx};
use eos_domain::EventRecord;
use eos_domain::display::sanitize_event;
use eos_domain::transcript::{ConversationLists, rows_of_subagent};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::Value;

use crate::events::{wire, wire_into};
use crate::stream;

/// Rows read into the facts per write job, so other writes go between.
const CATCH_UP: i64 = 1_000;

/// Chats whose lists are kept.
const KEPT: usize = 16;

/// Both answers for one chat, as derived from one version of its facts.
struct Lists {
    subagents: WorkerSubagentsResponse,
    artifacts: WorkerArtifactsResponse,
}

/// What the lists were derived from: the worker's facts version and its
/// prompt offset.
type Source = (i64, u32);

/// The lists last derived for one chat.
struct Kept {
    worker_id: String,
    source: Source,
    lists: Arc<Lists>,
}

/// The lists last derived for each of the chats asked most recently: a switch
/// back to a chat, and the artifacts asked right after its subagents, derive
/// nothing.
#[derive(Default)]
struct Derived(Mutex<VecDeque<Kept>>);

impl Derived {
    fn get(&self, worker_id: &str, source: Source) -> Option<Arc<Lists>> {
        let mut kept = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let at = kept.iter().position(|k| k.worker_id == worker_id && k.source == source)?;
        let entry = kept.remove(at)?;
        let lists = entry.lists.clone();
        kept.push_front(entry);
        Some(lists)
    }

    fn put(&self, worker_id: &str, source: Source, lists: Arc<Lists>) {
        let mut kept = self.0.lock().unwrap_or_else(|p| p.into_inner());
        kept.retain(|k| k.worker_id != worker_id);
        kept.push_front(Kept { worker_id: worker_id.to_owned(), source, lists });
        kept.truncate(KEPT);
    }
}

/// The worker's lists, derived from its facts (brought up to its log first)
/// or kept from the last time they were the same.
async fn lists_of(store: &Arc<dyn Store>, derived: &Arc<Derived>, worker_id: &str) -> Result<Arc<Lists>, ApiError> {
    catch_up(store, worker_id).await?;
    let (id, derived) = (worker_id.to_owned(), derived.clone());
    let lists = store
        .read(move |tx| {
            let key = match tx.conversation_lists().version(&id)? {
                Some(version) => Some((version, boot_prompt_offset(tx, &id)?)),
                None => None,
            };
            if let Some(hit) = key.and_then(|key| derived.get(&id, key)) {
                return Ok(hit);
            }
            let rows = tx.conversation_lists().facts(&id)?;
            let lists = ConversationLists::derive(&rows, boot_prompt_offset(tx, &id)?);
            let on = lists.activity_rows();
            let inputs = if on.is_empty() { HashMap::new() } else { inputs_of(tx.events().find_many(&id, &on)?) };
            let lists = Arc::new(Lists {
                subagents: WorkerSubagentsResponse { subagents: lists.subagents(&inputs) },
                artifacts: WorkerArtifactsResponse { artifacts: lists.artifacts() },
            });
            if let Some(key) = key {
                derived.put(&id, key, lists.clone());
            }
            Ok(lists)
        })
        .await?;
    Ok(lists)
}

/// Brings the worker's facts up to its log.
async fn catch_up(store: &Arc<dyn Store>, worker_id: &str) -> Result<(), ApiError> {
    let id = worker_id.to_owned();
    if store.read(move |tx| tx.conversation_lists().is_current(&id)).await? {
        return Ok(());
    }
    loop {
        let id = worker_id.to_owned();
        if store.write(move |tx, _| tx.conversation_lists().catch_up(&id, CATCH_UP)).await? {
            return Ok(());
        }
    }
}

/// 1 when a dispatched worker's task card stands for a prompt with no row of
/// its own (the dashboard's `bootPromptOffset`): rewinds count prompts from it.
fn boot_prompt_offset(tx: &dyn Tx, worker_id: &str) -> Result<u32, eos_core::Error> {
    let worker = tx.workers().find(worker_id)?;
    Ok(u32::from(worker.is_some_and(|w| w.parent_id.is_some_and(|p| !p.is_empty()) && !w.prompt.is_empty())))
}

/// Each row's `input`, as a client reads the row.
fn inputs_of(rows: Vec<EventRecord>) -> HashMap<i64, Value> {
    rows.into_iter()
        .filter_map(|row| {
            let row = sanitize_event(row);
            let payload: Value = serde_json::from_str(row.payload.as_deref()?).ok()?;
            Some((row.id, payload.get("input").cloned().unwrap_or(Value::Null)))
        })
        .collect()
}

fn worker_id(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

pub(crate) fn routes(store: Arc<dyn Store>) -> Vec<RouteDef> {
    let derived = Arc::new(Derived::default());
    let subagents = {
        let (store, derived) = (store.clone(), derived.clone());
        move |req: Request| {
            let (store, derived) = (store.clone(), derived.clone());
            async move {
                let lists = lists_of(&store, &derived, &worker_id(&req)).await?;
                Ok(Response::json(200, &lists.subagents))
            }
        }
    };

    let subagent_rows = {
        let store = store.clone();
        move |req: Request| {
            let store = store.clone();
            async move {
                let id = worker_id(&req);
                let call = req.param("callId").unwrap_or_default().to_owned();
                catch_up(&store, &id).await?;
                let worker = id.clone();
                let ids = store
                    .read(move |tx| {
                        let rows = tx.conversation_lists().facts(&worker)?;
                        Ok(rows_of_subagent(&rows, boot_prompt_offset(tx, &worker)?, &call))
                    })
                    .await?;
                if ids.len() > stream::STREAM_ROWS {
                    return Ok(stream::rows(store, id, ids, wire_into));
                }
                let rows = store.read(move |tx| tx.events().find_many(&id, &ids)).await?;
                Ok(Response::json(200, &wire(rows)))
            }
        }
    };

    let artifacts = move |req: Request| {
        let (store, derived) = (store.clone(), derived.clone());
        async move {
            let lists = lists_of(&store, &derived, &worker_id(&req)).await?;
            Ok(Response::json(200, &lists.artifacts))
        }
    };

    // As `/workers/:id/subagent-events`: open on this computer and a paired
    // one's dashboard, not to the phone.
    vec![
        RouteDef::get("/workers/{id}/subagents", subagents).access(Access::open()),
        RouteDef::get("/workers/{id}/subagents/{callId}/events", subagent_rows).access(Access::open()),
        RouteDef::get("/workers/{id}/artifacts", artifacts).access(Access::open()),
    ]
}
