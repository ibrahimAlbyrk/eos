//! Delivering a message to a worker (`core/src/use-cases/DispatchMessage.ts`,
//! `DrainQueuedMessages.ts`).
//!
//! A message to a busy worker waits in its queue when the sender asks for
//! that (or a feature holds the worker); a worker that goes idle gets the
//! oldest waiting message, one per turn. A repeated send (the same client
//! id) is delivered once.

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::store::{NewQueuedMessage, Outbox, Tx};
use eos_domain::Worker;
use eos_domain::envelope::{Envelope, apply_sender_tag, sender_tag};
use eos_domain::message_id::{prefix_operator_turn, starts_with_slash_command};
use eos_domain::message_queue::{MessagePlane, QueueMeta};
use serde_json::{Map, Value, json};

use crate::service::{Changed, Sessions};
use crate::transition::transition_state;

/// The same text again inside this window is noted as a likely duplicate.
const DUPLICATE_TEXT_WINDOW_MS: i64 = 10_000;
const EXCERPT_CHARS: usize = 500;

/// One message for a worker.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MessageInput {
    pub worker_id: String,
    /// What the agent reads.
    pub text: String,
    /// What the chat shows instead of `text`.
    pub display_text: Option<String>,
    /// The sender's own id: a second send of it is ignored.
    pub client_msg_id: Option<String>,
    /// Wait in the queue while the worker is busy instead of interleaving.
    pub queue_when_busy: bool,
    /// The client ids recorded on the chat row (a drained message's own).
    pub record_client_msg_ids: Option<Vec<String>>,
    /// Who asked, for the log (`dashboard`, `queue-drain`, …).
    pub origin: Option<String>,
    /// Set when the message is not the operator's own.
    pub envelope: Option<Envelope>,
    /// What a click in a visual answer carries.
    pub action: Option<Value>,
    /// Only an orchestrator may be addressed (the orchestrator routes).
    pub require_orchestrator: bool,
}

/// What became of a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatched {
    /// Delivered: the worker is working on it.
    Sent,
    /// Waiting for the worker to go idle.
    Queued { queue_id: i64 },
    /// A repeat of a message already taken.
    Deduped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Drained {
    Dispatched,
    Empty,
    NotIdle,
    Failed,
}

enum Plan {
    Done(Dispatched),
    Send { outgoing: String, claim: Option<i64> },
}

fn plane(input: &MessageInput) -> MessagePlane {
    if input.envelope.is_some() { MessagePlane::Agent } else { MessagePlane::User }
}

fn meta(input: &MessageInput) -> QueueMeta {
    QueueMeta {
        envelope: input.envelope.as_ref().and_then(|e| serde_json::to_value(e).ok()),
        display_text: input.display_text.clone(),
        reply_to: None,
        action: input.action.clone(),
    }
}

fn excerpt(text: &str) -> String {
    text.chars().take(EXCERPT_CHARS).collect()
}

/// The chat row of a delivered message: what the transcript shows.
fn chat_row(
    tx: &dyn Tx,
    now: i64,
    input: &MessageInput,
    msg_id: Option<i64>,
    client_ids: Option<&[String]>,
) -> Result<Option<i64>, Error> {
    let mut base = Map::new();
    base.insert("text".into(), input.display_text.clone().unwrap_or_else(|| input.text.clone()).into());
    if let Some(id) = msg_id {
        base.insert("msgId".into(), id.to_string().into());
    }
    let with = |mut base: Map<String, Value>, extra: [(&str, &str); 2]| {
        for (key, value) in extra {
            base.insert(key.into(), value.into());
        }
        Value::Object(base)
    };
    let id = &input.worker_id;
    let (kind, payload) = match &input.envelope {
        Some(Envelope::OrchestratorMessage { from_parent, parent_name }) => (
            WorkerEventType::OrchestratorMessage,
            with(base, [("fromParent", from_parent), ("parentName", parent_name.as_deref().unwrap_or(from_parent))]),
        ),
        Some(Envelope::WorkerReport { from_worker, worker_name, .. }) => (
            WorkerEventType::WorkerReport,
            with(base, [("fromWorker", from_worker), ("workerName", worker_name.as_deref().unwrap_or(from_worker))]),
        ),
        Some(Envelope::PeerRequest { from_worker, from_name }) => (
            WorkerEventType::PeerRequest,
            with(base, [("fromWorker", from_worker), ("fromName", from_name.as_deref().unwrap_or(from_worker))]),
        ),
        Some(Envelope::Loop { .. }) => (WorkerEventType::LoopContinuation, Value::Object(base)),
        Some(Envelope::ReportReminder) => (WorkerEventType::ReportReminder, Value::Object(base)),
        Some(Envelope::PermissionAsk { .. }) => (WorkerEventType::PermissionAsk, Value::Object(base)),
        // The operator's own message (and what has no row kind of its own).
        Some(Envelope::ContextThreshold { .. }) | None => {
            if let Some(ids) = client_ids.filter(|ids| !ids.is_empty()) {
                base.insert("clientMsgIds".into(), json!(ids));
            }
            if let Some(action) = &input.action {
                base.insert("action".into(), action.clone());
            }
            let row = tx.events().append_json(id, now, WorkerEventType::UserMessage, &Value::Object(base))?;
            return Ok(Some(row));
        }
    };
    tx.events().append_json(id, now, kind, &payload)?;
    Ok(None)
}

