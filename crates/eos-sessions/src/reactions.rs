//! Emoji reactions on a chat's messages.
//!
//! The user reacts to any message of a chat they talk to (a focused chat, an
//! orchestrator); the agent reacts to the user's. The agent hears of the
//! user's reactions as `<reaction>` lines:
//!
//! - a reaction on the agent's latest message, while the agent waits for the
//!   user, starts a turn of nothing but those lines at once. The agent may
//!   end that turn without a word;
//! - any other reaction goes with the next message the user sends.
//!
//! What the agent was told is kept with the reaction, so nothing is told
//! twice and a quit loses nothing.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use eos_contracts::stream::topics::{REACTIONS_CHANGE, WORKER_CHANGE};
use eos_contracts::{FOCUSED_ROLE, Reaction, ReactionActor, ReactionChange, WorkerEventType, WorkerState};
use eos_core::agent::{AgentReactions, ReactTarget, Reacted};
use eos_core::store::{EventOrder, EventQuery, Outbox, StoredReaction, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::Worker;
use eos_domain::message_id::{ReplyTarget, excerpt, reply_target_from_row};
use eos_domain::reaction::{ReactionNote, parse_emoji, reactable, reaction_line};
use serde_json::Value;

use crate::dispatch::context_boundary;
use crate::service::{Changed, Sessions};
use crate::transition::transition_state;

/// The most turns the reactions on one message start: a user toggling an
/// emoji does not spend a turn each time.
const WAKES_PER_MESSAGE: u32 = 3;
/// The most reactions one turn tells the agent about; the rest go with a later one.
const TOLD_PER_TURN: i64 = 12;
/// How far back the agent's latest message is looked for.
const LATEST_WINDOW: i64 = 60;

/// The message of each worker whose reactions started turns, and how many;
/// in memory, dropped with the worker's session.
#[derive(Default)]
pub(crate) struct Reactions(Mutex<HashMap<String, (i64, u32)>>);

impl Reactions {
    fn may_wake(&self, worker_id: &str, row_id: i64) -> bool {
        let woke = self.0.lock().unwrap_or_else(PoisonError::into_inner).get(worker_id).copied();
        !matches!(woke, Some((row, count)) if row == row_id && count >= WAKES_PER_MESSAGE)
    }

    fn woke(&self, worker_id: &str, row_id: i64) {
        let mut all = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let count = match all.get(worker_id) {
            Some((row, count)) if *row == row_id => count + 1,
            _ => 1,
        };
        all.insert(worker_id.to_owned(), (row_id, count));
    }

    pub(crate) fn forget(&self, worker_id: &str) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(worker_id);
    }
}

/// The user's reactions a turn tells the agent about.
pub(crate) struct Telling {
    /// What the agent reads: one `<reaction>` a line.
    pub(crate) lines: String,
    /// Each told reaction's message with what the agent knew before.
    undo: Vec<(i64, Option<String>)>,
}

fn takes_reactions(worker: &Worker) -> bool {
    !worker.is_archived() && (worker.is_orchestrator || worker.agent_role.as_deref() == Some(FOCUSED_ROLE))
}

fn chat(tx: &dyn Tx, worker_id: &str) -> Result<Worker, Error> {
    let worker = tx.workers().find(worker_id)?.ok_or_else(|| Error::not_found("worker", worker_id))?;
    if worker.is_archived() {
        return Err(Error::Conflict("worker is archived — restore first".into()));
    }
    if !takes_reactions(&worker) {
        return Err(Error::Conflict("this chat takes no reactions".into()));
    }
    Ok(worker)
}

fn message(tx: &dyn Tx, worker_id: &str, row_id: i64, actor: ReactionActor) -> Result<ReplyTarget, Error> {
    let row = tx.events().find(worker_id, row_id)?.ok_or_else(|| Error::not_found("message", row_id.to_string()))?;
    reply_target_from_row(row.id, &row.kind, row.payload.as_deref())
        .filter(|target| reactable(target, actor))
        .ok_or_else(|| Error::Conflict("this message can't take a reaction".into()))
}

fn announce(out: &mut Outbox, worker_id: &str, row: &StoredReaction) {
    let seen = (row.actor == ReactionActor::User).then(|| row.emoji.is_some() && row.emoji == row.told);
    let change = ReactionChange {
        worker_id: worker_id.to_owned(),
        row_id: row.event_id,
        actor: row.actor,
        emoji: row.emoji.clone(),
        at: row.at,
        seen,
    };
    out.push(REACTIONS_CHANGE, &change);
}

