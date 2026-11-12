//! A new version downloading or being prepared, in the Jobs list
//! (`manager/modules/updates/jobs.ts`); gone once it is ready or failed (the
//! update beacon carries it from there).

use eos_contracts::update::{UpdatePhase, UpdateState};
use eos_runtime::jobs::{JobProgress, JobRegistry, JobSpec};

pub(crate) const JOB_KIND: &str = "update";
const JOB_REF: &str = "update";

pub(crate) fn on_update(jobs: &JobRegistry, state: &UpdateState) {
    let status = &state.status;
    let existing = jobs.get(JOB_KIND, None, JOB_REF);
    if !matches!(status.phase, UpdatePhase::Downloading | UpdatePhase::Staging) {
        if let Some(job) = existing {
            job.drop_job();
        }
        return;
    }
    let version = status.version.as_ref().map_or("", |v| v.0.as_str());
    let staging = status.phase == UpdatePhase::Staging;
    let title = if staging { format!("Preparing Eos {version}") } else { format!("Downloading Eos {version}") };
    let detail = staging.then(|| "Building the new version beside this one".to_owned());
    let progress = match (staging, status.bytes) {
        (false, Some(total)) if total > 0 => Some(JobProgress {
            done: u64::try_from(status.done.unwrap_or(0)).unwrap_or(0),
            total: u64::try_from(total).unwrap_or(0),
        }),
        _ => None,
    };
    let change = move |job: &mut eos_runtime::jobs::BackgroundJob| {
        job.title = title;
        job.detail = detail;
        job.progress = progress;
    };
    match existing {
        Some(job) => job.update(change),
        None => {
            let mut spec = JobSpec::new(JOB_KIND, None, JOB_REF, format!("Downloading Eos {version}"));
            spec.ambient = true;
            jobs.start(spec).update_now(change);
        }
    }
}
