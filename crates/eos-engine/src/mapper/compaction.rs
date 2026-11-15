//! The session summarizing its conversation: the engine's `Compacting` …
//! `Compacted` become [`CompactionNotice`]s. What the summary request
//! streams is no part of the conversation; only its usage is billed.

use std::sync::Arc;

use eos_agent_core::StoredMessage;
use eos_agent_types::{ContentBlock, Role};
use eos_contracts::CompactionTrigger;
use eos_core::agent::CompactionNotice;
use eos_domain::compaction::estimate_tokens;

use crate::compaction::LastSummary;
use crate::transcript;

/// What a `/compact` with nothing to summarize reports.
const NOTHING_YET: &str = "nothing to compact yet";

/// A summary on its way.
struct Open {
    trigger: CompactionTrigger,
    before_tokens: i64,
    instructions: Option<String>,
    started_ms: i64,
    /// The size of the message the conversation now opens with, once written.
    seed_tokens: i64,
}

pub(super) struct Compactions {
    /// A `/compact` on its way, with what the user typed after it.
    asked: Option<Option<String>>,
    open: Option<Open>,
    /// The user's prompts since the conversation last started from a summary.
    prompts: i64,
    last: Arc<LastSummary>,
    notices: Vec<CompactionNotice>,
}

impl Compactions {
    pub(super) fn new(prompts: i64, last: Arc<LastSummary>) -> Self {
        Self { asked: None, open: None, prompts, last, notices: Vec::new() }
    }

    /// A summary is being written: what streams now is not the conversation.
    pub(super) fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// The one being written was asked for with `/compact`: it runs in no turn.
    pub(super) fn is_asked(&self) -> bool {
        self.open.as_ref().is_some_and(|o| o.trigger == CompactionTrigger::Manual)
    }

    /// `/compact` was sent to the engine.
    pub(super) fn ask(&mut self, instructions: Option<String>) {
        self.asked = Some(instructions);
    }

    pub(super) fn started(&mut self, before_tokens: u64, now_ms: i64) {
        self.fail("a new summary started before this one finished");
        let (trigger, instructions) = match self.asked.take() {
            Some(instructions) => (CompactionTrigger::Manual, instructions),
            None => (CompactionTrigger::Auto, None),
        };
        let before_tokens = i64::try_from(before_tokens).unwrap_or(i64::MAX);
        self.notices.push(CompactionNotice::Started { trigger, before_tokens, instructions: instructions.clone() });
        self.open = Some(Open { trigger, before_tokens, instructions, started_ms: now_ms, seed_tokens: 0 });
    }

    /// A message of the conversation: the summary's seed while one is open,
    /// else perhaps one of the user's prompts.
    pub(super) fn message(&mut self, message: &StoredMessage) {
        match &mut self.open {
            Some(open) if message.role() == Role::User => open.seed_tokens = estimate_tokens(&text_of(message)),
            Some(_) => {}
            None if transcript::is_prompt(message) => self.prompts += 1,
            None => {}
        }
    }

    pub(super) fn completed(&mut self, now_ms: i64) {
        let Some(open) = self.open.take() else { return };
        self.notices.push(CompactionNotice::Completed {
            trigger: open.trigger,
            before_tokens: open.before_tokens,
            after_tokens: open.seed_tokens,
            turns: std::mem::take(&mut self.prompts),
            summary: self.last.take().unwrap_or_default(),
            instructions: open.instructions,
            duration_ms: (now_ms - open.started_ms).max(0),
        });
    }

    /// The summary did not replace the conversation (the turn or the
    /// `/compact` running it failed or was stopped).
    pub(super) fn fail(&mut self, error: &str) {
        if let Some(open) = self.open.take() {
            self.notices.push(CompactionNotice::Failed { trigger: open.trigger, error: error.to_owned() });
        }
    }

    /// A `/compact` returned: `Ok(true)` it summarized, `Ok(false)` it was
    /// stopped or had nothing to summarize.
    pub(super) fn asked_done(&mut self, outcome: Result<bool, String>) {
        self.asked = None;
        let error = match outcome {
            Ok(true) => return,
            Ok(false) if self.is_open() => "stopped".to_owned(),
            Ok(false) => NOTHING_YET.to_owned(),
            Err(error) => error,
        };
        if self.is_open() {
            self.fail(&error);
        } else {
            self.notices.push(CompactionNotice::Failed { trigger: CompactionTrigger::Manual, error });
        }
    }

    pub(super) fn take_notices(&mut self) -> Vec<CompactionNotice> {
        std::mem::take(&mut self.notices)
    }
}

fn text_of(message: &StoredMessage) -> String {
    let Ok(blocks) = message.blocks() else { return String::new() };
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
