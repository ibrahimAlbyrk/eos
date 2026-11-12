//! A worker's report to the session that spawned it
//! (`POST /workers/:id/report`, `manager/routes/report-hold.ts`,
//! `core/src/domain/report-signal.ts`).

use eos_contracts::WorkerState;
use eos_contracts::stream::topics::{LOOP_CHANGE, WORKER_REPORT};
use eos_core::Error;
use eos_domain::envelope::Envelope;
use serde_json::json;

use crate::dispatch::MessageInput;
use crate::service::Sessions;

/// What a report's first line says it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportSignal {
    Result,
    NeedsInput,
    Failed,
    Unknown,
}

/// Reads `result:`, `needs input:` or `failed:` at the start of the first
/// line, whatever the case and the spacing.
pub fn classify_report(text: &str) -> ReportSignal {
    let first = text.split('\n').next().unwrap_or_default().trim_end_matches('\r').trim_start().to_lowercase();
    let opens = |words: &[&str]| {
        let mut rest = first.as_str();
        for (at, word) in words.iter().enumerate() {
            let Some(after) = rest.strip_prefix(word) else { return false };
            // Words are apart by at least one space.
            if at + 1 < words.len() && !after.starts_with(char::is_whitespace) {
                return false;
            }
            rest = after.trim_start();
        }
        rest.starts_with(':')
    };
    if opens(&["needs", "input"]) {
        ReportSignal::NeedsInput
    } else if opens(&["result"]) {
        ReportSignal::Result
    } else if opens(&["failed"]) {
        ReportSignal::Failed
    } else {
        ReportSignal::Unknown
    }
}

/// Whether a looped worker's report waits for its goal check: a question for
/// the user always goes through, a failure only waits when failures are retried.
pub fn holds_report(signal: ReportSignal, retry_on_failed: bool) -> bool {
    match signal {
        ReportSignal::NeedsInput => false,
        ReportSignal::Result | ReportSignal::Unknown => true,
        ReportSignal::Failed => retry_on_failed,
    }
}

/// What became of a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    /// The parent got it (as a turn, or in its queue).
    pub delivered: bool,
    /// It waits for the worker's goal check.
    pub held: bool,
}

impl Sessions {
    /// Hands a worker's report to its parent: a turn of the parent, queued
    /// while it is busy. A parent whose session is over is continued first.
    /// Fails when the worker does not exist (`NotFound`) or has no parent
    /// (`Validation`).
    pub async fn report(&self, worker_id: &str, text: &str) -> Result<Reported, Error> {
        let retry_on_failed = self.0.deps.config.current().r#loop.retry_on_failed;
        let (id, body, now) = (worker_id.to_owned(), text.to_owned(), self.now());
        let (worker, parent, held) = self
            .store()
            .write(move |tx, out| {
                let worker = tx.workers().find(&id)?.ok_or_else(|| Error::not_found("worker", &id))?;
                let Some(parent_id) = worker.parent_id.clone() else {
                    return Err(Error::Validation("worker has no parent".into()));
                };
                // A looped worker's final report is held until its goal check passes.
                let signal = classify_report(&body);
                let mut held = false;
                if let Some(active) = tx.loops().find_active_by_worker(&id)? {
                    if signal == ReportSignal::NeedsInput {
                        tx.loops().set_awaiting_input(&active.id, true, now)?;
                    }
                    if holds_report(signal, retry_on_failed) {
                        tx.loops().set_held_report(&active.id, Some(&body), now)?;
                        held = true;
                    }
                }
                out.push(WORKER_REPORT, &json!({"workerId": id, "parentId": parent_id, "text": body, "held": held}));
                if held {
                    out.push(LOOP_CHANGE, &json!({"workerId": id, "status": "active"}));
                }
                let parent = tx.workers().find(&parent_id)?;
                Ok((worker, parent, held))
            })
            .await?;
        let Some(parent) = parent.filter(|_| !held) else { return Ok(Reported { delivered: false, held }) };
        let at_rest = matches!(parent.state, WorkerState::Suspended | WorkerState::Done);
        if at_rest && parent.session_id.as_deref().is_some_and(|s| !s.is_empty()) && !self.is_live(&parent.id) {
            self.resume(&parent.id).await?;
        }
        let message = MessageInput {
            worker_id: parent.id.clone(),
            text: text.to_owned(),
            display_text: Some(text.to_owned()),
            envelope: Some(Envelope::WorkerReport {
                provenance: Some("agent".into()),
                from_worker: worker.id.clone(),
                worker_name: Some(worker.name.clone().unwrap_or_else(|| worker.id.clone())),
                branch: worker.branch.clone(),
                worktree_dir: worker.worktree_dir.clone(),
                status: None,
            }),
            // Each report gets a turn of its own, in the order they came.
            queue_when_busy: true,
            origin: Some("report".into()),
            ..MessageInput::default()
        };
        let delivered = match self.dispatch(message).await {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(worker_id, parent = %parent.id, error = %e, "a report could not be delivered");
                false
            }
        };
        Ok(Reported { delivered, held: false })
    }

    /// The user or the parent wrote to a worker whose loop waited for input:
    /// the loop goes on at the worker's next idle edge.
    pub async fn resume_loop_on_input(&self, worker_id: &str) -> Result<(), Error> {
        let (id, now) = (worker_id.to_owned(), self.now());
        self.store()
            .write(move |tx, _| match tx.loops().find_active_by_worker(&id)? {
                Some(active) if active.awaiting_input => tx.loops().set_awaiting_input(&active.id, false, now),
                _ => Ok(()),
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/report-signal.test.ts
    #[test]
    fn a_report_says_what_it_is_on_its_first_line() {
        assert_eq!(classify_report("Result: done\nfailed: no"), ReportSignal::Result);
        assert_eq!(classify_report("  NEEDS   input : which db?"), ReportSignal::NeedsInput);
        assert_eq!(classify_report("needsinput: x"), ReportSignal::Unknown);
        assert_eq!(classify_report("failed:\r\nwhy"), ReportSignal::Failed);
        assert_eq!(classify_report("All good.\nresult: x"), ReportSignal::Unknown);
        assert_eq!(classify_report("results: x"), ReportSignal::Unknown);
        assert!(holds_report(ReportSignal::Result, false) && holds_report(ReportSignal::Unknown, false));
        assert!(!holds_report(ReportSignal::NeedsInput, true));
        assert!(!holds_report(ReportSignal::Failed, false) && holds_report(ReportSignal::Failed, true));
    }
}
