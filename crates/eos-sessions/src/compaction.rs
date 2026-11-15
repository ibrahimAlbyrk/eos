//! A session summarizing its conversation, in the worker's log: the
//! `compaction_*` rows the dashboard shows (a running summary, the boundary
//! card that folds the history above it, a failure line). A finished summary
//! sets the context in use to the summary's size, and the "context is filling
//! up" notes may fire again.

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{CompactionCompletedPayload, CompactionFailedPayload, CompactionStartedPayload, WorkerEventType};
use eos_core::Error;
use eos_core::agent::CompactionNotice;
use eos_domain::context::context_pct;
use serde_json::{Value, json};

use crate::service::Sessions;

impl Sessions {
    pub(crate) async fn on_compaction(&self, worker_id: &str, notice: CompactionNotice) {
        let (id, now, models) = (worker_id.to_owned(), self.now(), self.0.deps.models.clone());
        let row = notice.clone();
        let written = self
            .store()
            .write(move |tx, out| {
                let Some(worker) = tx.workers().find(&id)? else { return Ok(()) };
                let limit = Some(models.context_window_for(worker.model.as_deref()));
                let (kind, payload) = row_of(&row, |tokens| context_pct(tokens, limit))?;
                let row_id = tx.events().append_json(&id, now, kind, &payload)?;
                if let CompactionNotice::Completed { after_tokens, .. } = &row {
                    tx.workers().set_context_tokens(&id, *after_tokens)?;
                    tx.context_marks().clear(&id)?;
                }
                out.push(WORKER_CHANGE, &json!({"workerId": id, "rowId": row_id}));
                Ok(())
            })
            .await;
        match written {
            Ok(()) => self.0.deps.hooks.compaction(worker_id, &notice),
            Err(e) => tracing::error!(worker_id, error = %e, "a compaction could not be recorded"),
        }
        if let CompactionNotice::Completed { before_tokens, after_tokens, turns, duration_ms, .. } = &notice {
            tracing::info!(worker_id, before_tokens, after_tokens, turns, duration_ms, "context compacted");
        } else if let CompactionNotice::Failed { error, .. } = &notice {
            tracing::warn!(worker_id, error = error.as_str(), "context compaction failed");
        }
    }
}

fn to_value(payload: impl serde::Serialize) -> Result<Value, Error> {
    serde_json::to_value(payload).map_err(Error::storage)
}

/// The row of `notice`; `pct` is how full the context was at `tokens`.
fn row_of(notice: &CompactionNotice, pct: impl Fn(i64) -> Option<i64>) -> Result<(WorkerEventType, Value), Error> {
    Ok(match notice.clone() {
        CompactionNotice::Started { trigger, before_tokens, instructions } => (
            WorkerEventType::CompactionStarted,
            to_value(CompactionStartedPayload {
                trigger,
                before_tokens: before_tokens.into(),
                pct: pct(before_tokens).map(Into::into),
                instructions,
            })?,
        ),
        CompactionNotice::Completed {
            trigger,
            before_tokens,
            after_tokens,
            turns,
            summary,
            instructions,
            duration_ms,
        } => (
            WorkerEventType::CompactionCompleted,
            to_value(CompactionCompletedPayload {
                trigger,
                before_tokens: before_tokens.into(),
                after_tokens: after_tokens.into(),
                pct: pct(before_tokens).map(Into::into),
                turns,
                summary,
                duration_ms: duration_ms.into(),
                instructions,
            })?,
        ),
        CompactionNotice::Failed { trigger, error } => {
            (WorkerEventType::CompactionFailed, to_value(CompactionFailedPayload { trigger, error })?)
        }
    })
}

#[cfg(test)]
mod tests {
    use eos_contracts::CompactionTrigger;

    use super::*;

    #[test]
    fn rows_carry_the_dashboards_fields() {
        let pct = |tokens: i64| Some(tokens / 10_000);
        let started = CompactionNotice::Started {
            trigger: CompactionTrigger::Manual,
            before_tokens: 700_000,
            instructions: Some("keep the plan".into()),
        };
        let (kind, row) = row_of(&started, pct).expect("row");
        assert_eq!(kind, WorkerEventType::CompactionStarted);
        assert_eq!(
            row,
            json!({"trigger": "manual", "beforeTokens": 700_000, "pct": 70, "instructions": "keep the plan"})
        );
        let completed = CompactionNotice::Completed {
            trigger: CompactionTrigger::Auto,
            before_tokens: 700_000,
            after_tokens: 4_000,
            turns: 3,
            summary: "1. Task".into(),
            instructions: None,
            duration_ms: 1_500,
        };
        let (kind, row) = row_of(&completed, pct).expect("row");
        assert_eq!(kind, WorkerEventType::CompactionCompleted);
        assert_eq!(
            row,
            json!({"trigger": "auto", "beforeTokens": 700_000, "afterTokens": 4_000, "pct": 70, "turns": 3,
                   "summary": "1. Task", "durationMs": 1_500})
        );
        let failed = CompactionNotice::Failed { trigger: CompactionTrigger::Auto, error: "interrupted".into() };
        assert_eq!(row_of(&failed, pct).expect("row").1, json!({"trigger": "auto", "error": "interrupted"}));
    }
}
