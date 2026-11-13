//! Workers of one orchestrator consulting each other
//! (`core/src/services/Peers.ts`, `manager/services/PendingPeerRequestService.ts`,
//! the peer pump of `manager/daemon.ts`).
//!
//! A request is kept in memory only: `awaiting` (the named peer has not been
//! started yet) → `queued` → `delivered` (the peer is answering it in its
//! current turn) → answered, declined or gone. A peer gets one request per
//! turn, at its idle edge; one it ends its turn without answering is
//! declined, so the asker never waits longer than a turn. A settled request
//! is forgotten five minutes later; everything of a worker goes with it.

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Poll;

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{PeerListItem, PeerRef, WorkerEventType, WorkerState};
use eos_core::store::Tx;
use eos_core::{Clock, Error, Ids};
use eos_domain::Worker;
use eos_domain::envelope::Envelope;
use eos_domain::worker::state_name;
use serde_json::json;
use tokio::sync::Notify;

use crate::dispatch::MessageInput;
use crate::service::{Claims, Sessions};

/// How long a settled request stays readable.
const TERMINAL_GRACE_MS: i64 = 5 * 60 * 1000;
const NO_PEER_JOINED: &str = "no peer matching your request joined within the wait window — proceed on your best judgment, or finish with a 'needs input:'/'failed:' report if you are truly blocked";

/// Where a request stands, as its asker sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerAnswer {
    /// Waiting for the peer to exist, to go idle, or to answer.
    Pending,
    Answered(String),
    Declined(String),
    /// The peer stopped, the asker was interrupted, or nobody knows the request.
    Gone,
}

/// What registering a request came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerAsk {
    Registered {
        request_id: String,
    },
    /// Turned away before it reached anyone.
    Declined {
        reason: String,
    },
}

/// The asker an answer went to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAnswered {
    pub to_worker: String,
    pub to_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum State {
    Awaiting { target: PeerRef, deadline: i64 },
    Queued,
    Delivered,
    Answered(String),
    Declined(String),
    Gone,
}

#[derive(Debug, Clone)]
struct Entry {
    id: String,
    from: String,
    to: Option<String>,
    /// The group an awaiting request waits in.
    parent_id: Option<String>,
    question: String,
    state: State,
    settled_at: Option<i64>,
}

impl Entry {
    fn pending(&self) -> bool {
        self.settled_at.is_none()
    }
}

struct Queued {
    request_id: String,
    from: String,
    question: String,
}

/// The requests in flight, oldest first.
pub(crate) struct PeerRequests {
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    entries: Mutex<Vec<Entry>>,
    /// Workers being looked at for a delivery right now.
    pumping: Claims,
    /// Woken whenever a request settles.
    settled: Notify,
}

