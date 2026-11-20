//! Credit: what happened after notes reached a model moves their counters
//! and their state (G23). Recall alone counts nothing. A note is *used* when
//! the agent acts on it; a good outcome of the conversation (a quiet
//! acceptance, a 👍, a kept Try) gives `helped` once to every note recalled
//! in it; `hurt` goes only to notes the reflector names as contradicted and
//! to the note the user marks "Not right". A conversation that ends in a
//! surprise (a correction, a stop, an undo) gives nothing, and the notes the
//! agent acted on before it are shown to the reflector again ([`reopened_in`]).
//!
//! Counters are this Mac's (`mem_credit`); the note keeps their sums over
//! every Mac and the state they lead to. Each change is one write job and
//! announces `memory:change` with `counts` after commit.

use std::collections::BTreeSet;
use std::sync::Arc;

use eos_contracts::ExperienceChange;
use eos_core::store::{Outbox, Store, StoredNote, Tx};
use eos_core::{Clock, Error};
use eos_domain::experience::NoteState;
use eos_domain::experience::moments::Signal;
use eos_domain::experience::state::{self, ACTIVATION_USES};

use crate::merge::MEMORY_CHANGE;

/// A use's outcome after a good end of the conversation.
pub const HELPED: &str = "helped";
/// A use's outcome after the conversation ended in a surprise.
pub const SURPRISED: &str = "surprised";

/// How a look at a conversation ended for the notes recalled in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatOutcome {
    Good,
    Surprised,
}

/// The signals that say the agent did not do what the user wanted.
pub fn surprises(signal: Signal) -> bool {
    matches!(
        signal,
        Signal::SaysWrong
            | Signal::Stops
            | Signal::Undoes
            | Signal::Denies
            | Signal::ThumbsDown
            | Signal::Edits
            | Signal::Repeats
            | Signal::CheckerDisagrees
    )
}

/// Moves the counters of notes, on this Mac.
pub struct Credit {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    device: String,
}

impl std::fmt::Debug for Credit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credit").finish_non_exhaustive()
    }
}

impl Credit {
    pub fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>, device: String) -> Self {
        Self { store, clock, device }
    }

    /// The agent acted on `note_ids` in the worker's epoch: each one's first
    /// use there not yet acted on is marked, and counts as used once.
    pub async fn acted(&self, worker_id: &str, epoch: i64, note_ids: Vec<String>) -> Result<(), Error> {
        let (worker_id, device, now) = (worker_id.to_owned(), self.device.clone(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                let uses = tx.mem_uses().of_worker(&worker_id, epoch)?;
                let mut moved = Vec::new();
                for note_id in note_ids {
                    let Some(open) = uses.iter().find(|u| u.note_id == note_id && !u.acted) else { continue };
                    tx.mem_uses().set_acted(&open.id)?;
                    tx.mem_credit().add(&note_id, &device, 0, 0, 1, Some(now))?;
                    restand_in(tx, &note_id, now)?;
                    moved.push(note_id);
                }
                announce(out, moved);
                Ok(())
            })
            .await
    }

    /// Settles the open uses of a worker's conversation: a good outcome gives
    /// `helped` once to each note among them. Answers how many notes it helped.
    pub async fn chat_ended(&self, worker_id: &str, outcome: ChatOutcome) -> Result<usize, Error> {
        let (worker_id, device, now) = (worker_id.to_owned(), self.device.clone(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                let open: BTreeSet<String> = tx
                    .mem_uses()
                    .of_worker(&worker_id, 0)?
                    .into_iter()
                    .filter(|u| u.outcome.is_none())
                    .map(|u| u.note_id)
                    .collect();
                let word = if outcome == ChatOutcome::Good { HELPED } else { SURPRISED };
                tx.mem_uses().settle(Some(&worker_id), None, word)?;
                if outcome == ChatOutcome::Surprised {
                    return Ok(0);
                }
                let helped: Vec<String> = open.into_iter().collect();
                for note_id in &helped {
                    tx.mem_credit().add(note_id, &device, 1, 0, 0, None)?;
                    restand_in(tx, note_id, now)?;
                }
                let count = helped.len();
                announce(out, helped);
                Ok(count)
            })
            .await
    }

    /// A run ended as `kind`: a delivered run's pack notes count as used
    /// once each, and a run sent as it was (or sent by itself) helps each of
    /// them once. Answers how many notes it helped.
    pub async fn run_ended(&self, run_id: &str, kind: &str) -> Result<usize, Error> {
        let delivered = matches!(kind, "sent_unedited" | "sent_edited" | "auto_sent");
        let good = matches!(kind, "sent_unedited" | "auto_sent");
        let (run_id, kind, device, now) =
            (run_id.to_owned(), kind.to_owned(), self.device.clone(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                let open: Vec<_> = tx.mem_uses().of_run(&run_id)?.into_iter().filter(|u| u.outcome.is_none()).collect();
                let mut notes = BTreeSet::new();
                for used in &open {
                    if notes.insert(used.note_id.clone()) && delivered {
                        tx.mem_uses().set_acted(&used.id)?;
                    }
                }
                tx.mem_uses().settle(None, Some(&run_id), if good { HELPED } else { &kind })?;
                let notes: Vec<String> = notes.into_iter().collect();
                for note_id in &notes {
                    let (helped, used) = (i64::from(good), i64::from(delivered));
                    if helped + used > 0 {
                        tx.mem_credit().add(note_id, &device, helped, 0, used, delivered.then_some(now))?;
                        restand_in(tx, note_id, now)?;
                    }
                }
                let count = if good { notes.len() } else { 0 };
                if delivered {
                    announce(out, notes);
                }
                Ok(count)
            })
            .await
    }

    /// The user says a note is not right: it is hurt once. Answers the
    /// state it is in after, `None` when there is no such note.
    pub async fn not_right(&self, note_id: &str) -> Result<Option<NoteState>, Error> {
        let (note_id, device, now) = (note_id.to_owned(), self.device.clone(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                if tx.mem_notes().find(&note_id)?.is_none_or(|n| n.forgotten_at.is_some()) {
                    return Ok(None);
                }
                let state = hurt_in(tx, std::slice::from_ref(&note_id), &device, now)?;
                announce(out, vec![note_id]);
                Ok(state.into_iter().next())
            })
            .await
    }
}

