//! One agent event, recorded and applied to its worker.
//!
//! A step of a write job: the event's row, the worker's counters and state
//! and what they announce are saved together.

use std::cell::Cell;

use eos_contracts::stream::topics::{USAGE_RECORDED, WORKER_CHANGE};
use eos_contracts::{
    ActivityEventKind, AgentEvent, AgentMessageEventRole, ContentBlock, SessionEventPhase, TurnEventPhase, UsageEvent,
    WorkerEventType, WorkerState,
};
use eos_core::Error;
use eos_core::store::{Outbox, Tx};
use eos_domain::config::{Config, price_for_model};
use eos_domain::cost::cost_usd;
use eos_domain::tasks::{apply_task_tool, is_task_tool, parse_stored_tasks};
use eos_domain::worker::Usage;
use serde::Serialize;

use crate::transition::{Transition, transition_state};
use crate::turns::{Marked, Turns};

pub(crate) struct SignalCx<'a> {
    pub(crate) now: i64,
    pub(crate) turns: &'a Turns,
    pub(crate) config: &'a Config,
    /// The worker's state: read with its row once per write job, then
    /// followed through every move the job makes (nothing else writes it meanwhile).
    pub(crate) state: Cell<WorkerState>,
    /// The worker's model, from the same read (no event changes it).
    pub(crate) model: Option<String>,
    /// The settle marks this job made (the first and the last), taken back when its write
    /// is not saved and tried again: the retry must see the turn as the first try did.
    pub(crate) marked: Cell<Option<(Marked, Marked)>>,
}

impl SignalCx<'_> {
    fn mark_settling(&self, worker_id: &str) {
        let marked = self.turns.mark_settling(worker_id);
        self.marked.set(Some((self.marked.get().map_or(marked, |(first, _)| first), marked)));
    }
}

/// What applying an event did that the caller acts on after the commit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Applied {
    /// The worker moved to IDLE: its queue (then the idle hooks) get their turn.
    pub(crate) idle: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Change<'a> {
    worker_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_id: Option<i64>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecorded<'a> {
    worker_id: &'a str,
    delta_cost: f64,
}

fn go(
    tx: &dyn Tx,
    out: &mut Outbox,
    cx: &SignalCx<'_>,
    worker_id: &str,
    next: WorkerState,
    reason: &str,
) -> Result<bool, Error> {
    let applied = transition_state(tx, out, cx.now, worker_id, next, reason)? == Transition::Applied;
    if applied {
        cx.state.set(next);
    }
    Ok(applied)
}

/// A worker that is starting always wakes on activity; an idle one only when
/// it is not settling (late output of the turn that just ended).
fn can_recover(cx: &SignalCx<'_>, worker_id: &str) -> bool {
    match cx.state.get() {
        WorkerState::Spawning => true,
        WorkerState::Idle => !cx.turns.is_settling(worker_id),
        _ => false,
    }
}

fn block(tx: &dyn Tx, out: &mut Outbox, cx: &SignalCx<'_>, worker_id: &str, block: &ContentBlock) -> Result<(), Error> {
    let reason = match block {
        ContentBlock::ToolCall(call) => {
            tx.workers().increment_tool_calls(worker_id)?;
            // A task tool's call folds into the worker's task list.
            if is_task_tool(&call.name) {
                let stored = tx.workers().find(worker_id)?.and_then(|w| w.tasks);
                let prev = parse_stored_tasks(stored.as_deref());
                if let Some(next) = apply_task_tool(&prev, &call.name, &call.input) {
                    let json = serde_json::to_string(&next).map_err(Error::storage)?;
                    tx.workers().set_tasks(worker_id, Some(&json))?;
                }
            }
            "agent:tool_call"
        }
        ContentBlock::Text(_) => "agent:text",
        ContentBlock::Reasoning(_) => "agent:reasoning",
        // A tool's result says nothing about the worker's state.
        ContentBlock::ToolResult(_) | ContentBlock::Skill(_) => return Ok(()),
    };
    if can_recover(cx, worker_id) {
        go(tx, out, cx, worker_id, WorkerState::Working, reason)?;
    }
    Ok(())
}

