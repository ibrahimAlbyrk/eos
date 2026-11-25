//! A routine's architect (01 §4.11): a focused session of the reserved
//! definition `eos-architect`, at the user's default model and high effort,
//! that turns what the user wants into a blueprint with them. It is tracked
//! in the routine's `routine_drafts` row and a `routine_sessions` row of
//! role `architect`, and what it spends is booked as the routine's setup
//! (G32).
//!
//! - `make`: a routine made from a sentence, with a placeholder draft so the
//!   routine is listed from its first moment, and a change asked of one;
//! - `propose`: its blueprint written as a draft version, which opens a
//!   `confirm_change` item when it asks for more freedom or new places;
//! - `draft`: the draft the screen shows, its question, a message to the
//!   architect, leaving it and the start that keeps it;
//! - `tools`: what its tools do ([`ArchitectTools`](eos_core::routine::ArchitectTools)).
//!
//! One architect per routine and at most [`LIVE_MAX`] live at once; one idle
//! for [`IDLE_MS`] is suspended and the next message revives it. Sentences,
//! drafts, questions and choices never reach a log.

mod draft;
mod make;
mod propose;
mod tools;
mod trial_end;

pub(crate) use draft::{Started, abandon, message, question_of, start, view};
use make::restart;
pub(crate) use make::{change, make};
pub(crate) use tools::Architect;
pub(crate) use trial_end::trial_ended;

use eos_contracts::FOCUSED_ROLE;
use eos_contracts::NameSource;
use eos_core::Error;
use eos_core::store::{StoredDraft, StoredRoutineSession, Tx};
use eos_sessions::{MessageInput, SpawnRequest};

use crate::engine::Engine;

/// The definition an architect starts as; its tools and prompt key on it.
pub(crate) const DEFINITION: &str = "eos-architect";
/// The word `routine_sessions.role` stores.
const ROLE: &str = "architect";
/// At most this many architects are live at once (G33).
pub(crate) const LIVE_MAX: usize = 3;
/// An architect idle this long is suspended.
pub(crate) const IDLE_MS: i64 = 30 * 60 * 1000;
/// A change revives an architect younger than this; an older one is
/// replaced by a new one that starts from the head.
const REVIVE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_REASON: &str = "routine_architect";
/// The refusal of one more architect while [`LIVE_MAX`] are live; its
/// route answers it with code `architects_busy`.
pub(crate) const ARCHITECTS_BUSY: &str = "too many architects are at work; finish or leave one first";

/// The routine and draft row of the architect `worker_id`; refused for a
/// worker that is not the architect of its routine now.
pub(crate) fn draft_of(tx: &dyn Tx, worker_id: &str) -> Result<StoredDraft, Error> {
    let session = tx.routine_sessions().find(worker_id)?.filter(|session| session.role == ROLE);
    let not_architect = || Error::Conflict("this session is no routine's architect".into());
    let session = session.ok_or_else(not_architect)?;
    let draft = tx.routines().draft(&session.routine_id)?;
    draft.filter(|draft| draft.architect_id.as_deref() == Some(worker_id)).ok_or_else(not_architect)
}

/// Room for one more live architect, or a refusal that says why.
fn room(engine: &Engine, worker_id: Option<&str>) -> Result<(), Error> {
    let live = Engine::locked(&engine.architects);
    if worker_id.is_some_and(|id| live.contains_key(id)) || live.len() < LIVE_MAX {
        return Ok(());
    }
    Err(Error::Conflict(ARCHITECTS_BUSY.into()))
}

/// The architect was active: its idle time starts again.
pub(crate) fn touch(engine: &Engine, worker_id: &str) {
    let now = engine.clock.now_ms();
    if let Some(at) = Engine::locked(&engine.architects).get_mut(worker_id) {
        *at = now;
    }
}

