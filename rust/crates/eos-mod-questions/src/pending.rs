//! The questions waiting for the user (`manager/services/PendingQuestionService.ts`).
//!
//! In memory on purpose: a question lives as long as the agent's tool call
//! that asked it, and no longer than the app. An open question has no time
//! limit; one that was answered or dismissed stays readable for a short
//! while, then is forgotten.

use std::collections::HashMap;

use eos_contracts::{QuestionPollResponse, QuestionPollResponseStatus};
use indexmap::IndexMap;
use tokio::sync::oneshot;

/// How long an answered or dismissed question stays readable.
pub(crate) const TERMINAL_GRACE_MS: i64 = 5 * 60 * 1000;

pub(crate) type Answers = IndexMap<String, String>;

/// What the asker's wait ends with: the answers, or `None` for a dismissal.
pub(crate) type Waiter = oneshot::Sender<Option<Answers>>;

#[derive(Debug)]
enum State {
    Pending,
    Answered(Answers),
    Dismissed,
}

#[derive(Debug)]
struct Entry {
    worker_id: String,
    tool_use_id: String,
    state: State,
    settled_at: Option<i64>,
    /// The asker inside the app, when there is one.
    waiter: Option<Waiter>,
}

#[derive(Debug, Default)]
pub(crate) struct Pending {
    entries: HashMap<String, Entry>,
}

impl Pending {
    fn sweep(&mut self, now: i64) {
        let cutoff = now - TERMINAL_GRACE_MS;
        self.entries.retain(|_, entry| entry.settled_at.is_none_or(|at| at >= cutoff));
    }

    fn find(&self, worker_id: &str, tool_use_id: &str) -> Option<&String> {
        self.entries
            .iter()
            .find(|(_, entry)| entry.worker_id == worker_id && entry.tool_use_id == tool_use_id)
            .map(|(id, _)| id)
    }

    /// Opens a question. Asking again under the same tool call replaces the
    /// earlier one (its asker, if any, hears nothing more); another tool
    /// call's question stays beside it.
    pub(crate) fn register(
        &mut self,
        question_id: String,
        worker_id: &str,
        tool_use_id: &str,
        waiter: Option<Waiter>,
        now: i64,
    ) {
        self.sweep(now);
        if let Some(prior) = self.find(worker_id, tool_use_id).cloned() {
            self.entries.remove(&prior);
        }
        let entry = Entry {
            worker_id: worker_id.to_owned(),
            tool_use_id: tool_use_id.to_owned(),
            state: State::Pending,
            settled_at: None,
            waiter,
        };
        self.entries.insert(question_id, entry);
    }

    /// `gone`: never asked, forgotten, or its worker was removed.
    pub(crate) fn poll(&mut self, question_id: &str, now: i64) -> QuestionPollResponse {
        self.sweep(now);
        let (status, answers) = match self.entries.get(question_id).map(|entry| &entry.state) {
            Some(State::Pending) => (QuestionPollResponseStatus::Pending, None),
            Some(State::Answered(answers)) => (QuestionPollResponseStatus::Answered, Some(answers.clone())),
            Some(State::Dismissed) => (QuestionPollResponseStatus::Dismissed, None),
            None => (QuestionPollResponseStatus::Gone, None),
        };
        QuestionPollResponse { status, answers }
    }

    /// Answers (`Some`) or dismisses (`None`) the open question of that tool
    /// call. False when there is none: the first answer wins.
    pub(crate) fn settle(&mut self, worker_id: &str, tool_use_id: &str, answers: Option<Answers>, now: i64) -> bool {
        let Some(id) = self.find(worker_id, tool_use_id).cloned() else { return false };
        let Some(entry) = self.entries.get_mut(&id).filter(|entry| entry.settled_at.is_none()) else { return false };
        if let Some(waiter) = entry.waiter.take() {
            // An asker that left has its question withdrawn by its own guard.
            let _ = waiter.send(answers.clone());
        }
        entry.state = answers.map_or(State::Dismissed, State::Answered);
        entry.settled_at = Some(now);
        true
    }

