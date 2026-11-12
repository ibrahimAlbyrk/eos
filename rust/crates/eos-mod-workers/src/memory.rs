//! A worker's project memory: what Claude Code remembers of the project the
//! worker works in (`manager/routes/memory.ts`). A worktree worker reads its
//! source repository's, so every agent of a project shares the one memory.
//! Forgetting one needs the user's own dashboard.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::{MemoryListResponse, MemoryName};
use eos_core::store::{ProjectMemoryStore, Store};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

fn no_project() -> ApiError {
    ApiError::NotFound("worker not found or has no project directory".into())
}

/// The memory folder of the worker's project.
async fn dir_of(store: &dyn Store, memory: &dyn ProjectMemoryStore, id: &str) -> Result<std::path::PathBuf, ApiError> {
    let id = id.to_owned();
    let worker = store.read(move |tx| tx.workers().find(&id)).await?.ok_or_else(no_project)?;
    let project = worker.worktree_from.or(worker.cwd).ok_or_else(no_project)?;
    Ok(memory.dir_of(Path::new(&project)))
}

pub(crate) fn routes(store: Arc<dyn Store>, memory: Arc<dyn ProjectMemoryStore>) -> Vec<RouteDef> {
    let (list_store, list_memory) = (store.clone(), memory.clone());
    let list = RouteDef::get("/workers/{id}/memory", move |req: Request| {
        let (store, memory) = (list_store.clone(), list_memory.clone());
        async move {
            let dir = dir_of(store.as_ref(), memory.as_ref(), req.param("id").unwrap_or_default()).await?;
            let entries = memory.list(&dir);
            Ok(Response::json(200, &MemoryListResponse { dir: Some(dir.to_string_lossy().into_owned()), entries }))
        }
    })
    .access(Access::open().phone(Tier::Read));
    let forget = RouteDef::delete("/workers/{id}/memory/{name}", move |req: Request| {
        let (store, memory) = (store.clone(), memory.clone());
        async move {
            let name = req.param("name").unwrap_or_default().to_owned();
            let name: MemoryName = eos_contracts::parse(&Value::String(name))?;
            let dir = dir_of(store.as_ref(), memory.as_ref(), req.param("id").unwrap_or_default()).await?;
            if !memory.remove(&dir, &name.0)? {
                return Err(ApiError::NotFound(format!("memory \"{}\" not found", name.0)));
            }
            Ok(Response::json(200, &json!({"ok": true})))
        }
    })
    .access(Access::ui_token().phone_user(Tier::High));
    vec![list, forget]
}