impl PeerRequests {
    pub(crate) fn new(clock: Arc<dyn Clock>, ids: Arc<dyn Ids>) -> Self {
        Self { clock, ids, entries: Mutex::default(), pumping: Claims::default(), settled: Notify::new() }
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn settle(&self, entry: &mut Entry, state: State) {
        if entry.pending() {
            entry.state = state;
            entry.settled_at = Some(self.clock.now_ms());
            self.settled.notify_waiters();
        }
    }

    /// Forgets what settled long ago and declines the requests whose peer
    /// never joined.
    fn maintain(&self, entries: &mut Vec<Entry>) {
        let now = self.clock.now_ms();
        entries.retain(|e| e.settled_at.is_none_or(|at| at >= now - TERMINAL_GRACE_MS));
        for entry in entries.iter_mut() {
            if matches!(entry.state, State::Awaiting { deadline, .. } if now >= deadline) {
                self.settle(entry, State::Declined(NO_PEER_JOINED.to_owned()));
            }
        }
    }

    fn add(&self, from: &str, to: Option<&str>, parent_id: Option<&str>, question: &str, state: State) -> String {
        let mut entries = self.entries();
        self.maintain(&mut entries);
        let id = self.ids.request_id();
        entries.push(Entry {
            id: id.clone(),
            from: from.to_owned(),
            to: to.map(str::to_owned),
            parent_id: parent_id.map(str::to_owned),
            question: question.to_owned(),
            state,
            settled_at: None,
        });
        id
    }

    pub(crate) fn poll(&self, request_id: &str) -> PeerAnswer {
        let mut entries = self.entries();
        self.maintain(&mut entries);
        match entries.iter().find(|e| e.id == request_id).map(|e| &e.state) {
            Some(State::Awaiting { .. } | State::Queued | State::Delivered) => PeerAnswer::Pending,
            Some(State::Answered(answer)) => PeerAnswer::Answered(answer.clone()),
            Some(State::Declined(reason)) => PeerAnswer::Declined(reason.clone()),
            Some(State::Gone) | None => PeerAnswer::Gone,
        }
    }

    /// When an awaiting request gives up, if it is still awaiting.
    fn deadline(&self, request_id: &str) -> Option<i64> {
        self.entries().iter().find(|e| e.id == request_id).and_then(|e| match e.state {
            State::Awaiting { deadline, .. } => Some(deadline),
            _ => None,
        })
    }

    fn next_queued_for(&self, to: &str) -> Option<Queued> {
        let mut entries = self.entries();
        self.maintain(&mut entries);
        entries.iter().find(|e| e.to.as_deref() == Some(to) && e.state == State::Queued).map(|e| Queued {
            request_id: e.id.clone(),
            from: e.from.clone(),
            question: e.question.clone(),
        })
    }

    fn mark_delivered(&self, request_id: &str) {
        if let Some(entry) = self.entries().iter_mut().find(|e| e.id == request_id && e.state == State::Queued) {
            entry.state = State::Delivered;
        }
    }

    /// Settles the one request `to` is answering; `None` when there is none.
    fn settle_delivered(&self, to: &str, state: State) -> Option<String> {
        let mut entries = self.entries();
        let entry = entries.iter_mut().find(|e| e.to.as_deref() == Some(to) && e.state == State::Delivered)?;
        self.settle(entry, state);
        Some(entry.from.clone())
    }

    /// A worker is gone (removed, archived, exited, its context cleared):
    /// what it asked is dropped, what was asked of it ends as gone.
    pub(crate) fn cancel_by_worker(&self, worker_id: &str) {
        let mut entries = self.entries();
        let before = entries.len();
        entries.retain(|e| e.from != worker_id);
        if entries.len() != before {
            self.settled.notify_waiters();
        }
        for entry in entries.iter_mut().filter(|e| e.to.as_deref() == Some(worker_id)) {
            self.settle(entry, State::Gone);
        }
    }

    /// Drops one request (its asker stopped waiting).
    pub(crate) fn withdraw(&self, request_id: &str) {
        self.entries().retain(|e| e.id != request_id);
    }

    /// `from` asking `to` would close a circle of workers each waiting on
    /// the next: none of them could ever go idle to answer.
    fn would_deadlock(entries: &[Entry], from: &str, to: &str) -> bool {
        let (mut seen, mut stack) = (Vec::new(), vec![to]);
        while let Some(node) = stack.pop() {
            if node == from {
                return true;
            }
            if seen.contains(&node) {
                continue;
            }
            seen.push(node);
            stack.extend(entries.iter().filter(|e| e.pending() && e.from == node).filter_map(|e| e.to.as_deref()));
        }
        false
    }

    pub(crate) fn len(&self) -> usize {
        self.entries().len()
    }
}

fn consultable(worker: &Worker, lazy_resume: bool) -> bool {
    matches!(worker.state, WorkerState::Spawning | WorkerState::Working | WorkerState::Idle)
        || (worker.state == WorkerState::Suspended && lazy_resume)
}

fn label(worker: &Worker) -> &str {
    worker.name.as_deref().unwrap_or(&worker.id)
}

/// The collaborating workers beside `asker` under the same parent.
fn siblings(tx: &dyn Tx, asker: &Worker) -> Result<Vec<Worker>, Error> {
    let Some(parent_id) = asker.parent_id.as_deref().filter(|_| asker.collaborate) else { return Ok(Vec::new()) };
    let all = tx.workers().list_by_parent(parent_id)?;
    Ok(all.into_iter().filter(|w| w.id != asker.id && !w.is_archived() && w.collaborate).collect())
}

enum Resolution {
    Resolved(Box<Worker>),
    /// Nobody by that id or name yet: it may still be started.
    Absent,
    Denied(String),
}

/// Who `target` names for `asker_id` (`resolvePeerRef`).
fn resolve(tx: &dyn Tx, asker_id: &str, target: &PeerRef, lazy_resume: bool) -> Result<Resolution, Error> {
    let asker = tx.workers().find(asker_id)?;
    let Some(asker) = asker.filter(|a| a.collaborate && a.parent_id.is_some()) else {
        return Ok(Resolution::Denied("you are not in a collaboration group".into()));
    };
    let siblings = siblings(tx, &asker)?;
    let own = || Resolution::Denied("a worker cannot consult itself".into());
    if let Some(id) = &target.id {
        if id == asker_id {
            return Ok(own());
        }
        return Ok(match siblings.into_iter().find(|w| &w.id == id) {
            None => Resolution::Absent,
            Some(peer) if !consultable(&peer, lazy_resume) => {
                Resolution::Denied(format!("peer {} is not available to consult right now", label(&peer)))
            }
            Some(peer) => Resolution::Resolved(Box::new(peer)),
        });
    }
    let name = target.name.as_deref();
    let mut matches: Vec<Worker> =
        siblings.into_iter().filter(|w| w.name.as_deref() == name && consultable(w, lazy_resume)).collect();
    Ok(match matches.len() {
        0 if asker.name.as_deref() == name => own(),
        0 => Resolution::Absent,
        1 => Resolution::Resolved(Box::new(matches.remove(0))),
        _ => Resolution::Denied(format!(
            "more than one peer is named \"{}\" — use an id from list_peers",
            name.unwrap_or_default()
        )),
    })
}

fn circular(peer: &Worker) -> String {
    format!(
        "consulting {} would create a circular wait — answer from what you already have, or restructure",
        label(peer)
    )
}

impl Sessions {
    /// A worker at rest can be woken for a consultation when its
    /// conversation can be continued.
    fn lazy_resume(&self) -> bool {
        self.0.deps.runtime.descriptor().capabilities.resumable == Some(true)
    }