/// The actor's reaction on a message after a change, announced.
fn changed(
    tx: &dyn Tx,
    out: &mut Outbox,
    worker_id: &str,
    row_id: i64,
    actor: ReactionActor,
    now: i64,
) -> Result<StoredReaction, Error> {
    let gone = || StoredReaction {
        event_id: row_id,
        worker_id: worker_id.to_owned(),
        actor,
        emoji: None,
        told: None,
        at: now,
    };
    let row = tx.reactions().find(row_id, actor)?.unwrap_or_else(gone);
    announce(out, worker_id, &row);
    Ok(row)
}

fn wire(row: StoredReaction) -> Option<Reaction> {
    let seen = (row.actor == ReactionActor::User).then(|| row.emoji == row.told);
    Some(Reaction { row_id: row.event_id, actor: row.actor, emoji: row.emoji?, at: row.at, seen })
}

/// The rows of the agent's latest message, newest first: the last thing it
/// said, which the chat shows as one message even when it was written in
/// several pieces. Empty when something reached the agent after it (a
/// message, a report, a plan that ran out).
fn latest_agent_message(tx: &dyn Tx, worker_id: &str) -> Result<Vec<i64>, Error> {
    let newest = tx.events().list(&EventQuery {
        worker_id: worker_id.to_owned(),
        since: 0,
        limit: LATEST_WINDOW,
        order: EventOrder::Desc,
        before_id: None,
        after_id: None,
    })?;
    let mut said = Vec::new();
    for row in newest.iter().rev() {
        match row.kind.as_str() {
            "user_message"
            | "orchestrator_message"
            | "worker_report"
            | "peer_request"
            | "report_reminder"
            | "permission_ask"
            | "accounts_exhausted" => break,
            "agent_event" => {
                let event: Value =
                    row.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
                if reply_target_from_row(row.id, &row.kind, row.payload.as_deref()).is_some() {
                    said.push(row.id);
                } else if !said.is_empty()
                    && (event["type"] == "message" || (event["type"] == "turn" && event["phase"] == "started"))
                {
                    // A tool call, a tool's result or the turn's start ends the message.
                    break;
                }
            }
            _ => {}
        }
    }
    Ok(said)
}

/// The message whose reaction starts a turn now: the agent's latest, with an
/// emoji the agent has not heard of, and nothing waiting in the queue.
fn wake_row(tx: &dyn Tx, sessions: &Sessions, worker: &Worker) -> Result<Option<i64>, Error> {
    let id = worker.id.as_str();
    if !takes_reactions(worker) {
        return Ok(None);
    }
    let untold = tx.reactions().untold(id, TOLD_PER_TURN)?;
    if !untold.iter().any(|r| r.emoji.is_some()) {
        return Ok(None);
    }
    if sessions.is_held(id) || !tx.message_queue().list_pending(id)?.is_empty() {
        return Ok(None);
    }
    let latest = latest_agent_message(tx, id)?;
    let reacted = untold.iter().find(|r| r.emoji.is_some() && latest.contains(&r.event_id)).map(|r| r.event_id);
    Ok(reacted.filter(|row| sessions.0.reactions.may_wake(id, *row)))
}

/// The agent waits for the user: idle, or at rest with a session to come back to.
fn waits_for_user(worker: &Worker) -> bool {
    match worker.state {
        WorkerState::Idle => true,
        WorkerState::Suspended | WorkerState::Done => worker.session_id.as_deref().is_some_and(|s| !s.is_empty()),
        _ => false,
    }
}