/// Hurts each note of `note_ids` once on `device`, inside the caller's write
/// job; answers their states after (notes that exist only).
pub fn hurt_in(tx: &dyn Tx, note_ids: &[String], device: &str, now: i64) -> Result<Vec<NoteState>, Error> {
    let mut states = Vec::new();
    for note_id in note_ids {
        if tx.mem_notes().find(note_id)?.is_none() {
            continue;
        }
        tx.mem_credit().add(note_id, device, 0, 1, 0, None)?;
        states.extend(restand_in(tx, note_id, now)?);
    }
    Ok(states)
}

/// Sums a note's counters again and stores them with its activation and the
/// state they lead to. Answers that state, `None` when there is no note.
pub fn restand_in(tx: &dyn Tx, note_id: &str, now: i64) -> Result<Option<NoteState>, Error> {
    let Some(stored) = tx.mem_notes().find(note_id)? else { return Ok(None) };
    let counters = tx.mem_credit().sum(note_id)?;
    let times = tx.mem_uses().times_of_note(note_id, ACTIVATION_USES as i64)?;
    let activation = state::activation(&times, now);
    let next = state::next(stored.note.state, stored.note.trust, counters, stored.note.created_at, now);
    tx.mem_notes().set_standing(note_id, counters, activation, next)?;
    Ok(Some(next))
}

/// The notes the agent acted on in a worker's conversation before a
/// surprise at or before `until`: the reflector sees them again, to say
/// whether the surprise contradicts them.
pub fn reopened_in(tx: &dyn Tx, worker_id: &str, until: i64) -> Result<Vec<StoredNote>, Error> {
    let ids: BTreeSet<String> = tx
        .mem_uses()
        .of_worker(worker_id, 0)?
        .into_iter()
        .filter(|u| u.acted && u.at <= until && u.outcome.as_deref() == Some(SURPRISED))
        .map(|u| u.note_id)
        .collect();
    let mut notes = Vec::new();
    for id in ids {
        if let Some(note) = tx.mem_notes().find(&id)?
            && note.forgotten_at.is_none()
            && note.note.state != NoteState::Closed
        {
            notes.push(note);
        }
    }
    Ok(notes)
}

fn announce(out: &mut Outbox, ids: Vec<String>) {
    if !ids.is_empty() {
        out.push(MEMORY_CHANGE, &ExperienceChange { ids, action: "counts".into() });
    }
}
