//! Doing a task once (01 §4.12, G41). The middle model writes a light
//! blueprint for the sentence (one agent, rule checks only, an answer shown
//! in Eos, Freedom Ask) with a key for the kind of task; the routine is a
//! one-off (`transient`) and its run starts at once. The user may keep it as
//! a routine (`POST /api/routines/:id/keep`); a one-off nobody kept leaves
//! with retention 7 days after its run. The third one-off of the same kind
//! of task in 30 days opens one "Keep as a routine?" suggestion, never
//! again for that kind. The text is never logged; the model's answer is
//! booked as `once` spend.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{
    InboxAnswer, OnceRequest, OnceStarted, RoutineChangeReason, RoutineKind, RoutineState, RunInput, StartedRun,
    SuggestionChoice, VersionAuthor, VersionStatus,
};
use eos_core::Error;
use eos_core::agent::{OneShotError, OneShotRequest};
use eos_core::routine::{NewRun, RunCreated, RunOrigin, StartError};
use eos_core::store::{Outbox, StoredItem, StoredRoutine, StoredSuggestion, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::{limits::fill_defaults, slug};
use eos_inbox::{NewItem, Opening, open_in};
use serde_json::{Value, json};

use crate::engine::{self, Engine, NewVersion, Prepared, announce_routine, blocks, check_in, keep_in};
use crate::intent::{book, cost_of};

/// A one-off routine's origin, its version's author and its spend kind.
const ONCE: &str = "once";
const MIDDLE_MODEL: &str = "sonnet";
const PLAN_TIMEOUT_MS: u64 = 8_000;
const RUN_MINUTES: i64 = 10;
/// One-offs of one kind of task that bring the suggestion to keep one.
const REPEATS: usize = 3;
/// Within this long; the notes of older one-offs leave with retention.
pub(crate) const REPEAT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const KEY_MAX_CHARS: usize = 60;
const PRODUCER: &str = "routines";
pub(crate) const OPEN: &str = "open";
pub(crate) const TAKEN: &str = "taken";
pub(crate) const DISMISSED: &str = "dismissed";

/// Why a one-off did not start.
pub(crate) enum OnceRefused {
    /// The model wrote no blueprint, or one the rules refuse.
    Unplanned(Error),
    Start(StartError),
}

impl From<Error> for OnceRefused {
    fn from(error: Error) -> Self {
        Self::Unplanned(error)
    }
}

/// What the model wrote for the sentence.
struct Planned {
    name: String,
    summary: String,
    brief: String,
    makes: String,
    task_key: String,
}

/// `POST /api/runs/once`. Nothing is planned, so nothing spent, while this
/// Mac takes no start; a start refused after the plan leaves no routine.
pub(crate) async fn start(engine: &Arc<Engine>, asked: OnceRequest) -> Result<OnceStarted, OnceRefused> {
    engine::taking_starts(engine, RunOrigin::Hand).await.map_err(OnceRefused::Start)?;
    let planned = plan(engine, &asked).await?;
    let prepared = match engine::prepare(engine, blueprint(&planned)).await? {
        Ok(prepared) => prepared,
        Err(issues) => return Err(Error::Validation(format!("the one-off's blueprint was refused: {issues:?}")).into()),
    };
    let input = RunInput {
        item: None,
        items: None,
        trigger: None,
        options: Default::default(),
        note: Some(note(&asked)),
        result: asked.result,
        at: None,
        surface: None,
    };
    let new = NewRun {
        routine_id: engine.ids.routine_id(),
        version: None,
        input,
        items: Vec::new(),
        origin: RunOrigin::Hand,
        door: Some(asked.door),
        confirm_repeat: false,
        client_request_id: None,
    };
    engine::ready_to_start(engine, &prepared.blueprint, &new).await.map_err(OnceRefused::Start)?;
    let routine_id = new.routine_id.clone();
    let run = make(engine, prepared, &planned.task_key, new).await?.map_err(OnceRefused::Start)?;
    engine.wake.notify_one();
    tracing::info!(routine_id = %routine_id, run_id = %run.id, "a one-off started");
    let run = StartedRun { id: run.id, state: run.state.as_str().to_owned(), not_before: run.not_before };
    Ok(OnceStarted { routine_id, name: planned.name, run })
}

/// The request as the run's lead reads it, with the files that came with it.
fn note(asked: &OnceRequest) -> String {
    let mut note = asked.text.clone();
    for attachment in &asked.attachments {
        note.push_str(&format!("\n[{}] {}", attachment.kind, attachment.value));
    }
    note
}

/// Asks the middle model for the light blueprint and books what it cost.
async fn plan(engine: &Engine, asked: &OnceRequest) -> Result<Planned, Error> {
    let attachments: Vec<String> =
        asked.attachments.iter().map(|attachment| format!("[{}] {}", attachment.kind, attachment.value)).collect();
    let values = [("TEXT", asked.text.clone()), ("ATTACHMENTS", attachments.join("\n"))]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), Value::String(value)))
        .collect();
    let none = eos_prompts::service::no_values();
    let prompt = engine.prompts.render("routine/once-blueprint", &values, &none)?;
    let system = engine.prompts.render("routine/once-blueprint-system", &none, &none)?;
    let request = OneShotRequest::new(prompt)
        .model(Some(MIDDLE_MODEL))
        .system(system)
        .schema(schema())
        .timeout_ms(PLAN_TIMEOUT_MS as i64);
    let timeout = Duration::from_millis(PLAN_TIMEOUT_MS);
    let replied = match tokio::time::timeout(timeout, engine.one_shot.complete(request)).await {
        Ok(replied) => replied,
        Err(_) => Err(OneShotError::TimedOut(timeout)),
    };
    let replied = replied.map_err(|error| {
        tracing::warn!(%error, "the one-off's blueprint was not written");
        Error::Unreachable("the one-off could not be planned; try again".into())
    })?;
    book(engine, "", ONCE, cost_of(engine, &replied, MIDDLE_MODEL)).await?;
    replied
        .structured
        .as_ref()
        .and_then(planned)
        .ok_or_else(|| Error::Unreachable("the one-off could not be planned; try again".into()))
}