/// The message as the agent reads it: the operator's own words carry their
/// message id; anyone else's are wrapped in the sender's tag.
fn outgoing(tx: &dyn Tx, input: &MessageInput) -> Result<(String, Option<i64>), Error> {
    match &input.envelope {
        Some(envelope) => {
            let msg_id = tx.message_ids().next_inbound(&input.worker_id)?;
            let (class, mut attrs) = sender_tag(envelope);
            attrs.push(("id", Some(msg_id.to_string())));
            Ok((apply_sender_tag(&input.text, class, &attrs), Some(msg_id)))
        }
        // A typed command must stay the first thing the agent's own parser sees.
        None if starts_with_slash_command(&input.text) => Ok((input.text.clone(), None)),
        None => {
            let msg_id = tx.message_ids().next_inbound(&input.worker_id)?;
            Ok((prefix_operator_turn(&input.text, Some(msg_id), None), Some(msg_id)))
        }
    }
}

fn plan(
    tx: &dyn Tx,
    out: &mut Outbox,
    sessions: &Sessions,
    input: &MessageInput,
    must_queue: bool,
) -> Result<Plan, Error> {
    let now = sessions.now();
    let id = input.worker_id.as_str();
    let worker = tx.workers().find(id)?.ok_or_else(|| Error::not_found("worker", id))?;
    let backlog = || Ok::<bool, Error>(!tx.message_queue().list_pending(id)?.is_empty());
    let busy = worker.state == WorkerState::Working || (worker.state == WorkerState::Idle && backlog()?);
    if must_queue && busy {
        let queued = tx.message_queue().insert(&NewQueuedMessage {
            worker_id: id.to_owned(),
            client_msg_id: input.client_msg_id.clone(),
            text: input.text.clone(),
            created_at: now,
            dispatched_at: None,
            meta: meta(input),
            plane: plane(input),
        })?;
        let Some(queue_id) = queued else { return Ok(Plan::Done(Dispatched::Deduped)) };
        out.push(WORKER_CHANGE, &Changed { worker_id: id, queued: Some(true) });
        return Ok(Plan::Done(Dispatched::Queued { queue_id }));
    }

    // Deliver now. A send that carries a client id claims it first: a repeat
    // finds the claim and is dropped.
    let record = |dispatched: bool| NewQueuedMessage {
        worker_id: id.to_owned(),
        client_msg_id: input.client_msg_id.clone(),
        text: input.text.clone(),
        created_at: now,
        dispatched_at: dispatched.then_some(now),
        meta: QueueMeta::default(),
        plane: plane(input),
    };
    let drained = input.origin.as_deref() == Some("queue-drain");
    let mut claim = None;
    if input.client_msg_id.is_some() {
        claim = tx.message_queue().insert(&record(true))?;
        if claim.is_none() {
            return Ok(Plan::Done(Dispatched::Deduped));
        }
    } else {
        if tx.message_queue().has_recent_dispatch(id, &input.text, now - DUPLICATE_TEXT_WINDOW_MS)? {
            let note =
                json!({"phase": "duplicate_dispatch_suspected", "text": excerpt(&input.text), "origin": input.origin});
            tx.events().append_json(id, now, WorkerEventType::Lifecycle, &note)?;
        }
        if !drained {
            // What the duplicate check above looks for next time.
            tx.message_queue().insert(&record(true))?;
        }
    }

    let (text, msg_id) = outgoing(tx, input)?;
    let client_ids = input.record_client_msg_ids.clone().or(input.client_msg_id.clone().map(|id| vec![id]));
    let row = chat_row(tx, now, input, msg_id, client_ids.as_deref())?;
    sessions.0.turns.clear_settle(id);
    sessions.0.turns.reset_output(id);
    if let Some(row) = row {
        sessions.0.turns.set_recall_row(id, row);
    }
    out.push(WORKER_CHANGE, &Changed { worker_id: id, queued: None });
    let reason = input.envelope.as_ref().map_or("user_message", Envelope::kind);
    transition_state(tx, out, now, id, WorkerState::Working, reason)?;
    Ok(Plan::Send { outgoing: text, claim })
}

