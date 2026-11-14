//! File transfers in the Jobs list.

use std::sync::Arc;

use eos_contracts::{TransferChangeEvent, TransferRecord, TransferStatus};
use eos_domain::transfer::format_bytes;
use eos_runtime::jobs::{JobActionError, JobProgress, JobRegistry, JobSpec, JobStatus};

use crate::{TRANSFER_JOB_KIND, TransferService};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct JobFields {
    pub(crate) status: JobStatus,
    pub(crate) title: String,
    pub(crate) detail: Option<String>,
    pub(crate) progress: Option<JobProgress>,
}

fn bytes(n: i64) -> String {
    format_bytes(u64::try_from(n).unwrap_or(0))
}

/// How a transfer reads as a job. `to` is the receiving computer's name.
pub(crate) fn job_fields(t: &TransferRecord, to: &str) -> JobFields {
    use TransferStatus as S;
    let status = match t.status {
        S::Done => JobStatus::Completed,
        S::Failed => JobStatus::Failed,
        S::Cancelled => JobStatus::Stopped,
        _ => JobStatus::Running,
    };
    let what = match t.sources.first() {
        None => "Files".to_owned(),
        Some(first) => {
            let name = first.trim_end_matches('/').rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(first);
            if t.sources.len() > 1 { format!("{name} +{}", t.sources.len() - 1) } else { name.to_owned() }
        }
    };
    let waiting = match t.status {
        S::Queued => Some("Queued"),
        S::Scanning => Some("Scanning files"),
        S::Conflict => Some("Needs a decision"),
        S::Paused => Some("Paused"),
        S::Interrupted => Some("Interrupted — will resume"),
        S::Committing => Some("Placing files"),
        _ => None,
    };
    let detail = if t.status == S::Failed {
        t.error.as_ref().map_or_else(|| "Failed".to_owned(), |e| e.message.clone())
    } else if let Some(waiting) = waiting {
        waiting.to_owned()
    } else {
        let moved = (t.total_bytes != 0).then(|| format!("{} of {}", bytes(t.done_bytes), bytes(t.total_bytes)));
        let rate = t.rate.as_f64();
        // `Math.round`: a half goes up.
        let speed =
            (t.status == S::Copying && rate != 0.0).then(|| format!("{}/s", bytes((rate + 0.5).floor() as i64)));
        [moved, speed].into_iter().flatten().collect::<Vec<_>>().join(" · ")
    };
    let running = status == JobStatus::Running;
    JobFields {
        status,
        title: format!("{what} → {to}"),
        detail: (!detail.is_empty()).then_some(detail),
        progress: (t.total_bytes != 0 && running).then(|| JobProgress {
            done: u64::try_from(t.done_bytes).unwrap_or(0),
            total: u64::try_from(t.total_bytes).unwrap_or(0),
        }),
    }
}

/// Reflects one `transfer:change` in the Jobs list.
pub(crate) fn on_transfer(
    jobs: &JobRegistry,
    service: &Arc<TransferService>,
    change: &TransferChangeEvent,
    machine_name: &dyn Fn(&TransferRecord) -> String,
) {
    for id in change.removed.iter().flatten() {
        if let Some(job) = jobs.get(TRANSFER_JOB_KIND, None, id) {
            job.drop_job();
        }
    }
    let Some(t) = &change.transfer else { return };
    let fields = job_fields(t, &machine_name(t));
    let known = jobs.get(TRANSFER_JOB_KIND, None, &t.id.0);
    // A transfer that ended before the list saw it is history, not a job.
    if known.is_none() && fields.status != JobStatus::Running {
        return;
    }
    let created = known.is_none();
    let job = known.unwrap_or_else(|| {
        let mut spec = JobSpec::new(TRANSFER_JOB_KIND, None, t.id.0.as_str(), fields.title.as_str());
        spec.started_at = t.started_at.or(Some(t.created_at)).and_then(|at| at.as_i64());
        let (service, id) = (service.clone(), t.id.0.clone());
        jobs.start(spec.on_stop(move || {
            let (service, id) = (service.clone(), id.clone());
            async move {
                service.cancel(&id).await.map(drop).map_err(|e| JobActionError { status: 409, error: e.to_string() })
            }
        }))
    });
    let (status, agent) = (fields.status, t.origin.agent_id.clone());
    let apply = move |job: &mut eos_runtime::jobs::BackgroundJob| {
        job.title = fields.title;
        job.detail = fields.detail;
        job.progress = if status == JobStatus::Running { fields.progress } else { None };
        // Listed under the chat that sent it, when an agent did.
        if created {
            job.worker_id = agent;
        }
    };
    if status == JobStatus::Running { job.update(apply) } else { job.finish(status, apply) }
}

#[cfg(test)]
mod tests {
    use eos_contracts::{Num, TransferRecordError};
    use serde_json::json;

    use super::*;

    fn record(change: impl FnOnce(&mut TransferRecord)) -> TransferRecord {
        let mut t: TransferRecord = serde_json::from_value(json!({
            "id": "tr-abcdef123456", "from": "local", "to": "a".repeat(64), "origin": { "kind": "user" },
            "sources": ["/work/builds/Game.app/", "/work/notes.md"], "destDir": "/there", "destReason": "chosen",
            "status": "copying", "error": null, "roots": [], "fileCount": 2, "totalBytes": 10 * 1024 * 1024,
            "doneBytes": 1536, "rate": 2047.5, "route": "direct", "conflicts": [], "decisions": {}, "placed": [],
            "createdAt": 1, "startedAt": 2, "finishedAt": null,
        }))
        .expect("a transfer record");
        change(&mut t);
        t
    }

    #[test]
    fn a_transfer_reads_as_a_job() {
        let copying = job_fields(&record(|_| {}), "MacBook Air");
        assert_eq!(copying.status, JobStatus::Running);
        assert_eq!(copying.title, "Game.app +1 → MacBook Air");
        assert_eq!(copying.detail.as_deref(), Some("1.5 KB of 10 MB · 2.0 KB/s"));
        assert_eq!(copying.progress, Some(JobProgress { done: 1536, total: 10 * 1024 * 1024 }));

        let queued = job_fields(&record(|t| t.status = TransferStatus::Queued), "Air");
        assert_eq!((queued.status, queued.detail.as_deref()), (JobStatus::Running, Some("Queued")));
        let waiting = job_fields(&record(|t| t.status = TransferStatus::Interrupted), "Air");
        assert_eq!(
            (waiting.status, waiting.detail.as_deref()),
            (JobStatus::Running, Some("Interrupted — will resume"))
        );

        let done = job_fields(&record(|t| (t.status, t.rate) = (TransferStatus::Done, Num(0.0))), "Air");
        assert_eq!(
            (done.status, done.detail.as_deref(), done.progress),
            (JobStatus::Completed, Some("1.5 KB of 10 MB"), None)
        );
        let failed = job_fields(
            &record(|t| {
                t.status = TransferStatus::Failed;
                t.error = Some(TransferRecordError { code: "no-space".into(), message: "needs 1 GB".into() });
            }),
            "Air",
        );
        assert_eq!((failed.status, failed.detail.as_deref()), (JobStatus::Failed, Some("needs 1 GB")));
        let empty = job_fields(&record(|t| (t.sources, t.total_bytes, t.rate) = (Vec::new(), 0, Num(0.0))), "Air");
        assert_eq!((empty.title.as_str(), empty.detail), ("Files → Air", None));
        assert_eq!(job_fields(&record(|t| t.status = TransferStatus::Cancelled), "Air").status, JobStatus::Stopped);
    }
}
