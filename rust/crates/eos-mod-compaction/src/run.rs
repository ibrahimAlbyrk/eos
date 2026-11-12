//! One compaction: an idle agent's conversation is replaced with a summary
//! of it (`core/src/use-cases/CompactContext.ts`).
//!
//! 1. [`begin`]: WORKING (reason `compaction`), so messages queue behind it,
//!    and a `compaction_started` row for the dashboard's animation.
//! 2. [`finish`]: the live conversation is read, rendered within the
//!    summarizer's budget and summarized by a tool-less request on the
//!    agent's own model.
//! 3. Only once a summary exists the session's conversation is replaced with
//!    it (the seed runs no turn; the model reads it with the next message),
//!    the occupancy is set to the seed's size and `compaction_completed` is
//!    recorded.
//! 4. IDLE.
//!
//! A failure before step 3 leaves the conversation as it was and records
//! `compaction_failed`; the worker still returns to IDLE.

use std::sync::Arc;

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{CompactionTrigger, WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::agent::{AgentSession, OneShotError, OneShotRequest};
use eos_core::store::{Outbox, Tx};
use eos_domain::context::context_pct;
use eos_domain::worker::state_name;
use eos_prompts::templates::compaction as prompts;
use eos_sessions::{Transition, transition_state};
use serde_json::{Map, Value, json};

use crate::Parts;
use crate::rules::{estimate_tokens, extract_summary, render_transcript, transcript_char_budget};

/// What to compact, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub worker_id: String,
    pub trigger: CompactionTrigger,
    /// What the user typed after `/compact`: what the summary should keep.
    pub instructions: Option<String>,
}

/// A compaction that holds its worker in WORKING.
pub(crate) struct Begun {
    input: Input,
    session: Arc<dyn AgentSession>,
    model: Option<String>,
    before_tokens: i64,
    limit: i64,
    pct: Option<i64>,
    started: i64,
}

fn record(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    id: &str,
    kind: WorkerEventType,
    payload: &Value,
) -> Result<(), Error> {
    let row_id = tx.events().append_json(id, now, kind, payload)?;
    out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id}));
    Ok(())
}

