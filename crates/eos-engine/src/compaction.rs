//! A session summarizing its own conversation, as Claude Code does: when its
//! context reaches the threshold (before the next request, mid-turn too) or
//! on `/compact`, the engine asks the model for a summary with the
//! conversation's own cache, replaces the conversation with it, and the turn
//! goes on. The words come from Eos's prompt library.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use eos_agent_core::CompactionText;
use eos_core::agent::CompactionWords;
use eos_domain::compaction::extract_summary;

/// The last summary a session's conversation was replaced with, for the
/// dashboard's card: the engine hands the words only the model's whole answer.
#[derive(Debug, Default)]
pub(crate) struct LastSummary(Mutex<Option<String>>);

impl LastSummary {
    pub(crate) fn put(&self, summary: String) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(summary);
    }

    pub(crate) fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

/// One session's [`CompactionText`].
pub(crate) struct Words {
    words: Arc<dyn CompactionWords>,
    /// Where the conversation before each summary is kept (a glob).
    archive: String,
    last: Arc<LastSummary>,
}

impl std::fmt::Debug for Words {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Words").field("archive", &self.archive).finish_non_exhaustive()
    }
}

impl Words {
    /// `record` is the session's recorded conversation: each summary moves it
    /// aside as `<name>.<time>.jsonl`, next to it.
    pub(crate) fn new(words: Arc<dyn CompactionWords>, record: &Path, last: Arc<LastSummary>) -> Self {
        let archive = record.with_extension("*.jsonl").to_string_lossy().into_owned();
        Self { words, archive, last }
    }
}

impl CompactionText for Words {
    fn instruction(&self, focus: Option<&str>) -> String {
        self.words.instruction(focus)
    }

    fn seed(&self, reply: &str) -> String {
        let summary = extract_summary(reply);
        let seed = self.words.seed(&summary, &self.archive);
        self.last.put(summary);
        seed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Plain;

    impl CompactionWords for Plain {
        fn instruction(&self, focus: Option<&str>) -> String {
            format!("summarize{}", focus.map(|f| format!(" ({f})")).unwrap_or_default())
        }

        fn seed(&self, summary: &str, archive: &str) -> String {
            format!("{summary} | {archive}")
        }
    }

    #[test]
    fn seeds_from_the_summary_block_and_keeps_it_for_the_card() {
        let last = Arc::new(LastSummary::default());
        let words = Words::new(Arc::new(Plain), Path::new("/e/transcripts/w-1.jsonl"), last.clone());
        assert_eq!(words.instruction(Some("the plan")), "summarize (the plan)");
        let seed = words.seed("<analysis>x</analysis>\n<summary>\n1. Task\n</summary>");
        assert_eq!(seed, "1. Task | /e/transcripts/w-1.*.jsonl");
        assert_eq!(last.take().as_deref(), Some("1. Task"));
        assert_eq!(last.take(), None);
    }
}
