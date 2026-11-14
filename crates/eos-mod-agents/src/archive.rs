//! Archiving a chat, restoring it, deleting archived ones, and the retention
//! sweep.

use std::time::Duration;

use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::AgentsModule;
use crate::routes::{actor_of, id_of};

/// How often archived chats past their retention are looked for.
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

pub(crate) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![archive(m.clone()), restore(m.clone()), purge(m.clone()), app_closed(m.clone())]
}

fn archive(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/archive", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            if let Some(actor) = actor_of(&req) {
                m.sessions.owned_by(&actor, &id).await?;
            }
            let done = m.sessions.archive(&id).await?;
            Ok(Response::json(200, &json!({"id": done.id, "archived": done.archived, "was_state": done.was_state})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn restore(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/restore", move |req: Request| {
        let m = m.clone();
        async move {
            let done = m.sessions.restore(&id_of(&req)).await?;
            Ok(Response::json(200, &json!({"id": done.id, "restored": done.restored})))
        }
    })
    .access(Access::open().phone(Tier::Low))
}

fn purge(m: AgentsModule) -> RouteDef {
    RouteDef::delete("/workers/{id}/purge", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            if let Some(actor) = actor_of(&req) {
                m.sessions.owned_by(&actor, &id).await?;
            }
            let gone = m.sessions.purge(&id).await?;
            Ok(Response::json(200, &json!({"id": gone.id, "removed": true, "name": gone.name})))
        }
    })
    .access(Access::open())
}

/// The window shell says the app is quitting: archived chats go when the
/// user asked for that.
fn app_closed(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/archived/app-closed", move |_req: Request| {
        let m = m.clone();
        async move {
            let purged = match m.spawning.config.current().archive.purge_on_app_close {
                true => m.sessions.purge_all_archived().await?,
                false => Vec::new(),
            };
            Ok(Response::json(200, &json!({"ok": true, "purged": purged})))
        }
    })
    .access(Access::open())
}

/// Purges archived chats past the configured retention, now and then every
/// hour. The retention is read at each sweep, so a change holds from the next.
pub(crate) async fn sweep(m: AgentsModule) {
    loop {
        let retention = m.spawning.config.current().archive.retention;
        match m.sessions.purge_expired_archives(retention).await {
            Ok(purged) if !purged.is_empty() => {
                tracing::info!(?retention, ?purged, "archived chats past their retention purged")
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "the archive retention sweep failed"),
        }
        tokio::time::sleep(SWEEP_EVERY).await;
    }
}