fn with_instructions(mut payload: Map<String, Value>, instructions: Option<&str>) -> Value {
    if let Some(instructions) = instructions {
        payload.insert("instructions".into(), instructions.into());
    }
    Value::Object(payload)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Takes the worker: IDLE → WORKING and the `compaction_started` row, in one
/// write. `Err` says why nothing was started; nothing was recorded then.
pub(crate) async fn begin(parts: &Parts, session: Arc<dyn AgentSession>, input: Input) -> Result<Begun, String> {
    let instructions = input.instructions.as_deref().map(str::trim).filter(|i| !i.is_empty()).map(str::to_owned);
    let input = Input { instructions, ..input };
    let (id, now) = (input.worker_id.clone(), parts.clock.now_ms());
    let models = parts.models.clone();
    let (trigger, note) = (input.trigger, input.instructions.clone());
    let begun = parts
        .store
        .write(move |tx, out| {
            let Some(worker) = tx.workers().find(&id)? else { return Ok(Err("worker not found".to_owned())) };
            // Only an idle worker is taken: a message that got in first keeps it.
            if worker.state != WorkerState::Idle
                || transition_state(tx, out, now, &id, WorkerState::Working, "compaction")? != Transition::Applied
            {
                return Ok(Err(format!("cannot compact from state {}", state_name(worker.state))));
            }
            let before_tokens = worker.last_context_tokens.unwrap_or(0);
            let limit = models.context_window_for(worker.model.as_deref());
            let pct = context_pct(before_tokens, Some(limit));
            let started = object(json!({"trigger": trigger, "beforeTokens": before_tokens, "pct": pct}));
            let payload = with_instructions(started, note.as_deref());
            record(tx, out, now, &id, WorkerEventType::CompactionStarted, &payload)?;
            Ok(Ok((worker.model, before_tokens, limit, pct)))
        })
        .await;
    match begun {
        Ok(Ok((model, before_tokens, limit, pct))) => {
            Ok(Begun { input, session, model, before_tokens, limit, pct, started: now })
        }
        Ok(Err(why)) => Err(why),
        Err(e) => Err(e.to_string()),
    }
}

fn summarizer_error(error: OneShotError) -> String {
    match error {
        OneShotError::NoCredential => "no Claude credential for the summarizer".to_owned(),
        OneShotError::TimedOut(after) => format!("summarizer timed out after {}s", after.as_secs_f64().round()),
        OneShotError::Failed(why) => why,
    }
}

/// Steps 2 and 3. `Err` is why the conversation was left as it was.
async fn summarize_and_replace(parts: &Parts, run: &Begun) -> Result<(), String> {
    let id = run.input.worker_id.as_str();
    let fail = |e: Error| e.to_string();
    let transcript = run.session.read_transcript().await.map_err(|e| e.to_string())?;
    let Some(transcript) = transcript.filter(|t| !t.entries.is_empty()) else {
        return Err("nothing to compact yet".to_owned());
    };
    let rendered = render_transcript(&transcript.entries, transcript_char_budget(Some(run.limit)));
    let instructions = run.input.instructions.as_deref();
    let request = OneShotRequest::new(prompts::summarize(&parts.prompts, &rendered.text, instructions).map_err(fail)?)
        .system(prompts::summarizer_system(&parts.prompts).map_err(fail)?)
        .model(run.model.as_deref())
        .timeout_ms(parts.config.current().compaction.timeout_ms);
    let raw = parts.summarizer.complete(request).await.map_err(summarizer_error)?;
    let summary = extract_summary(&raw.text);
    if summary.is_empty() {
        return Err("the summarizer returned an empty summary".to_owned());
    }

    // The agent may have been stopped while the summarizer ran: never revive it.
    let worker = id.to_owned();
    let now = parts.store.read(move |tx| tx.workers().find(&worker)).await.map_err(fail)?;
    if now.is_none_or(|w| w.state != WorkerState::Working) || !run.session.is_alive() {
        return Err("agent stopped during compaction".to_owned());
    }

    let seed = prompts::continuation(&parts.prompts, &summary, transcript.path.as_deref()).map_err(fail)?;
    let after_tokens = estimate_tokens(&seed);
    run.session.replace_context(seed).await.map_err(|e| e.to_string())?;

    let (worker, now) = (id.to_owned(), parts.clock.now_ms());
    let completed = object(json!({
        "trigger": run.input.trigger,
        "beforeTokens": run.before_tokens,
        "afterTokens": after_tokens,
        "pct": run.pct,
        "turns": rendered.turns,
        "summary": summary,
        "durationMs": now - run.started,
    }));
    let payload = with_instructions(completed, instructions);
    parts
        .store
        .write(move |tx, out| {
            tx.workers().set_context_tokens(&worker, after_tokens)?;
            // The occupancy just dropped: the "context is filling up" notes may fire again.
            tx.context_marks().clear(&worker)?;
            record(tx, out, now, &worker, WorkerEventType::CompactionCompleted, &payload)
        })
        .await
        .map_err(fail)?;
    tracing::info!(
        worker_id = id,
        before_tokens = run.before_tokens,
        after_tokens,
        turns = rendered.turns,
        omitted = rendered.omitted,
        "context compacted"
    );
    Ok(())
}

/// Runs a begun compaction to its end and gives the worker back. `done`
/// hears whether the conversation was replaced, just before the worker goes
/// IDLE: what was queued meanwhile is delivered on that edge.
pub(crate) async fn finish(parts: &Parts, run: Begun, done: impl FnOnce(bool)) {
    let outcome = summarize_and_replace(parts, &run).await;
    if let Err(error) = &outcome {
        tracing::warn!(worker_id = %run.input.worker_id, %error, "context compaction failed");
    }
    let failed = outcome.as_ref().err().map(|error| json!({"trigger": run.input.trigger, "error": error}));
    let (id, now) = (run.input.worker_id.clone(), parts.clock.now_ms());
    done(outcome.is_ok());
    let settled = parts
        .store
        .write(move |tx, out| {
            if let Some(payload) = failed {
                record(tx, out, now, &id, WorkerEventType::CompactionFailed, &payload)?;
            }
            // Only what this run lifted is settled: a stop or a removal owns the state now.
            let working = tx.workers().find(&id)?.is_some_and(|w| w.state == WorkerState::Working);
            Ok(working && transition_state(tx, out, now, &id, WorkerState::Idle, "compaction")? == Transition::Applied)
        })
        .await;
    match settled {
        Ok(true) => parts.sessions.settled(&run.input.worker_id).await,
        Ok(false) => {}
        Err(e) => {
            tracing::error!(worker_id = %run.input.worker_id, error = %e, "a compacted worker could not be settled")
        }
    }
}
