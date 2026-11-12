//! Agent conversations kept parsed, so a drawer that asks again and again
//! for a working agent reads its file again only once it changed. As today's
//! `WorkflowRunService` (a parsed transcript per file, four kept).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::PtyConversationRow;
use eos_core::agent::FileStamp;

/// How many conversations are kept; the least recently read goes first.
pub(crate) const KEPT: usize = 4;

/// `(worker, call)`: the run a conversation belongs to.
type Run = (String, String);

struct Kept {
    run: Run,
    agent_id: String,
    /// The file as it was when these rows were read from it.
    stamp: FileStamp,
    rows: Arc<[PtyConversationRow]>,
}

/// At most [`KEPT`] conversations; a run's go when it ends.
#[derive(Default)]
pub(crate) struct AgentRows(Mutex<VecDeque<Kept>>);

impl AgentRows {
    fn kept(&self) -> MutexGuard<'_, VecDeque<Kept>> {
        // Each step leaves a valid list behind: a panic elsewhere cannot spoil it.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The rows read from the file as it still is.
    pub(crate) fn get(&self, run: &Run, agent_id: &str, stamp: &FileStamp) -> Option<Vec<PtyConversationRow>> {
        let mut kept = self.kept();
        let at = kept.iter().position(|k| k.run == *run && k.agent_id == agent_id && k.stamp == *stamp)?;
        let hit = kept.remove(at)?;
        let rows = hit.rows.to_vec();
        kept.push_back(hit);
        Some(rows)
    }

    pub(crate) fn put(&self, run: Run, agent_id: &str, stamp: FileStamp, rows: &[PtyConversationRow]) {
        let mut kept = self.kept();
        kept.retain(|k| !(k.run == run && k.agent_id == agent_id));
        if kept.len() == KEPT {
            kept.pop_front();
        }
        kept.push_back(Kept { run, agent_id: agent_id.to_owned(), stamp, rows: rows.into() });
    }

    /// The run ended: its conversations are read from their files from now on.
    pub(crate) fn forget_run(&self, run: &Run) {
        self.kept().retain(|k| k.run != *run);
    }

    pub(crate) fn len(&self) -> usize {
        self.kept().len()
    }
}