fn schema() -> Value {
    let text = json!({ "type": "string" });
    json!({
        "type": "object",
        "properties": { "name": text, "summary": text, "brief": text, "makes": text, "taskKey": text },
        "required": ["name", "summary", "brief", "makes", "taskKey"],
    })
}

/// The model's answer, when every field holds text.
fn planned(data: &Value) -> Option<Planned> {
    let field = |name: &str| data[name].as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    let task_key: String = slug::of_name(&field("taskKey")?).chars().take(KEY_MAX_CHARS).collect();
    if task_key.is_empty() {
        return None;
    }
    Some(Planned {
        name: field("name")?,
        summary: field("summary")?,
        brief: field("brief")?,
        makes: field("makes")?,
        task_key,
    })
}

/// One agent in a folder of its own, its answer shown in Eos and held.
fn blueprint(planned: &Planned) -> Value {
    let agent = json!({
        "key": "doer", "name": planned.name, "lead": true, "brief": planned.brief, "model": MIDDLE_MODEL,
        "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none",
    });
    let mut value = json!({
        "format": 1,
        "name": planned.name,
        "summary": planned.summary,
        "icon": "sparkle",
        "kind": "once",
        "takes": {"kind": "none", "label": "", "placeholder": "", "empty": "none", "many": false},
        "when": {"on": []},
        "which": {},
        "who": {"depth": "solo", "agents": [agent], "checker": {"model": MIDDLE_MODEL, "effort": "high"}},
        "how": {"format": "", "checkAgent": false},
        "makes": {"kind": "answer", "description": planned.makes},
        "freedom": {"rung": "ask"},
        "limits": {"perRunMinutes": RUN_MINUTES},
    });
    fill_defaults(&mut value);
    value
}