impl Sessions {
    async fn worker(&self, worker_id: &str) -> Result<Option<Worker>, Error> {
        let id = worker_id.to_owned();
        self.store().read(move |tx| tx.workers().find(&id)).await
    }

    /// Delivers `input` to its worker, or queues it.
    ///
    /// The chat row and the move to WORKING are saved before the session
    /// gets the message, so the agent's first events never land ahead of the
    /// prompt they answer. A session that turns out to be gone gives the
    /// worker its idle state back and the caller an error.
    pub async fn dispatch(&self, input: MessageInput) -> Result<Dispatched, Error> {
        let id = input.worker_id.clone();
        let worker = self.worker(&id).await?.ok_or_else(|| Error::not_found("worker", &id))?;
        if input.require_orchestrator && !worker.is_orchestrator {
            return Err(Error::not_found("orchestrator", &id));
        }
        let session = self.session(&id);
        if input.require_orchestrator && session.is_none() {
            return Err(Error::Conflict("orchestrator process not running (was killed)".into()));
        }
        // A message taken from the queue is never put back in it.
        let drained = input.origin.as_deref() == Some("queue-drain");
        let must_queue = !drained && (input.queue_when_busy || self.0.deps.hooks.holds_worker(&id));
        let (sessions, message) = (self.clone(), input.clone());
        let planned = self.store().write(move |tx, out| plan(tx, out, &sessions, &message, must_queue)).await?;
        let (outgoing, claim) = match planned {
            Plan::Done(done) => {
                if matches!(done, Dispatched::Queued { .. }) {
                    // An idle worker with a backlog: the queue moves now.
                    self.settled(&id).await;
                }
                return Ok(done);
            }
            Plan::Send { outgoing, claim } => (outgoing, claim),
        };
        let sent = match session {
            Some(session) => session.send(outgoing).await.map_err(|e| e.to_string()),
            None => Err("no live session".to_owned()),
        };
        if let Err(why) = sent {
            tracing::warn!(worker_id = %id, error = %why, "a message could not be delivered");
            let (worker_id, now) = (id.clone(), self.now());
            self.store()
                .write(move |tx, out| {
                    if let Some(claim) = claim {
                        tx.message_queue().remove_by_id(claim)?;
                    }
                    transition_state(tx, out, now, &worker_id, WorkerState::Idle, "delivery_failed")?;
                    Ok(())
                })
                .await?;
            return Err(Error::Unreachable("worker".into()));
        }
        Ok(Dispatched::Sent)
    }

    /// Delivers the oldest waiting message of an idle worker. The row counts
    /// as delivered only after the delivery worked: a failure leaves it for
    /// the next idle edge.
    pub(crate) async fn drain(&self, worker_id: &str) -> Drained {
        // A held worker (it is being summarized) keeps its queue for later.
        if self.0.deps.hooks.holds_worker(worker_id) {
            return Drained::NotIdle;
        }
        {
            let id = worker_id.to_owned();
            let head = self
                .store()
                .read(move |tx| {
                    let Some(worker) = tx.workers().find(&id)? else { return Ok(Err(Drained::Empty)) };
                    if worker.state != WorkerState::Idle {
                        return Ok(Err(Drained::NotIdle));
                    }
                    Ok(tx.message_queue().list_pending(&id)?.into_iter().next().ok_or(Drained::Empty))
                })
                .await;
            let head = match head {
                Ok(Ok(head)) => head,
                Ok(Err(outcome)) => return outcome,
                Err(_) => return Drained::Failed,
            };
            let envelope = head.meta.envelope.clone().and_then(|e| serde_json::from_value(e).ok());
            let message = MessageInput {
                worker_id: worker_id.to_owned(),
                text: head.text.clone(),
                display_text: head.meta.display_text.clone(),
                record_client_msg_ids: Some(head.client_msg_id.clone().into_iter().collect()),
                origin: Some("queue-drain".into()),
                envelope,
                action: head.meta.action.clone(),
                ..MessageInput::default()
            };
            if let Err(e) = self.dispatch(message).await {
                tracing::warn!(worker_id, queue_id = head.id, error = %e, "a queued message stays queued");
                return Drained::Failed;
            }
            let now = self.now();
            let marked = self.store().write(move |tx, _| tx.message_queue().mark_dispatched(&[head.id], now)).await;
            if marked.is_ok() { Drained::Dispatched } else { Drained::Failed }
        }
    }
}
