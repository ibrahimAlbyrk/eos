//! The words of a summary, from the prompt library: the request appended to
//! the conversation (`compaction/summarize`) and the message the conversation
//! goes on from (`compaction/continuation`).

use std::sync::Arc;

use eos_core::agent::CompactionWords;
use eos_domain::compaction::SUMMARY_OPEN;
use eos_prompts::PromptService;
use eos_prompts::templates::compaction as prompts;

/// Used when a template of the library does not render (a broken override in
/// `~/.eos/prompts`): the summary must still be asked for and kept.
const FALLBACK_INSTRUCTION: &str = "Respond with text only, no tools. Summarize the conversation so far in \
     detail, inside <summary></summary>: the user's requests, the work done, the files touched, errors and \
     fixes, pending tasks, and exactly where the work stands now.";

pub struct Words {
    prompts: Arc<PromptService>,
}

impl std::fmt::Debug for Words {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Words").finish_non_exhaustive()
    }
}

impl Words {
    pub fn new(prompts: Arc<PromptService>) -> Self {
        Self { prompts }
    }
}

impl CompactionWords for Words {
    fn instruction(&self, focus: Option<&str>) -> String {
        prompts::summarize(&self.prompts, focus).unwrap_or_else(|e| {
            tracing::error!(error = %e, "the compaction request did not render; a plain one is used");
            match focus {
                Some(focus) => format!("{FALLBACK_INSTRUCTION}\n\nAdditional instructions from the user:\n{focus}"),
                None => FALLBACK_INSTRUCTION.to_owned(),
            }
        })
    }

    fn seed(&self, summary: &str, transcript_archive: &str) -> String {
        prompts::continuation(&self.prompts, summary, transcript_archive).unwrap_or_else(|e| {
            tracing::error!(error = %e, "the compaction seed did not render; a plain one is used");
            format!(
                "This conversation was compacted; continue the work from where it left off.\n\n{SUMMARY_OPEN}\n\
                 {summary}\n</compaction_summary>"
            )
        })
    }
}
