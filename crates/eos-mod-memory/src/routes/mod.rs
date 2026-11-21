//! Memory's routes: the screen's head, what a chat or a run was reminded
//! of, where stated rules were said, the two switches and "Tidy now"; the routes over
//! notes are in [`notes`], forgetting everything and the export in [`everything`].

mod everything;
mod notes;
mod view;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{
    ExperienceHealth, ExperienceRecalled, ExperienceRecalledNote, ExperienceScopeCount, ExperienceSettings,
    ExperienceStated, ExperienceStatedRule, ExperienceSummary, ExperienceTidy, UserMemoryStatus,
};
use eos_core::git::ProjectKeys;
use eos_core::profile::UserMemoryReader;
use eos_core::store::Store;
use eos_core::{Clock, Ids};
use eos_domain::redact::Scrubber;
use eos_memory::Credit;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use indexmap::IndexMap;

use crate::EmbedderHealth;

/// The rolling window of the weekly count.
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// What the routes read and write through.
pub(crate) struct Api {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) credit: Arc<Credit>,
    pub(crate) memories: Arc<dyn UserMemoryReader>,
    pub(crate) project_keys: Arc<dyn ProjectKeys>,
    pub(crate) health: Arc<Mutex<EmbedderHealth>>,
    /// Cuts secrets, e-mail addresses and the home folder from what the user types.
    pub(crate) scrubber: Arc<Scrubber>,
    pub(crate) device: String,
    /// Night tidying, when reflection is composed.
    pub(crate) nightly: Option<Arc<crate::night::Nightly>>,
}

async fn summary(api: Arc<Api>) -> Result<Response, ApiError> {
    let since = api.clock.now_ms() - WEEK_MS;
    let (counts, learned, pending, stated, settings) = api
        .store
        .read(move |tx| {
            let notes = tx.mem_notes();
            let stated = tx.mem_book().stated()?;
            // A rule kept in About you counts here; one kept as a note is among the notes.
            let stated = stated.iter().filter(|s| s.at >= since && !s.memory_id.starts_with("mn-")).count() as i64;
            Ok((
                notes.live_counts()?,
                notes.learned_since(since)?,
                tx.mem_moments().count_pending()?,
                stated,
                eos_memory::settings::read_in(tx)?,
            ))
        })
        .await?;
    let labels = view::labels(api.project_keys.as_ref(), counts.iter().map(|c| c.scope.clone()).collect()).await;
    let mut kinds = BTreeMap::<String, i64>::new();
    let mut scopes = IndexMap::<(String, String), ExperienceScopeCount>::new();
    for count in &counts {
        *kinds.entry(count.kind.as_str().to_owned()).or_default() += count.count;
        let shown = view::scope(&count.scope, &labels);
        scopes
            .entry((shown.level.clone(), shown.key.clone()))
            .or_insert(ExperienceScopeCount { level: shown.level, key: shown.key, label: shown.label, count: 0 })
            .count += count.count;
    }
    let about_you = api.memories.list().iter().filter(|m| m.status == UserMemoryStatus::Active).count() as i64;
    let embedder = *api.health.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(Response::json(
        200,
        &ExperienceSummary {
            about_you,
            learned: counts.iter().map(|c| c.count).sum(),
            weekly: learned + stated,
            scopes: scopes.into_values().collect(),
            kinds: kinds.into_iter().collect(),
            health: ExperienceHealth {
                embedder: embedder.word().to_owned(),
                pending_moments: pending,
                learning: settings.learning,
                reminders: settings.reminders,
            },
        },
    ))
}

async fn recalled(api: Arc<Api>, req: Request) -> Result<Response, ApiError> {
    let given = |key: &str| req.query().get(key).filter(|v| !v.is_empty()).map(|v| v.into_owned());
    let (worker_id, run_id) = (given("workerId"), given("runId"));
    if worker_id.is_none() && run_id.is_none() {
        return Err(ApiError::invalid([("workerId", "Give a workerId or a runId")]));
    }
    let (uses, notes, first) = api
        .store
        .read(move |tx| {
            let uses = match (&run_id, &worker_id) {
                (Some(run), _) => tx.mem_uses().of_run(run)?,
                (None, Some(worker)) => tx.mem_uses().of_worker(worker, 0)?,
                (None, None) => Vec::new(),
            };
            let ids: HashSet<&str> = uses.iter().map(|u| u.note_id.as_str()).collect();
            let mut notes = Vec::new();
            for id in ids {
                notes.extend(tx.mem_notes().find(id)?.filter(|n| n.forgotten_at.is_none()));
            }
            let first = view::first_evidence_in(tx, &notes)?;
            Ok((uses, notes, first))
        })
        .await?;
    let labels = view::labels(api.project_keys.as_ref(), notes.iter().map(|n| n.note.scope.clone()).collect()).await;
    let shown = uses
        .iter()
        .filter_map(|u| {
            let note = notes.iter().find(|n| n.note.id == u.note_id)?;
            Some(ExperienceRecalledNote { row: view::row(note, &first, &labels), how: u.how.clone(), at: u.at })
        })
        .collect();
    Ok(Response::json(200, &ExperienceRecalled { notes: shown }))
}

async fn stated(api: Arc<Api>) -> Result<Response, ApiError> {
    let rows = api.store.read(|tx| tx.mem_book().stated()).await?;
    let rules = rows
        .into_iter()
        .map(|s| ExperienceStatedRule { memory_id: s.memory_id, worker_id: s.worker_id, row_id: s.row_id, at: s.at })
        .collect();
    Ok(Response::json(200, &ExperienceStated { rules }))
}

pub(crate) fn all(api: &Arc<Api>) -> Vec<RouteDef> {
    let at = api.clone();
    let summary = RouteDef::get("/api/memory/summary", move |_req: Request| summary(at.clone()));
    let at = api.clone();
    let recalled = RouteDef::get("/api/memory/recalled", move |req: Request| recalled(at.clone(), req));
    let at = api.clone();
    let stated = RouteDef::get("/api/memory/stated", move |_req: Request| stated(at.clone()));
    let at = api.clone();
    let read_settings = RouteDef::get("/api/memory/settings", move |_req: Request| {
        let at = at.clone();
        async move {
            let settings = at.store.read(eos_memory::settings::read_in).await?;
            Ok(Response::json(200, &settings))
        }
    });
    let at = api.clone();
    let write_settings = RouteDef::put("/api/memory/settings", move |req: Request| {
        let at = at.clone();
        async move {
            let settings: ExperienceSettings = req.parse()?;
            at.store.write(move |tx, _| eos_memory::settings::write_in(tx, settings)).await?;
            tracing::info!(learning = settings.learning, reminders = settings.reminders, "memory: switches set");
            Ok(Response::json(200, &settings))
        }
    });
    let at = api.clone();
    let tidy = RouteDef::post("/api/memory/tidy", move |_req: Request| {
        let at = at.clone();
        async move {
            let Some(nightly) = &at.nightly else {
                return Err(ApiError::status_with(409, "memory is not tidied on this computer"));
            };
            let started = nightly.start();
            Ok(Response::json(202, &ExperienceTidy { started }))
        }
    });
    let read = Access::ui_token().phone_user(Tier::Read);
    vec![
        summary.access(Access::open().phone(Tier::Read)),
        recalled.access(read),
        stated.access(read),
        read_settings.access(Access::open().phone(Tier::Read)),
        write_settings.access(Access::ui_token()),
        tidy.access(Access::ui_token()),
    ]
    .into_iter()
    .chain(notes::all(api))
    .chain(everything::all(api))
    .collect()
}
