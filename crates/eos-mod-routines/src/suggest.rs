//! Suggestions from repeated work (01 §4.11, G42): once a night, after
//! Dreaming's usual slot, the model reads the first requests of the user's
//! top-level chats of the last 14 days and may name one task the user asks
//! for again and again, as the sentence that would make its routine. It
//! opens one `suggestion` item; "make it" starts the architect with that
//! sentence.
//!
//! Limits: at most one suggestion a week; a task suggested before is never
//! suggested again (a dismissed one is named to the model as such); only
//! the user's own first requests are read, never a chat an agent, a
//! routine or a run started, so no outside text; and the model is asked
//! only when three or more such requests exist. One read a local day at
//! most, booked as `suggest` spend. No request text is logged.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{InboxAnswer, RoutineState, SuggestionChoice};
use eos_core::Error;
use eos_core::agent::{OneShotError, OneShotRequest};
use eos_core::store::{StoredItem, StoredSuggestion, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::slug;
use eos_domain::time::nightly_slot;
use eos_inbox::{NewItem, Opening, open_in};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::engine::{self, Engine};
use crate::intent::{book, cost_of};
use crate::once::{DISMISSED, OPEN, TAKEN};
use crate::routes::{BUILTIN, today};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// An hour after Dreaming's default slot, on the user's clock.
const SLOT: &str = "04:00";
const READ_DAYS: i64 = 14;
const REQUESTS_AT_LEAST: usize = 3;
const REQUESTS_MAX: usize = 200;
const REQUEST_CHARS: usize = 300;
const WEEK_MS: i64 = 7 * DAY_MS;
const SPEND_KIND: &str = "suggest";
const MODEL: &str = "sonnet";
const TIMEOUT_MS: u64 = 30_000;
const KEY_MAX_CHARS: usize = 60;
const SENTENCE_MAX_CHARS: usize = 400;
const PRODUCER: &str = "routines";
/// The prefix of the keys of suggestions from chats.
const CHAT: &str = "chat:";

/// The slot last looked at, and the read at work.
#[derive(Debug, Default)]
pub(crate) struct Schedule {
    slot: i64,
    task: Option<JoinHandle<()>>,
}

/// Starts the night's read once its slot has passed, at most once a slot;
/// never off the network, where it would spend the user's plan unasked.
pub(crate) fn due(engine: &Arc<Engine>) {
    if !engine.background_model_calls {
        return;
    }
    let now = engine.clock.now_ms();
    let slot = nightly_slot(now, SLOT, &|at| engine.zone.offset_minutes_at(at));
    let mut schedule = Engine::locked(&engine.suggest);
    if schedule.slot >= slot || schedule.task.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    schedule.slot = slot;
    schedule.task = Some(tokio::spawn(read(engine.clone())));
}

/// Ends the read at work, if any.
pub(crate) async fn stop(engine: &Engine) {
    let task = Engine::locked(&engine.suggest).task.take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

async fn read(engine: Arc<Engine>) {
    if let Err(error) = suggest(&engine).await {
        tracing::warn!(%error, "the night's suggestion read failed");
    }
}

/// What the model is given, when it may be asked tonight.
struct Asking {
    requests: Vec<String>,
    routines: Vec<String>,
    /// Every task suggested before, by key; and the ones said no to.
    suggested: Vec<String>,
    dismissed: Vec<String>,
}

async fn suggest(engine: &Arc<Engine>) -> Result<(), Error> {
    let (now, day) = (engine.clock.now_ms(), today(engine));
    let Some(asking) = engine.store.read(move |tx| asking(tx, now, &day)).await? else { return Ok(()) };
    let lines = |list: &[String]| if list.is_empty() { "None.".to_owned() } else { list.join("\n") };
    let values = [
        ("REQUESTS", lines(&asking.requests)),
        ("ROUTINES", lines(&asking.routines)),
        ("DISMISSED", lines(&asking.dismissed)),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), Value::String(value)))
    .collect();
    let none = eos_prompts::service::no_values();
    let prompt = engine.prompts.render("routine/suggest", &values, &none)?;
    let request = OneShotRequest::new(prompt).model(Some(MODEL)).schema(schema()).timeout_ms(TIMEOUT_MS as i64);
    let timeout = Duration::from_millis(TIMEOUT_MS);
    let replied = match tokio::time::timeout(timeout, engine.one_shot.complete(request)).await {
        Ok(replied) => replied,
        Err(_) => Err(OneShotError::TimedOut(timeout)),
    };
    let cost = replied.as_ref().map_or(0.0, |replied| cost_of(engine, replied, MODEL));
    book(engine, "", SPEND_KIND, cost).await?;
    let replied = replied.map_err(|error| Error::Unreachable(error.to_string()))?;
    let Some((sentence, task_key)) = replied.structured.as_ref().and_then(chosen) else {
        tracing::info!(requests = asking.requests.len(), "the night's read suggested nothing");
        return Ok(());
    };
    if asking.suggested.contains(&task_key) {
        tracing::info!("the night's read named a task suggested before: nothing opened");
        return Ok(());
    }
    open(engine, sentence, task_key).await
}

