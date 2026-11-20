//! Needs-you hand-offs (01 G52, 03 §4.5): a run from a trigger of a routine
//! whose confirmed rung is Ask waits in the queue on a `run_start` item, and
//! the user's answers to the routines' items are acted on here.
//!
//! The supervisor opens the `run_start` item in its own pass and marks the
//! run's timeline `start_asked`; the answer "run" marks it `start_allowed`,
//! after which the run leaves the queue as any other. Whether a queued run
//! waits on the user is read from those marks, not stored beside the run.
//!
//! Answered items the routines made and have not acted on are handled at
//! start and on every `inbox:change`, each in a write job of its own that
//! marks it consumed ([`eos_inbox::consume_in`]): at least once, keyed by
//! the item's id. A question whose asker is gone has its answer told to the
//! run's lead; that note goes out before the item is marked, so a crash
//! between the two tells it again rather than never.

use std::sync::Arc;

use eos_contracts::{ConfirmChoice, InboxAnswer, InboxChange, RunInput, RunStartChoice};
use eos_core::Error;
use eos_core::store::{Outbox, StoredItem, StoredRun, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::run::{Reason, RunState};
use eos_inbox::{INBOX_CHANGE, NewItem, Opening, consume_in, open_in};
use serde_json::json;

use super::control::Control;
use super::supervisor::skip_for;
use super::versions::{Added, add_in};
use super::{Engine, note};
use crate::routes::readable;

/// Who makes the items acted on here.
const PRODUCER: &str = "routines";
/// A queued run's timeline: the user was asked whether it may start.
const START_ASKED: &str = "start_asked";
/// A queued run's timeline: the user said it may start.
const START_ALLOWED: &str = "start_allowed";

/// Whether a queued run from a trigger of a routine at Ask may leave the
/// queue: once the user said so. The first time it is looked at, its
/// `run_start` item is opened, in the supervisor's job.
pub(crate) fn may_start_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &StoredRun,
    now: i64,
) -> Result<bool, Error> {
    let events = tx.runs().events(&run.id)?;
    if events.iter().any(|event| event.kind == START_ALLOWED) {
        return Ok(true);
    }
    if events.iter().any(|event| event.kind == START_ASKED) {
        return Ok(false);
    }
    let name = tx.routines().find(&run.routine_id)?.map_or_else(|| "A routine".to_owned(), |routine| routine.name);
    let input: Option<RunInput> = serde_json::from_str(&run.input).ok();
    let item = input.and_then(|input| input.item);
    let title = match item.as_ref().and_then(|item| item.title.as_deref()) {
        Some(title) => format!("{name}: {title}. Run it?"),
        None => format!("{name}: run it?"),
    };
    let mut payload = json!({ "runId": run.id });
    if let Some(item) = &item {
        payload["item"] = json!(item);
    }
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let ask = NewItem {
        kind: ItemKind::RunStart,
        producer: PRODUCER.into(),
        routine_id: Some(run.routine_id.clone()),
        run_id: Some(run.id.clone()),
        subject_key: None,
        title,
        summary: "A trigger started it. It waits for you before it does any work.".into(),
        payload,
        by_hand: false,
    };
    let item = open_in(tx, out, &at, ask)?;
    tx.runs().append_event(&run.id, now, START_ASKED, Some(&json!({ "itemId": item.id }).to_string()))?;
    tracing::info!(run_id = %run.id, item_id = %item.id, "a run waits for the user to start it");
    Ok(false)
}

/// From now on, answers are acted on as `inbox:change` announces them; and
/// once now, for those given while Eos was not listening.
pub(crate) async fn hear(engine: &Arc<Engine>) {
    let weak = Arc::downgrade(engine);
    let subscription = engine.bus.on(INBOX_CHANGE, move |event| {
        let Some(engine) = weak.upgrade() else { return };
        let Ok(change) = event.payload_as::<InboxChange>() else { return };
        if change.state != "answered" {
            return;
        }
        let Some(tasks) = engine.tasks.clone() else { return };
        tasks.spawn(async move { pass(&engine).await });
    });
    *Engine::locked(&engine.handoffs) = Some(subscription);
    pass(engine).await;
}

/// Acts on every answered item of the routines' that waits for it. One
/// item that cannot be acted on is left for the next pass; the others go on.
async fn pass(engine: &Arc<Engine>) {
    // One pass at a time: a note is told before its item is marked.
    let _one = engine.handing.lock().await;
    let items = match engine.store.read(|tx| tx.inbox_items().unconsumed(PRODUCER)).await {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(%error, "the answers to act on could not be read");
            return;
        }
    };
    let mut started = false;
    for item in items {
        let (id, kind) = (item.id.clone(), item.kind);
        match act(engine, item).await {
            Ok(allowed) => started |= allowed,
            Err(error) => {
                tracing::warn!(item_id = %id, kind = kind.as_str(), %error, "an answer could not be acted on")
            }
        }
    }
    if started {
        engine.wake.notify_one();
    }
}