    /// The collaborating siblings `worker_id` may consult (`GET /workers/:id/peers`).
    pub async fn peers_of(&self, worker_id: &str) -> Result<Vec<PeerListItem>, Error> {
        let (id, lazy) = (worker_id.to_owned(), self.lazy_resume());
        self.store()
            .read(move |tx| {
                let Some(me) = tx.workers().find(&id)? else { return Ok(Vec::new()) };
                let peers = siblings(tx, &me)?.into_iter().filter(|w| consultable(w, lazy));
                Ok(peers
                    .map(|w| PeerListItem {
                        state: state_name(w.state).to_owned(),
                        summary: w.prompt.lines().next().unwrap_or_default().chars().take(160).collect(),
                        id: w.id,
                        name: w.name,
                    })
                    .collect())
            })
            .await
    }

    /// Registers `from`'s question for a peer. A peer named before it exists
    /// is waited for; the request is delivered at the peer's next idle edge.
    pub async fn ask_peer(&self, from: &str, target: PeerRef, question: &str) -> Result<PeerAsk, Error> {
        let peers = &self.0.peers;
        let (asker_id, wanted, lazy) = (from.to_owned(), target.clone(), self.lazy_resume());
        let (resolution, asker) = self
            .store()
            .read(move |tx| Ok((resolve(tx, &asker_id, &wanted, lazy)?, tx.workers().find(&asker_id)?)))
            .await?;
        let peer = match resolution {
            Resolution::Denied(reason) => return Ok(PeerAsk::Declined { reason }),
            Resolution::Absent => {
                let wait = self.0.deps.config.current().collaborate.await_timeout_ms;
                let state = State::Awaiting { target: target.clone(), deadline: self.now() + wait };
                let parent = asker.and_then(|a| a.parent_id);
                let request_id = peers.add(from, None, parent.as_deref(), question, state);
                let note = json!({
                    "requestId": request_id, "toWorker": null, "toName": target.name, "question": question,
                    "awaiting": true,
                });
                self.note_consult(from, note).await?;
                return Ok(PeerAsk::Registered { request_id });
            }
            Resolution::Resolved(peer) => peer,
        };
        // An asker waits mid-turn, so a circle of waits could never be answered.
        if PeerRequests::would_deadlock(&peers.entries(), from, &peer.id) {
            return Ok(PeerAsk::Declined { reason: circular(&peer) });
        }
        // A peer at rest is woken (or one coming up waited for): the request needs a live, idle session.
        self.revive(&peer.id).await?;
        let request_id = peers.add(from, Some(&peer.id), None, question, State::Queued);
        let note = json!({"requestId": request_id, "toWorker": peer.id, "toName": peer.name, "question": question});
        self.note_consult(from, note).await?;
        self.pump_peer(&peer.id).await;
        Ok(PeerAsk::Registered { request_id })
    }

