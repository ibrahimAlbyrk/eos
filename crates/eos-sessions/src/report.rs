//! A worker's report to the session that spawned it (`POST /workers/:id/report`).

use eos_contracts::stream::topics::WORKER_REPORT;
use eos_core::Error;
use eos_domain::envelope::Envelope;
use serde_json::json;

use crate::dispatch::MessageInput;
use crate::service::Sessions;

/// What became of a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    /// The parent got it (as a turn, or in its queue).
    pub delivered: bool,
    /// It went on to a parent that exists (delivered or not).
    pub parent_found: bool,
}

impl Sessions {
    /// Hands a worker's report to its parent: a turn of the parent, queued
    /// while it is busy. A parent whose session is over is continued first.
    /// Fails when the worker does not exist (`NotFound`) or has no parent
    /// (`Validation`).
    pub async fn report(&self, worker_id: &str, text: &str) -> Result<Reported, Error> {
        let (id, body) = (worker_id.to_owned(), text.to_owned());
        let (worker, parent) = self
            .store()
            .write(move |tx, out| {
                let worker = tx.workers().find(&id)?.ok_or_else(|| Error::not_found("worker", &id))?;
                let Some(parent_id) = worker.parent_id.clone() else {
                    return Err(Error::Validation("worker has no parent".into()));
                };
                out.push(WORKER_REPORT, &json!({"workerId": id, "parentId": parent_id, "text": body}));
                let parent = tx.workers().find(&parent_id)?;
                Ok((worker, parent))
            })
            .await?;
        let Some(parent) = parent else {
            return Ok(Reported { delivered: false, parent_found: false });
        };
        self.revive(&parent.id).await?;
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
                tracing::warn!(parent = %parent.id, error = %e, "a report could not be delivered");
                false
            }
        };
        Ok(Reported { delivered, parent_found: true })
    }
}