/// Acts on one item; true when a run may now leave the queue.
async fn act(engine: &Arc<Engine>, item: StoredItem) -> Result<bool, Error> {
    match item.kind {
        ItemKind::RunStart => consume(engine, item, run_start_in).await,
        ItemKind::ConfirmChange => {
            let job = engine.clone();
            consume(engine, item, move |tx, out, item, now| confirm_change_in(&job, tx, out, item, now)).await
        }
        ItemKind::Question => {
            tell_lead(engine, &item).await?;
            consume(engine, item, |_, _, _, _| Ok(false)).await
        }
        // A suggestion is only acknowledged until "Keep as a routine?" acts on
        // it (RT-27); an alert's answer was acted on where it was given.
        _ => consume(engine, item, |_, _, _, _| Ok(false)).await,
    }
}

/// Marks `item` consumed and does `act` in the same job; nothing when an
/// earlier pass marked it already.
async fn consume(
    engine: &Engine,
    item: StoredItem,
    act: impl FnOnce(&dyn Tx, &mut Outbox, &StoredItem, i64) -> Result<bool, Error> + Send + 'static,
) -> Result<bool, Error> {
    let now = engine.clock.now_ms();
    engine
        .store
        .write(move |tx, out| if consume_in(tx, &item.id, now)? { act(tx, out, &item, now) } else { Ok(false) })
        .await
}

/// The answer to a run's start: "run" lets it leave the queue, "skip" or a
/// discard skips it, and one the system gave when the item ran out of time
/// skips it as too late.
fn run_start_in(tx: &dyn Tx, out: &mut Outbox, item: &StoredItem, now: i64) -> Result<bool, Error> {
    let Some(run) = item.run_id.as_deref().map(|id| tx.runs().find(id)).transpose()?.flatten() else {
        return Ok(false);
    };
    if run.state != RunState::Queued {
        return Ok(false);
    }
    let answer = item.answer.as_deref().and_then(|text| serde_json::from_str::<InboxAnswer>(text).ok());
    match answer {
        Some(InboxAnswer::RunStart { choice: RunStartChoice::Run }) => {
            tx.runs().append_event(&run.id, now, START_ALLOWED, None)?;
            tracing::info!(run_id = %run.id, item_id = %item.id, "the user let a run start");
            Ok(true)
        }
        _ if item.answered_by.as_deref() == Some("system") => {
            skip_for(tx, out, &run, Reason::TooLate, now).map(|()| false)
        }
        _ => skip_for(tx, out, &run, Reason::User, now).map(|()| false),
    }
}

/// The user confirmed the architect's change: its version is kept as the
/// user's, as a save from the blueprint editor is. A rejection changes
/// nothing.
fn confirm_change_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    item: &StoredItem,
    now: i64,
) -> Result<bool, Error> {
    let answer = item.answer.as_deref().and_then(|text| serde_json::from_str::<InboxAnswer>(text).ok());
    if !matches!(answer, Some(InboxAnswer::ConfirmChange { choice: ConfirmChoice::Confirm })) {
        return Ok(false);
    }
    let payload: serde_json::Value = serde_json::from_str(&item.payload).unwrap_or_default();
    let (Some(routine_id), Some(version_id)) = (item.routine_id.as_deref(), payload["versionId"].as_str()) else {
        return Ok(false);
    };
    let Some(version) = tx.routine_versions().find(routine_id, version_id)? else { return Ok(false) };
    let Some(blueprint) = readable(&version)? else { return Ok(false) };
    let prepared = super::Prepared { blueprint, trust: version.trust };
    let kept = add_in(
        tx,
        out,
        Added {
            routine_id,
            version_id: &engine.ids.routine_version_id(),
            author: eos_contracts::VersionAuthor::User,
            note: None,
            prepared: &prepared,
            device: &engine.device,
            now,
            patterns: &engine.patterns,
        },
    )?;
    tracing::info!(routine_id, version_id, kept, "the user confirmed a change");
    Ok(false)
}

/// Tells a run's lead the answer to a question it no longer waits on, while
/// the run is at work.
async fn tell_lead(engine: &Engine, item: &StoredItem) -> Result<(), Error> {
    let Some(run_id) = item.run_id.clone() else { return Ok(()) };
    let id = run_id.clone();
    let run = engine.store.read(move |tx| tx.runs().find(&id)).await?;
    let Some(lead) = run.filter(|run| !run.state.is_terminal()).and_then(|run| run.lead_id) else { return Ok(()) };
    note(engine, &lead, &run_id, &late_answer(item)).await?;
    tracing::info!(run_id, item_id = %item.id, "a late answer was told to a run's lead");
    Ok(())
}

/// What the lead is told of an answer to the question it stopped waiting on.
fn late_answer(item: &StoredItem) -> String {
    let answer = item.answer.as_deref().and_then(|text| serde_json::from_str::<InboxAnswer>(text).ok());
    let Some(InboxAnswer::Question { answers }) = answer else {
        return "The user turned away the question you asked earlier. Go on without its answer.".to_owned();
    };
    let lines: Vec<String> = answers.iter().map(|(question, answer)| format!("Q: {question}\nA: {answer}")).collect();
    format!("The user answered the question you asked earlier:\n\n{}", lines.join("\n\n"))
}