/// Marks the user's untold reactions as told and words them for the agent;
/// `None` when there is nothing to tell. Part of the write that starts the
/// turn they go with.
pub(crate) fn tell(tx: &dyn Tx, out: &mut Outbox, worker_id: &str) -> Result<Option<Telling>, Error> {
    let untold = tx.reactions().untold(worker_id, TOLD_PER_TURN)?;
    if untold.is_empty() {
        return Ok(None);
    }
    let boundary = context_boundary(tx, worker_id)?;
    let (mut lines, mut undo) = (Vec::new(), Vec::new());
    for row in untold {
        let target = tx
            .events()
            .find(worker_id, row.event_id)?
            .and_then(|r| reply_target_from_row(r.id, &r.kind, r.payload.as_deref()));
        let note = target.as_ref().map(|target| ReactionNote {
            target,
            emoji: row.emoji.as_deref(),
            told: row.told.as_deref(),
            in_context: row.event_id > boundary,
        });
        // A reaction whose message is gone has nothing to be told about.
        lines.extend(note.as_ref().and_then(reaction_line));
        tx.reactions().set_told(row.event_id, row.emoji.as_deref())?;
        undo.push((row.event_id, row.told.clone()));
        if row.emoji.is_some() {
            announce(out, worker_id, &StoredReaction { told: row.emoji.clone(), ..row });
        }
    }
    Ok((!lines.is_empty()).then(|| Telling { lines: lines.join("\n"), undo }))
}

/// Takes a telling back: the turn it went with never reached the agent. A
/// reaction that was taken back and told as such has no row left to restore.
pub(crate) fn untell(tx: &dyn Tx, out: &mut Outbox, worker_id: &str, telling: &Telling) -> Result<(), Error> {
    for (row_id, told) in &telling.undo {
        tx.reactions().set_told(*row_id, told.as_deref())?;
        if let Some(row) = tx.reactions().find(*row_id, ReactionActor::User)? {
            announce(out, worker_id, &row);
        }
    }
    Ok(())
}

impl Sessions {
    /// Puts the user's emoji on a message of a chat, in place of their
    /// earlier one. One the agent should act on starts a turn at once.
    pub async fn react_as_user(&self, worker_id: &str, row_id: i64, emoji: &str) -> Result<Reaction, Error> {
        let emoji = parse_emoji(emoji).map_err(|why| Error::Validation(why.into()))?;
        let (id, now) = (worker_id.to_owned(), self.now());
        let set = self
            .store()
            .write(move |tx, out| {
                chat(tx, &id)?;
                message(tx, &id, row_id, ReactionActor::User)?;
                tx.reactions().set(&id, row_id, ReactionActor::User, Some(&emoji), now)?;
                let row = changed(tx, out, &id, row_id, ReactionActor::User, now)?;
                wire(row).ok_or_else(|| Error::Storage("the reaction was not saved".into()))
            })
            .await?;
        tracing::info!(worker_id, row_id, actor = "user", "reaction set");
        // Not tied to the caller: a request that goes away leaves no turn half started.
        let (this, id) = (self.clone(), worker_id.to_owned());
        tokio::spawn(async move {
            this.deliver_reactions(&id).await;
        });
        Ok(set)
    }

    /// Takes the user's emoji off a message; `false` when there was none.
    pub async fn unreact_as_user(&self, worker_id: &str, row_id: i64) -> Result<bool, Error> {
        let (id, now) = (worker_id.to_owned(), self.now());
        let removed = self
            .store()
            .write(move |tx, out| {
                chat(tx, &id)?;
                let had = tx.reactions().find(row_id, ReactionActor::User)?.is_some_and(|r| r.emoji.is_some());
                if had {
                    tx.reactions().set(&id, row_id, ReactionActor::User, None, now)?;
                    changed(tx, out, &id, row_id, ReactionActor::User, now)?;
                }
                Ok(had)
            })
            .await?;
        if removed {
            tracing::info!(worker_id, row_id, actor = "user", "reaction cleared");
        }
        Ok(removed)
    }

    /// The reactions on a worker's messages from row `from_id` to `to_id`.
    pub async fn reactions(
        &self,
        worker_id: &str,
        from_id: i64,
        to_id: i64,
        limit: i64,
    ) -> Result<Vec<Reaction>, Error> {
        let id = worker_id.to_owned();
        self.store()
            .read(move |tx| {
                tx.workers().find(&id)?.ok_or_else(|| Error::not_found("worker", &id))?;
                Ok(tx.reactions().list(&id, from_id, to_id, limit)?.into_iter().filter_map(wire).collect())
            })
            .await
    }