/// Writes the architect's `routine_sessions` row, then starts its session
/// in a scratch folder of its own with `prompt` as its first message.
async fn spawn(engine: &Engine, routine_id: &str, name: &str, prompt: String) -> Result<String, Error> {
    room(engine, None)?;
    let worker_id = engine.ids.worker_id();
    let row = StoredRoutineSession {
        worker_id: worker_id.clone(),
        routine_id: routine_id.to_owned(),
        run_id: None,
        role: ROLE.into(),
        agent_key: None,
        created_at: engine.clock.now_ms(),
    };
    engine.store.write(move |tx, _| tx.routine_sessions().insert(&row)).await?;
    let folder = engine.scratch.create(&worker_id).await?;
    let request = SpawnRequest {
        prompt,
        cwd: Some(folder.clone()),
        name: Some(format!("{name} · Architect")),
        name_source: Some(NameSource::Auto),
        // The user's default model.
        model: None,
        effort: Some("high".into()),
        role: Some(FOCUSED_ROLE.to_owned()),
        worker_definition: Some(DEFINITION.to_owned()),
        scratch: true,
        fixed_id: Some(worker_id.clone()),
        skip_recents: true,
        ..SpawnRequest::default()
    };
    if let Err(error) = engine.sessions.spawn(request).await {
        engine.scratch.remove(&folder).await;
        return Err(error);
    }
    Engine::locked(&engine.architects).insert(worker_id.clone(), engine.clock.now_ms());
    tracing::info!(routine_id, worker_id, "a routine's architect started");
    Ok(worker_id)
}

/// The user's words to the architect, after its turn when it is busy; a
/// suspended architect is revived for them, when there is room.
async fn say(engine: &Engine, worker_id: &str, text: &str) -> Result<(), Error> {
    room(engine, Some(worker_id))?;
    if !engine.sessions.is_live(worker_id) {
        engine.sessions.revive(worker_id).await?;
    }
    Engine::locked(&engine.architects).insert(worker_id.to_owned(), engine.clock.now_ms());
    let message = MessageInput {
        worker_id: worker_id.to_owned(),
        text: text.to_owned(),
        queue_when_busy: true,
        origin: Some("routine_architect".into()),
        ..MessageInput::default()
    };
    engine.sessions.dispatch(message).await.map(drop)
}

/// Interrupts and suspends the architect; one that is gone is left as it is.
pub(crate) async fn suspend(engine: &Engine, worker_id: &str) {
    Engine::locked(&engine.architects).remove(worker_id);
    let _ = engine.sessions.interrupt(worker_id).await;
    if let Err(error) = engine.sessions.suspend(worker_id, SUSPEND_REASON).await {
        tracing::debug!(worker_id, %error, "an architect was not suspended");
    }
}

/// Counts again, from now, every routine's architect whose session is live
/// after Eos started, so it takes its room and is suspended once idle.
pub(crate) async fn rejoin(engine: &Engine) -> Result<(), Error> {
    let drafts = engine
        .store
        .read(|tx| {
            let mut architects = Vec::new();
            for routine in tx.routines().list()? {
                architects.extend(tx.routines().draft(&routine.id)?.and_then(|draft| draft.architect_id));
            }
            Ok(architects)
        })
        .await?;
    let now = engine.clock.now_ms();
    for worker_id in drafts.into_iter().filter(|worker_id| engine.sessions.is_live(worker_id)) {
        Engine::locked(&engine.architects).insert(worker_id, now);
    }
    Ok(())
}

/// The routines whose draft's architect is live, as `(id, name)`: the
/// drafts a user may leave to make room for one more.
pub(crate) async fn crowding(engine: &Engine) -> Result<Vec<(String, String)>, Error> {
    let live: Vec<String> = Engine::locked(&engine.architects).keys().cloned().collect();
    engine
        .store
        .read(move |tx| {
            let mut drafts = Vec::new();
            for routine in tx.routines().list()? {
                let architect = tx.routines().draft(&routine.id)?.and_then(|draft| draft.architect_id);
                if architect.is_some_and(|worker_id| live.contains(&worker_id)) {
                    drafts.push((routine.id, routine.name));
                }
            }
            Ok(drafts)
        })
        .await
}

/// Suspends every architect idle for [`IDLE_MS`].
pub(crate) async fn sweep(engine: &Engine) {
    let now = engine.clock.now_ms();
    let idle: Vec<String> = Engine::locked(&engine.architects)
        .iter()
        .filter(|(_, at)| now - **at >= IDLE_MS)
        .map(|(id, _)| id.clone())
        .collect();
    for worker_id in idle {
        suspend(engine, &worker_id).await;
        tracing::info!(worker_id, "an idle architect was suspended");
    }
}

/// Whether a change may go to the architect that made `worker_id`'s row.
fn young(session: &StoredRoutineSession, now: i64) -> bool {
    now - session.created_at < REVIVE_MS
}
