//! Notes put in front of a model: the reminder that holds them, and the
//! record of each (`mem_uses`), announced on `memory:recalled` after the
//! record commits.

use std::collections::HashSet;
use std::sync::Arc;

use eos_contracts::ExperienceRecalledEvent;
use eos_core::store::{Store, StoredUse};
use eos_core::{Clock, Error, Ids};
use eos_domain::experience::budget::{REMINDER_NOTE_TOKENS, REMINDER_NOTES_PER_MOMENT};
use eos_domain::experience::rank::reminder_threshold;
use eos_domain::experience::render::{Rendered, note_block};
use eos_domain::text::estimate_tokens;

use crate::pack::Pack;
use crate::recall::Recalled;

pub const MEMORY_RECALLED: &str = "memory:recalled";

/// How a note reached the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    Pack,
    Reminder,
    Tool,
}

impl How {
    pub fn as_str(self) -> &'static str {
        match self {
            How::Pack => "pack",
            How::Reminder => "reminder",
            How::Tool => "tool",
        }
    }
}

/// A reminder under `header` from `recalled` (best first): notes past their
/// bar, short enough, not `delivered` yet in this epoch, at most `room`
/// (and never more than a moment's three). `None` when none qualifies.
pub fn reminder(header: &str, recalled: &[Recalled], delivered: &HashSet<String>, room: usize) -> Option<Pack> {
    let kept: Vec<&Recalled> = recalled
        .iter()
        .filter(|r| r.score >= reminder_threshold(r.note.note.state))
        .filter(|r| !delivered.contains(&r.note.note.id))
        .filter(|r| estimate_tokens(&r.note.note.text) <= REMINDER_NOTE_TOKENS)
        .take(room.min(REMINDER_NOTES_PER_MOMENT))
        .collect();
    if kept.is_empty() {
        return None;
    }
    let rendered: Vec<Rendered<'_>> = kept
        .iter()
        .map(|r| Rendered {
            id: &r.note.note.id,
            text: &r.note.note.text,
            state: r.note.note.state,
            trust: r.note.note.trust,
        })
        .collect();
    let text = note_block(header, &rendered);
    let tokens = estimate_tokens(&text);
    Some(Pack { text, note_ids: kept.iter().map(|r| r.note.note.id.clone()).collect(), tokens })
}

/// Who received notes, and in which epoch of their conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receiver {
    /// None for a run's pack, given before its lead starts.
    pub worker_id: Option<String>,
    pub run_id: Option<String>,
    /// When the epoch began (epoch ms).
    pub epoch: i64,
}

/// Records that `note_ids` reached `to` and announces it.
pub async fn record(
    store: &Arc<dyn Store>,
    clock: &dyn Clock,
    ids: &dyn Ids,
    to: &Receiver,
    how: How,
    note_ids: &[String],
) -> Result<(), Error> {
    let at = clock.now_ms();
    let uses: Vec<StoredUse> = note_ids
        .iter()
        .map(|note_id| StoredUse {
            id: ids.memory_row_id(),
            note_id: note_id.clone(),
            worker_id: to.worker_id.clone(),
            run_id: to.run_id.clone(),
            how: how.as_str().to_owned(),
            epoch: to.epoch,
            at,
            acted: false,
            outcome: None,
        })
        .collect();
    let event = ExperienceRecalledEvent {
        worker_id: to.worker_id.clone(),
        run_id: to.run_id.clone(),
        note_ids: note_ids.to_vec(),
        how: how.as_str().to_owned(),
    };
    store
        .write(move |tx, out| {
            for used in &uses {
                tx.mem_uses().insert(used)?;
            }
            out.push(MEMORY_RECALLED, &event);
            Ok(())
        })
        .await
}