/// The one-off routine, its one version as its head, and its run, in one
/// job; and, at its kind of task's third time, the suggestion to keep it. A
/// refused start rolls the routine back, so nothing of it is kept.
async fn make(
    engine: &Arc<Engine>,
    prepared: Prepared,
    task_key: &str,
    new: NewRun,
) -> Result<Result<RunCreated, StartError>, Error> {
    let (id, version_id, now) = (new.routine_id.clone(), engine.ids.routine_version_id(), engine.clock.now_ms());
    let (zones, data_dir, device) = (engine.zones.clone(), engine.data_dir.clone(), engine.device.clone());
    let (job, task_key) = (engine.clone(), task_key.to_owned());
    engine
        .store
        .write(move |tx, out| {
            let blueprint = &prepared.blueprint;
            let issues = check_in(tx, &id, blueprint, zones.as_ref(), &data_dir)?;
            if blocks(&issues) {
                return Err(Error::Validation(format!("the one-off's blueprint was refused: {issues:?}")));
            }
            tx.routines().insert(&StoredRoutine {
                id: id.clone(),
                slug: engine::free_slug(tx, &blueprint.name, now)?,
                name: blueprint.name.clone(),
                kind: RoutineKind::Once,
                state: RoutineState::Transient,
                paused_reason: None,
                head_version_id: None,
                origin: ONCE.into(),
                task_key: Some(task_key.clone()),
                agents_may_start: false,
                failure_streak: 0,
                created_at: now,
                updated_at: now,
                changed_at: now,
                started_at: None,
                deleted_at: None,
            })?;
            let version = NewVersion {
                id: &version_id,
                routine_id: &id,
                parent_id: None,
                status: VersionStatus::Kept,
                author: VersionAuthor::Once,
                note: None,
                prepared: &prepared,
                device: &device,
                now,
            };
            engine::insert_version(tx, version)?;
            tx.routines().set_head(&id, &version_id, now)?;
            let run = match engine::queue_runs_in(&job, tx, out, &new, now) {
                Ok(made) => made.into_iter().next().ok_or_else(|| Error::storage("the one-off's run was not made"))?,
                Err(StartError::Store(error)) => return Err(error),
                // Its checks wrote nothing, nor was the routine announced.
                Err(refused) => {
                    tx.routine_retention().delete_routine(&id)?;
                    return Ok(Err(refused));
                }
            };
            announce_routine(tx, out, &id, RoutineChangeReason::Created, now, &job.patterns)?;
            suggest_keeping_in(&job, tx, out, &id, &task_key, now)?;
            Ok(Ok(run))
        })
        .await
}

/// The suggestion's key for one kind of one-off.
fn key_of(task_key: &str) -> String {
    format!("once:{task_key}")
}

/// Notes the one-off `routine_id`, then opens "Keep as a routine?" for it
/// when it is the third one-off of its kind in 30 days, the kind was never
/// suggested, and no routine of that kind was kept.
fn suggest_keeping_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    task_key: &str,
    now: i64,
) -> Result<(), Error> {
    // Counted from notes, not the one-offs: one nobody kept leaves 7 days
    // after its run, inside the 30 days.
    tx.routine_suggestions().note_once(routine_id, task_key, now)?;
    let key = key_of(task_key);
    if tx.routine_suggestions().find(&key)?.is_some() {
        return Ok(());
    }
    let kept = tx.routines().list()?.into_iter().any(|routine| {
        routine.origin == ONCE
            && routine.task_key.as_deref() == Some(task_key)
            && !matches!(routine.state, RoutineState::Transient | RoutineState::Deleted)
    });
    if kept || tx.routine_suggestions().onces_since(task_key, now - REPEAT_WINDOW_MS)? < REPEATS {
        return Ok(());
    }
    let name = tx.routines().find(routine_id)?.map(|routine| routine.name).unwrap_or_default();
    let control = engine::Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let item = open_in(
        tx,
        out,
        &at,
        NewItem {
            kind: ItemKind::Suggestion,
            producer: PRODUCER.into(),
            routine_id: Some(routine_id.to_owned()),
            run_id: None,
            subject_key: Some(key.clone()),
            title: format!("You asked for \u{201c}{name}\u{201d} {REPEATS} times. Keep it as a routine?"),
            summary: "Kept, it runs from Home whenever you ask, the same way each time.".into(),
            payload: json!({ "keep": routine_id, "taskKey": task_key }),
            by_hand: false,
        },
    )?;
    let suggestion = StoredSuggestion { key, state: OPEN.into(), inbox_id: Some(item.id.clone()), created_at: now };
    tx.routine_suggestions().insert(&suggestion)?;
    tracing::info!(routine_id, item_id = %item.id, "a repeated one-off was suggested as a routine");
    Ok(())
}

/// The answer to "Keep as a routine?": "make it" keeps the one-off it
/// names, if it is still one; either answer settles the suggestion.
pub(crate) fn keep_answer_in(
    engine: &Engine,
    tx: &dyn Tx,
    out: &mut Outbox,
    item: &StoredItem,
    now: i64,
) -> Result<(), Error> {
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or_default();
    let (Some(routine_id), Some(task_key)) = (payload["keep"].as_str(), payload["taskKey"].as_str()) else {
        return Ok(());
    };
    let answer = item.answer.as_deref().and_then(|text| serde_json::from_str::<InboxAnswer>(text).ok());
    let take = matches!(answer, Some(InboxAnswer::Suggestion { choice: SuggestionChoice::MakeIt }));
    tx.routine_suggestions().set_state(&key_of(task_key), if take { TAKEN } else { DISMISSED })?;
    let still_once = tx.routines().find(routine_id)?.is_some_and(|routine| routine.state == RoutineState::Transient);
    if take && still_once {
        keep_in(tx, out, routine_id, now, &engine.patterns)?;
    }
    Ok(())
}