    /// The "consulting <peer>" line on the asker's timeline.
    async fn note_consult(&self, from: &str, note: serde_json::Value) -> Result<(), Error> {
        let (id, now) = (from.to_owned(), self.now());
        self.store()
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&id, now, WorkerEventType::PeerConsult, &note)?;
                out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id, "type": "peer_consult"}));
                Ok(())
            })
            .await
    }

    /// Where a request stands.
    pub fn peer_request(&self, request_id: &str) -> PeerAnswer {
        self.0.peers.poll(request_id)
    }

    /// Waits until a request is answered, declined or gone.
    pub async fn peer_answer(&self, request_id: &str) -> PeerAnswer {
        let peers = &self.0.peers;
        loop {
            let mut settled = pin!(peers.settled.notified());
            // Registered before the check: a request settling in between still wakes this.
            settled.as_mut().enable();
            match peers.poll(request_id) {
                PeerAnswer::Pending => {}
                answer => return answer,
            }
            // A peer that never joins declines the request when its wait is over.
            let mut wait = peers.deadline(request_id).map(|at| self.0.deps.sleeper.sleep((at - self.now()).max(0) + 1));
            poll_fn(|cx| {
                let over = wait.as_mut().is_some_and(|wait| wait.as_mut().poll(cx).is_ready());
                if over || settled.as_mut().poll(cx).is_ready() { Poll::Ready(()) } else { Poll::Pending }
            })
            .await;
        }
    }

    /// The asker stopped waiting: its request is dropped.
    pub fn withdraw_peer_request(&self, request_id: &str) {
        self.0.peers.withdraw(request_id);
    }

    /// `worker_id`'s answer to the request delivered to it this turn; `None`
    /// when no request was waiting on it.
    pub async fn respond_to_peer(&self, worker_id: &str, answer: &str) -> Result<Option<PeerAnswered>, Error> {
        let Some(from) = self.0.peers.settle_delivered(worker_id, State::Answered(answer.to_owned())) else {
            return Ok(None);
        };
        let id = from.clone();
        let asker = self.store().read(move |tx| tx.workers().find(&id)).await?;
        Ok(Some(PeerAnswered { to_worker: from, to_name: asker.and_then(|a| a.name) }))
    }

    /// A collaborating worker was started: the requests that waited for a
    /// peer like it are bound to it and delivered when it goes idle.
    pub(crate) async fn bind_awaiting_peers(&self, parent_id: &str) {
        let peers = &self.0.peers;
        let waiting: Vec<(String, String, PeerRef)> = {
            let mut entries = peers.entries();
            peers.maintain(&mut entries);
            let of_group = entries.iter().filter(|e| e.parent_id.as_deref() == Some(parent_id));
            of_group
                .filter_map(|e| match &e.state {
                    State::Awaiting { target, .. } => Some((e.id.clone(), e.from.clone(), target.clone())),
                    _ => None,
                })
                .collect()
        };
        if waiting.is_empty() {
            return;
        }
        let resolved = self
            .store()
            .read(move |tx| {
                // Bound on registration only: a worker at rest is not woken by someone else's start.
                waiting.into_iter().map(|(id, from, target)| Ok((id, resolve(tx, &from, &target, false)?))).collect()
            })
            .await;
        let resolved: Vec<(String, Resolution)> = match resolved {
            Ok(resolved) => resolved,
            Err(e) => {
                tracing::warn!(parent_id, error = %e, "waiting peer requests could not be bound");
                return;
            }
        };
        let mut bound = Vec::new();
        {
            let mut entries = peers.entries();
            for (id, resolution) in resolved {
                let Some(at) = entries.iter().position(|e| e.id == id && matches!(e.state, State::Awaiting { .. }))
                else {
                    continue;
                };
                match resolution {
                    Resolution::Absent => {}
                    Resolution::Denied(reason) => peers.settle(&mut entries[at], State::Declined(reason)),
                    Resolution::Resolved(peer) => {
                        let from = entries[at].from.clone();
                        if PeerRequests::would_deadlock(&entries, &from, &peer.id) {
                            peers.settle(&mut entries[at], State::Declined(circular(&peer)));
                        } else {
                            entries[at].to = Some(peer.id.clone());
                            entries[at].state = State::Queued;
                            bound.push(peer.id);
                        }
                    }
                }
            }
        }
        for target in bound {
            self.pump_peer(&target).await;
        }
    }

    /// Delivers the oldest request queued for an idle worker and says whether
    /// one went out. A request the worker ended its turn on without
    /// answering is declined first.
    pub(crate) async fn pump_peer(&self, worker_id: &str) -> bool {
        let peers = &self.0.peers;
        if peers.len() == 0 {
            return false;
        }
        // One look at a worker at a time: a second caller that read "idle" beside a delivery
        // would decline the request that just went out.
        if !peers.pumping.claim(worker_id) {
            return true;
        }
        let delivered = self.deliver_next_peer_request(worker_id).await;
        // An idle edge that came by meanwhile is looked at now.
        if peers.pumping.release(worker_id) {
            self.settled(worker_id).await;
        }
        delivered
    }

    async fn deliver_next_peer_request(&self, worker_id: &str) -> bool {
        let peers = &self.0.peers;
        let id = worker_id.to_owned();
        let Ok(Some(row)) = self.store().read(move |tx| tx.workers().find(&id)).await else { return false };
        if row.state != WorkerState::Idle {
            return false;
        }
        peers.settle_delivered(worker_id, State::Declined("peer ended its turn without responding".into()));
        let Some(next) = peers.next_queued_for(worker_id) else { return false };
        if !self.is_live(worker_id) {
            return false;
        }
        peers.mark_delivered(&next.request_id);
        let from = next.from.clone();
        let asker = self.store().read(move |tx| tx.workers().find(&from)).await.ok().flatten();
        let from_name = asker.as_ref().and_then(|a| a.name.clone());
        let body = format!(
            "{}\n\nAnswer this from your area, then call respond_to_peer with your answer — that is the only thing that reaches {}; plain text in this turn does not.",
            next.question,
            from_name.as_deref().unwrap_or(&next.from),
        );
        let message = MessageInput {
            worker_id: worker_id.to_owned(),
            text: body,
            display_text: Some(next.question),
            envelope: Some(Envelope::PeerRequest { from_worker: next.from, from_name }),
            origin: Some("peer-request".into()),
            ..MessageInput::default()
        };
        if let Err(e) = self.dispatch(message).await {
            peers.settle_delivered(worker_id, State::Declined("delivery to peer failed".into()));
            tracing::warn!(worker_id, error = %e, "a peer request could not be delivered");
        }
        true
    }

    /// How many peer requests are remembered.
    pub fn tracked_peer_requests(&self) -> usize {
        self.0.peers.len()
    }
}