/// Drives the worker's state from an event, without recording it.
fn reduce(
    tx: &dyn Tx,
    out: &mut Outbox,
    cx: &SignalCx<'_>,
    worker_id: &str,
    event: &AgentEvent,
) -> Result<Applied, Error> {
    let mut applied = Applied::default();
    match event {
        AgentEvent::Message(message) => {
            for b in &message.blocks {
                block(tx, out, cx, worker_id, b)?;
            }
        }
        AgentEvent::Turn(turn) => match turn.phase {
            TurnEventPhase::Started => {
                // A turn start comes from the agent's own ordered stream, so it is
                // never late output: the settle window does not hold it. Only an
                // interrupt the stream has not closed yet does.
                let idle = matches!(cx.state.get(), WorkerState::Spawning | WorkerState::Idle);
                if idle && !cx.turns.is_interrupt_pending(worker_id) {
                    go(tx, out, cx, worker_id, WorkerState::Working, "agent:turn_started")?;
                }
            }
            TurnEventPhase::Ended | TurnEventPhase::Aborted | TurnEventPhase::Error => {
                let reason = match turn.phase {
                    TurnEventPhase::Aborted => "agent:turn_aborted",
                    TurnEventPhase::Error => "agent:turn_error",
                    _ => "agent:turn_ended",
                };
                cx.mark_settling(worker_id);
                go(tx, out, cx, worker_id, WorkerState::Idle, reason)?;
                // Idle now, whether this event moved it or an interrupt already had.
                applied.idle = cx.state.get() == WorkerState::Idle;
            }
        },
        AgentEvent::Activity(activity) => match activity.kind {
            // A subagent's inner tool says nothing about its parent.
            ActivityEventKind::ToolFinished if activity.parent_call_id.as_ref().is_some_and(Option::is_some) => {}
            ActivityEventKind::ToolFinished => {
                if !cx.turns.is_settling(worker_id) {
                    go(tx, out, cx, worker_id, WorkerState::Working, "agent:tool_finished")?;
                }
            }
            ActivityEventKind::Alive => {
                let idle = matches!(cx.state.get(), WorkerState::Spawning | WorkerState::Idle);
                if idle && !cx.turns.is_settling(worker_id) {
                    go(tx, out, cx, worker_id, WorkerState::Working, "agent:alive")?;
                }
            }
            ActivityEventKind::ToolStarted => {}
        },
        AgentEvent::Session(session) => match session.phase {
            SessionEventPhase::Ready => {
                // What a resume needs after a restart.
                if let Some(id) = session.session_id.as_deref().filter(|id| !id.is_empty()) {
                    tx.workers().set_engine_session(worker_id, id)?;
                }
            }
            SessionEventPhase::Ended => {
                go(tx, out, cx, worker_id, WorkerState::Ending, "agent:session_ended")?;
            }
            SessionEventPhase::Cleared => {
                // The agent lives on with an empty conversation: its task list
                // and its context size belonged to the old one.
                tx.workers().set_tasks(worker_id, None)?;
                tx.workers().set_context_tokens(worker_id, 0)?;
                cx.mark_settling(worker_id);
                applied.idle = go(tx, out, cx, worker_id, WorkerState::Idle, "agent:session_cleared")?;
            }
            SessionEventPhase::Started => {}
        },
        _ => {}
    }
    Ok(applied)
}

fn usage(
    tx: &dyn Tx,
    out: &mut Outbox,
    cx: &SignalCx<'_>,
    worker_id: &str,
    event: &UsageEvent,
    row_id: i64,
) -> Result<(), Error> {
    let u = &event.usage;
    // The model the usage names, else the worker's, else today's fallback.
    let named = u.model.clone().flatten();
    let model = named.or_else(|| cx.model.clone()).unwrap_or_else(|| "opus".to_owned());
    let tier = |key: &str| u.cache_write_tokens.get(key).map_or(0, |n| n.0 as i64);
    let mut tokens = Usage {
        tokens_in: u.input_tokens.0 as i64,
        tokens_out: u.output_tokens.0 as i64,
        tokens_cache_read: u.cache_read_tokens.0 as i64,
        tokens_cache_create: tier("5m"),
        tokens_cache_create_1h: tier("1h"),
        cost_usd: 0.0,
    };
    let delta_cost = cost_usd(price_for_model(cx.config, Some(&model)), &tokens);
    tokens.cost_usd = delta_cost;
    tx.workers().add_usage(worker_id, &tokens)?;
    // The row keeps the cost, so a session's total is a sum of rows.
    let mut payload = serde_json::to_value(u).map_err(Error::storage)?;
    if let Some(fields) = payload.as_object_mut() {
        fields.insert("deltaCost".into(), delta_cost.into());
    }
    tx.events().patch_payload(row_id, &payload.to_string())?;
    out.push(USAGE_RECORDED, &UsageRecorded { worker_id, delta_cost });
    Ok(())
}

fn says_something(block: &ContentBlock) -> bool {
    matches!(block, ContentBlock::Text(text) if !text.text.trim().is_empty())
}

/// Each assistant text block that says something gets its message id, the
/// handle a reply points at: the event as recorded, when it gets one.
fn stamp_message_ids(tx: &dyn Tx, worker_id: &str, event: &AgentEvent) -> Result<Option<AgentEvent>, Error> {
    let AgentEvent::Message(message) = event else { return Ok(None) };
    if message.role != AgentMessageEventRole::Assistant || !message.blocks.iter().any(says_something) {
        return Ok(None);
    }
    let mut message = message.clone();
    for block in &mut message.blocks {
        if says_something(block)
            && let ContentBlock::Text(text) = block
        {
            text.msg_id = Some(tx.message_ids().next_assistant(worker_id)?);
        }
    }
    Ok(Some(AgentEvent::Message(message)))
}

/// Records `event` in the worker's log and applies it. Live text never comes
/// here (it is never logged); the context size is kept on the row only.
pub(crate) fn apply(
    tx: &dyn Tx,
    out: &mut Outbox,
    cx: &SignalCx<'_>,
    worker_id: &str,
    event: &AgentEvent,
) -> Result<Applied, Error> {
    match event {
        AgentEvent::Delta(_) => return Ok(Applied::default()),
        AgentEvent::Context(context) => {
            tx.workers().set_context_tokens(worker_id, context.tokens.0 as i64)?;
            out.push(WORKER_CHANGE, &Change { worker_id, row_id: None, kind: Some("context") });
            return Ok(Applied::default());
        }
        _ => {}
    }
    let stamped = stamp_message_ids(tx, worker_id, event)?;
    let event = stamped.as_ref().unwrap_or(event);
    let row_id = tx.events().append_json(worker_id, cx.now, WorkerEventType::AgentEvent, event)?;
    out.push(WORKER_CHANGE, &Change { worker_id, row_id: Some(row_id), kind: Some("agent_event") });
    if let AgentEvent::Usage(used) = event {
        usage(tx, out, cx, worker_id, used, row_id)?;
        return Ok(Applied::default());
    }
    reduce(tx, out, cx, worker_id, event)
}