    pub(crate) fn has_open(&self, worker_id: &str) -> bool {
        self.entries.values().any(|entry| entry.worker_id == worker_id && entry.settled_at.is_none())
    }

    /// Forgets a removed worker's questions; their askers hear nothing more.
    pub(crate) fn cancel_worker(&mut self, worker_id: &str) {
        self.entries.retain(|_, entry| entry.worker_id != worker_id);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers(text: &str) -> Answers {
        Answers::from([("Q?".to_owned(), text.to_owned())])
    }

    // manager/services/__tests__/PendingQuestionService.test.ts
    #[test]
    fn a_question_waits_until_it_is_answered_and_the_first_answer_wins() {
        let mut pending = Pending::default();
        pending.register("p-1".into(), "o-1", "call-1", None, 0);
        // No time limit on an open question.
        assert_eq!(pending.poll("p-1", 10 * 24 * 3_600_000).status, QuestionPollResponseStatus::Pending);
        assert!(pending.has_open("o-1"));
        assert!(pending.settle("o-1", "call-1", Some(answers("yes")), 100));
        assert!(!pending.settle("o-1", "call-1", None, 101), "already settled");
        let state = pending.poll("p-1", 102);
        assert_eq!((state.status, state.answers), (QuestionPollResponseStatus::Answered, Some(answers("yes"))));
        assert!(!pending.has_open("o-1"));
    }

    #[test]
    fn a_settled_question_is_forgotten_after_the_grace_window() {
        let mut pending = Pending::default();
        pending.register("p-1".into(), "o-1", "call-1", None, 0);
        assert!(pending.settle("o-1", "call-1", None, 1_000));
        assert_eq!(pending.poll("p-1", 1_000 + TERMINAL_GRACE_MS).status, QuestionPollResponseStatus::Dismissed);
        assert_eq!(pending.poll("p-1", 1_001 + TERMINAL_GRACE_MS).status, QuestionPollResponseStatus::Gone);
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn asking_again_under_the_same_tool_call_replaces_the_question() {
        let mut pending = Pending::default();
        let (first, mut heard) = oneshot::channel();
        pending.register("p-1".into(), "o-1", "call-1", Some(first), 0);
        pending.register("p-2".into(), "o-1", "call-2", None, 0);
        pending.register("p-3".into(), "o-1", "call-1", None, 0);
        assert_eq!(pending.poll("p-1", 0).status, QuestionPollResponseStatus::Gone);
        assert!(heard.try_recv().is_err(), "the replaced asker hears nothing");
        assert_eq!(pending.poll("p-2", 0).status, QuestionPollResponseStatus::Pending, "another call's stays");
        assert!(pending.settle("o-1", "call-1", Some(answers("x")), 1));
        assert_eq!(pending.poll("p-3", 1).status, QuestionPollResponseStatus::Answered);
        assert!(!pending.settle("o-2", "call-2", None, 1), "another worker's tool call");
    }

    #[test]
    fn a_removed_workers_questions_are_gone() {
        let mut pending = Pending::default();
        let (asker, heard) = oneshot::channel();
        pending.register("p-1".into(), "o-1", "call-1", Some(asker), 0);
        pending.register("p-2".into(), "o-2", "call-1", None, 0);
        pending.cancel_worker("o-1");
        assert_eq!(pending.poll("p-1", 0).status, QuestionPollResponseStatus::Gone);
        assert!(heard.blocking_recv().is_err());
        assert!(pending.has_open("o-2") && !pending.has_open("o-1"));
    }

    #[test]
    fn an_asker_inside_the_app_hears_the_answer() {
        let mut pending = Pending::default();
        let (asker, heard) = oneshot::channel();
        pending.register("p-1".into(), "o-1", "call-1", Some(asker), 0);
        assert!(pending.settle("o-1", "call-1", Some(answers("yes")), 1));
        assert_eq!(heard.blocking_recv().expect("heard"), Some(answers("yes")));
    }
}