    /// Starts a turn of the user's reactions when one is due (the user just
    /// reacted, or the worker went idle with some waiting); `true` when it did.
    pub(crate) async fn deliver_reactions(&self, worker_id: &str) -> bool {
        let (sessions, id) = (self.clone(), worker_id.to_owned());
        let due = self
            .store()
            .read(move |tx| {
                let Some(worker) = tx.workers().find(&id)? else { return Ok(false) };
                Ok(waits_for_user(&worker) && wake_row(tx, &sessions, &worker)?.is_some())
            })
            .await;
        if !due.unwrap_or(false) {
            return false;
        }
        // A chat at rest comes back first, as a message to it would bring it back.
        if let Err(e) = self.revive(worker_id).await {
            tracing::warn!(worker_id, error = %e, "a reaction found no session to go to");
            return false;
        }
        let Some(session) = self.session(worker_id) else { return false };
        let (sessions, id, now) = (self.clone(), worker_id.to_owned(), self.now());
        let started = self
            .store()
            .write(move |tx, out| {
                let Some(worker) = tx.workers().find(&id)? else { return Ok(None) };
                if worker.state != WorkerState::Idle {
                    return Ok(None);
                }
                let Some(row) = wake_row(tx, &sessions, &worker)? else { return Ok(None) };
                let Some(telling) = tell(tx, out, &id)? else { return Ok(None) };
                sessions.0.turns.clear_settle(&id);
                sessions.0.turns.reset_output(&id);
                out.push(WORKER_CHANGE, &Changed { worker_id: &id, queued: None });
                transition_state(tx, out, now, &id, WorkerState::Working, "reaction")?;
                Ok(Some((row, telling)))
            })
            .await;
        let (row, telling) = match started {
            Ok(Some(started)) => started,
            Ok(None) => return false,
            Err(e) => {
                tracing::warn!(worker_id, error = %e, "a reaction's turn could not be started");
                return false;
            }
        };
        self.0.reactions.woke(worker_id, row);
        tracing::info!(worker_id, row_id = row, "a reaction starts a turn");
        if let Err(e) = session.send(telling.lines.clone()).await {
            tracing::warn!(worker_id, error = %e, "a reaction could not be delivered");
            let (id, now) = (worker_id.to_owned(), self.now());
            let undone = self
                .store()
                .write(move |tx, out| {
                    untell(tx, out, &id, &telling)?;
                    transition_state(tx, out, now, &id, WorkerState::Idle, "delivery_failed")?;
                    Ok(())
                })
                .await;
            if let Err(e) = undone {
                tracing::error!(worker_id, error = %e, "an undelivered reaction could not be taken back");
            }
            return false;
        }
        true
    }

    /// Puts the agent's emoji on one of the user's messages (`None` takes it back).
    async fn react_as_agent(
        &self,
        worker_id: &str,
        target: ReactTarget,
        emoji: Option<&str>,
    ) -> Result<Reacted, Error> {
        let emoji = emoji.map(parse_emoji).transpose().map_err(|why| Error::Validation(why.into()))?;
        let (id, now) = (worker_id.to_owned(), self.now());
        let reacted = self
            .store()
            .write(move |tx, out| {
                chat(tx, &id)?;
                let row_id = match target {
                    ReactTarget::Latest => tx.events().last_id_by_type(&id, WorkerEventType::UserMessage)?,
                    ReactTarget::Message(msg_id) => {
                        let (wanted, needle) = (msg_id.to_string(), format!("\"msgId\":\"{msg_id}\""));
                        let rows =
                            tx.events().list_by_type_containing(&id, WorkerEventType::UserMessage, &[&needle])?;
                        let is_it = |target: &ReplyTarget| target.msg_id.as_deref() == Some(wanted.as_str());
                        rows.iter()
                            .find(|r| {
                                reply_target_from_row(r.id, &r.kind, r.payload.as_deref()).is_some_and(|t| is_it(&t))
                            })
                            .map(|r| r.id)
                    }
                };
                let row_id = row_id.ok_or_else(|| Error::not_found("message", "the user's"))?;
                let target = message(tx, &id, row_id, ReactionActor::Agent)?;
                tx.reactions().set(&id, row_id, ReactionActor::Agent, emoji.as_deref(), now)?;
                changed(tx, out, &id, row_id, ReactionActor::Agent, now)?;
                Ok((row_id, Reacted { excerpt: excerpt(&target.text) }))
            })
            .await?;
        tracing::info!(worker_id, row_id = reacted.0, actor = "agent", "reaction set");
        Ok(reacted.1)
    }
}

impl AgentReactions for Sessions {
    fn react<'a>(
        &'a self,
        worker_id: &'a str,
        target: ReactTarget,
        emoji: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Reacted, Error>> {
        Box::pin(self.react_as_agent(worker_id, target, emoji))
    }
}
