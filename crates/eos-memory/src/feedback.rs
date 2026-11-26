//! What routines' runs give memory and take from it: the pack a run's lead
//! reads with its brief (recorded for credit unless the run is a trial),
//! how the run ended, and a routine removed for good (its notes close).

use std::sync::Arc;

use eos_contracts::ExperienceChange;
use eos_core::experience::{RunPack, RunPackRequest};
use eos_core::store::{NoteQuery, Store};
use eos_core::{Clock, Error, Ids};
use eos_domain::experience::{NoteKind, NoteState, ScopeLevel};

use crate::credit::Credit;
use crate::deliver::{How, Receiver, record};
use crate::merge::{MEMORY_CHANGE, version};
use crate::pack::run_pack;
use crate::playbook;
use crate::recall::{Cues, Recall, Recalled, Situation};
use crate::settings;

/// Notes recalled for a run before its pack is cut.
const RECALL_LIMIT: usize = 24;
/// Notes of a removed routine closed in one page.
const CLOSE_PAGE: i64 = 500;

pub struct Feedback {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    recall: Arc<Recall>,
    credit: Arc<Credit>,
    device: String,
}

impl std::fmt::Debug for Feedback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Feedback").finish_non_exhaustive()
    }
}

impl Feedback {
    pub fn new(
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        recall: Arc<Recall>,
        credit: Arc<Credit>,
        device: String,
    ) -> Self {
        Self { store, clock, ids, recall, credit, device }
    }

    /// The run's pack; empty while the Reminders switch is off or when
    /// nothing applies.
    pub async fn for_run(&self, request: RunPackRequest) -> Result<RunPack, Error> {
        let on = self.store.read(|tx| Ok(settings::read_in(tx)?.reminders)).await?;
        if !on {
            return Ok(RunPack::default());
        }
        let situation =
            Situation { routine: Some(request.routine_id.clone()), project: request.project.clone(), work_kind: None };
        let query = Some(request.item_text.clone()).filter(|t| !t.trim().is_empty());
        let cues = Cues { hooks: request.item_cues.clone(), query };
        let mut recalled = self.recall.recall(&situation, &cues, RECALL_LIMIT).await?;
        // The routine's playbook (or the candidate a replay checks) comes
        // first, whatever was recalled.
        let (routine, candidate, now) =
            (request.routine_id.clone(), request.playbook_candidate.clone(), self.clock.now_ms());
        let playbook =
            self.store.read(move |tx| playbook::for_pack_in(tx, &routine, candidate.as_deref(), now)).await?;
        recalled.retain(|r| r.note.note.kind != NoteKind::Playbook);
        if let Some(note) = playbook {
            recalled.insert(0, Recalled { note, score: 1.0 });
        }
        let Some(pack) = run_pack(&recalled, &request.routine_id) else { return Ok(RunPack::default()) };
        if !request.trial {
            let to = Receiver { worker_id: None, run_id: Some(request.run_id.clone()), epoch: 0 };
            record(&self.store, self.clock.as_ref(), self.ids.as_ref(), &to, How::Pack, &pack.note_ids).await?;
        }
        tracing::info!(run_id = %request.run_id, notes = pack.note_ids.len(), tokens = pack.tokens, "memory: run pack");
        Ok(pack)
    }

    /// Credits the run's pack notes by how it ended.
    pub async fn run_ended(&self, run_id: &str, kind: &str) -> Result<(), Error> {
        self.credit.run_ended(run_id, kind).await.map(drop)
    }

    /// Closes every note of a routine removed for good. Answers how many.
    pub async fn routine_removed(&self, routine_id: &str) -> Result<usize, Error> {
        let mut closed = 0;
        loop {
            let (routine_id, device, now) = (routine_id.to_owned(), self.device.clone(), self.clock.now_ms());
            let page = self
                .store
                .write(move |tx, out| {
                    let notes = tx.mem_notes().list(&NoteQuery {
                        scope: Some((ScopeLevel::Routine, Some(routine_id))),
                        limit: CLOSE_PAGE,
                        ..NoteQuery::default()
                    })?;
                    let mut ids = Vec::new();
                    for stored in notes.iter().filter(|n| n.note.state != NoteState::Closed) {
                        let mut note = stored.note.clone();
                        note.state = NoteState::Closed;
                        note.updated_at = now.max(note.updated_at);
                        note.device = device.clone();
                        tx.mem_notes().update(&note, &stored.cues, stored.rev + 1)?;
                        tx.mem_versions().insert(&version(&note, stored.rev + 1, "closed", now))?;
                        ids.push(note.id);
                    }
                    let count = ids.len();
                    if !ids.is_empty() {
                        out.push(MEMORY_CHANGE, &ExperienceChange { ids, action: "changed".into() });
                    }
                    Ok(count)
                })
                .await?;
            closed += page;
            if page == 0 {
                break;
            }
        }
        tracing::info!(routine_id, notes = closed, "memory: notes of a removed routine closed");
        Ok(closed)
    }
}