/// What the model is asked over, or `None` when it is not asked tonight:
/// read today already, a suggestion within the week, or fewer than three
/// first requests.
fn asking(tx: &dyn Tx, now: i64, day: &str) -> Result<Option<Asking>, Error> {
    if tx.routine_spend().of_day(day)?.iter().any(|row| row.kind == SPEND_KIND) {
        return Ok(None);
    }
    let made: Vec<StoredSuggestion> = tx.routine_suggestions().list()?;
    let chats: Vec<&StoredSuggestion> = made.iter().filter(|s| s.key.starts_with(CHAT)).collect();
    if chats.iter().any(|s| s.created_at > now - WEEK_MS) {
        return Ok(None);
    }
    let since = now - READ_DAYS * DAY_MS;
    let mut workers = tx.workers().list_listed()?;
    workers.extend(tx.workers().list_archived_listed()?);
    let requests: Vec<String> = workers
        .iter()
        .filter(|worker| worker.parent_id.is_none() && worker.started_at >= since)
        .map(|worker| worker.prompt.trim())
        .filter(|prompt| !prompt.is_empty())
        .map(|prompt| format!("- {}", prompt.chars().take(REQUEST_CHARS).collect::<String>().replace('\n', " ")))
        .take(REQUESTS_MAX)
        .collect();
    if requests.len() < REQUESTS_AT_LEAST {
        return Ok(None);
    }
    let mut routines = Vec::new();
    for routine in tx.routines().list()? {
        let hidden = matches!(routine.state, RoutineState::Deleted | RoutineState::Transient);
        if !hidden && routine.origin != BUILTIN {
            routines.push(format!("- {}", routine.name));
        }
    }
    let key = |s: &&StoredSuggestion| s.key.trim_start_matches(CHAT).to_owned();
    let dismissed = chats.iter().filter(|s| s.state == DISMISSED).map(|s| format!("- {}", key(s))).collect();
    Ok(Some(Asking { requests, routines, suggested: chats.iter().map(key).collect(), dismissed }))
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sentence": { "type": "string", "description": "What the user would type to make the routine; empty for none." },
            "taskKey": { "type": "string", "description": "A short lowercase key for the task." },
        },
        "required": ["sentence", "taskKey"],
    })
}

/// The sentence and task key the model chose, when it chose one.
fn chosen(data: &Value) -> Option<(String, String)> {
    let sentence = data["sentence"].as_str().map(str::trim).filter(|text| !text.is_empty())?;
    let task_key: String = slug::of_name(data["taskKey"].as_str()?).chars().take(KEY_MAX_CHARS).collect();
    if task_key.is_empty() {
        return None;
    }
    Some((sentence.chars().take(SENTENCE_MAX_CHARS).collect(), task_key))
}

async fn open(engine: &Arc<Engine>, sentence: String, task_key: String) -> Result<(), Error> {
    let now = engine.clock.now_ms();
    let control = engine::Control(engine.clone());
    let (ids, zone) = (engine.ids.clone(), engine.zone.clone());
    engine
        .store
        .write(move |tx, out| {
            let key = format!("{CHAT}{task_key}");
            if tx.routine_suggestions().find(&key)?.is_some() {
                return Ok(());
            }
            let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: &control };
            let item = open_in(
                tx,
                out,
                &at,
                NewItem {
                    kind: ItemKind::Suggestion,
                    producer: PRODUCER.into(),
                    routine_id: None,
                    run_id: None,
                    subject_key: Some(key.clone()),
                    title: "You often ask for this. Make it a routine?".into(),
                    summary: sentence.clone(),
                    payload: json!({ "sentence": sentence, "taskKey": task_key }),
                    by_hand: false,
                },
            )?;
            let suggestion =
                StoredSuggestion { key, state: OPEN.into(), inbox_id: Some(item.id.clone()), created_at: now };
            tx.routine_suggestions().insert(&suggestion)?;
            tracing::info!(item_id = %item.id, "a routine was suggested from repeated work");
            Ok(())
        })
        .await
}

/// The answer to a suggestion from chats, inside the job that marks it
/// consumed: either answer settles it; "make it" answers the sentence the
/// architect starts from once the job is done.
pub(crate) fn answer_in(tx: &dyn Tx, item: &StoredItem) -> Result<Option<String>, Error> {
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or_default();
    let (Some(sentence), Some(task_key)) = (payload["sentence"].as_str(), payload["taskKey"].as_str()) else {
        return Ok(None);
    };
    let answer = item.answer.as_deref().and_then(|text| serde_json::from_str::<InboxAnswer>(text).ok());
    let take = matches!(answer, Some(InboxAnswer::Suggestion { choice: SuggestionChoice::MakeIt }));
    tx.routine_suggestions().set_state(&format!("{CHAT}{task_key}"), if take { TAKEN } else { DISMISSED })?;
    Ok(take.then(|| sentence.to_owned()))
}
