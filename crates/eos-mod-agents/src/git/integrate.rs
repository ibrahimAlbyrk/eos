//! An orchestrator gathering its workers' work: their worktrees merged into
//! its own checkout. Disjoint work lands as staged edits; a real overlap is
//! left as a conflict for the conflict view. Only the orchestrator's own
//! workers that are not archived take part; nothing is committed.

use std::collections::HashMap;
use std::path::PathBuf;

use eos_contracts::{
    IntegrateOutcome, IntegrateWorkerResult, IntegrateWorkersRequest, IntegrateWorkersResponse, WorkerEventType,
    WorkerState,
};
use eos_domain::worker::BranchUnready;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::AgentsModule;
use crate::routes::id_of;

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The one-line summary the orchestrator and the dashboard read.
fn summary(response: &IntegrateWorkersResponse, detail: Option<&str>) -> String {
    let count = |o: IntegrateOutcome| response.workers.iter().filter(|w| w.outcome == o).count();
    let (merged, conflicted) = (count(IntegrateOutcome::Merged), count(IntegrateOutcome::Conflicted));
    let (pending, skipped) = (count(IntegrateOutcome::Pending), count(IntegrateOutcome::Skipped));
    let mut parts = Vec::new();
    if !response.ok {
        parts.push(format!("Integration failed: {}", detail.unwrap_or("git error")));
    } else if merged == 0 && conflicted == 0 {
        parts.push("Nothing to integrate.".to_owned());
    } else {
        if merged > 0 {
            let into = response.branch.as_deref().filter(|b| !b.is_empty()).map(|b| format!(" into {b}"));
            parts.push(format!(
                "Merged {merged} worker{} ({} files){}.",
                plural(merged),
                response.merged_files.len(),
                into.unwrap_or_default()
            ));
        }
        if conflicted > 0 {
            let behind = if pending > 0 { format!(" {pending} worker(s) pending behind it.") } else { String::new() };
            parts.push(format!(
                "Conflict in {} file(s) — resolve in the dashboard conflict view, then re-run.{behind}",
                response.conflicted_files.len()
            ));
        }
    }
    if skipped > 0 {
        parts.push(format!("{skipped} skipped."));
    }
    parts.join(" ")
}

pub(crate) fn integrate(m: AgentsModule) -> RouteDef {
    RouteDef::post("/orchestrators/{id}/integrate", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let orchestrator =
                m.worker(&id).await?.ok_or_else(|| ApiError::NotFound("orchestrator not found".into()))?;
            let checkout = orchestrator
                .worktree_dir
                .or(orchestrator.cwd)
                .or(orchestrator.worktree_from)
                .ok_or_else(|| ApiError::Validation("orchestrator has no working directory".into()))?;
            let body: IntegrateWorkersRequest = req.parse()?;

            let parent = id.clone();
            let children = m.store.read(move |tx| tx.workers().list_by_parent(&parent)).await?;
            // An archived worker's branch is never swept in.
            let children: Vec<_> = children
                .into_iter()
                .filter(|w| !w.is_archived())
                .filter(|w| body.ids.as_ref().is_none_or(|ids| ids.contains(&w.id)))
                .collect();
            let names: HashMap<&str, Option<&str>> =
                children.iter().map(|w| (w.id.as_str(), w.name.as_deref())).collect();

            let mut refs = Vec::new();
            let mut skipped = Vec::new();
            for worker in &children {
                let busy = matches!(
                    worker.state,
                    WorkerState::Spawning | WorkerState::Working | WorkerState::Killing | WorkerState::Ending
                );
                let reason = match worker.branch_ref() {
                    Err(BranchUnready::NoBranch) => "no worktree branch",
                    _ if busy => "busy",
                    Err(BranchUnready::NotReady) => "worktree not ready",
                    Ok(branch) => {
                        refs.push(branch);
                        continue;
                    }
                };
                skipped.push(IntegrateWorkerResult {
                    worker_id: worker.id.clone(),
                    name: worker.name.clone(),
                    branch: worker.branch.clone(),
                    outcome: IntegrateOutcome::Skipped,
                    files: Vec::new(),
                    reason: Some(reason.to_owned()),
                });
            }

            let git = m.git();
            let checkout_path = PathBuf::from(&checkout);
            let merge = git.merge.merge_all(&checkout_path, &refs).await;
            let branch = git.info.current_branch(&checkout_path).await;
            let mut workers: Vec<IntegrateWorkerResult> = merge
                .results
                .into_iter()
                .map(|r| IntegrateWorkerResult {
                    name: names.get(r.worker_id.as_str()).copied().flatten().map(str::to_owned),
                    worker_id: r.worker_id,
                    branch: Some(r.branch),
                    outcome: r.outcome,
                    files: r.files,
                    reason: r.reason,
                })
                .collect();
            workers.extend(skipped);
            let mut response = IntegrateWorkersResponse {
                ok: merge.ok,
                checkout,
                branch,
                workers,
                merged_files: merge.merged_files,
                conflicted_files: merge.conflicted_files,
                message: String::new(),
            };
            response.message = summary(&response, merge.detail.as_deref());

            let count = |o: IntegrateOutcome| response.workers.iter().filter(|w| w.outcome == o).count();
            let note = json!({
                "merged": count(IntegrateOutcome::Merged),
                "conflicted": count(IntegrateOutcome::Conflicted),
                "pending": count(IntegrateOutcome::Pending),
                "skipped": count(IntegrateOutcome::Skipped),
                "mergedFiles": response.merged_files,
                "conflictedFiles": response.conflicted_files,
            });
            m.note(&id, WorkerEventType::WorkersIntegrated, note).await?;
            Ok(Response::json(200, &response))
        }
    })
    .access(Access::open().phone(Tier::High))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker(outcome: IntegrateOutcome) -> IntegrateWorkerResult {
        IntegrateWorkerResult {
            worker_id: "w".into(),
            name: None,
            branch: None,
            outcome,
            files: Vec::new(),
            reason: None,
        }
    }

    fn response(
        ok: bool,
        workers: Vec<IntegrateWorkerResult>,
        merged: usize,
        conflicted: usize,
    ) -> IntegrateWorkersResponse {
        IntegrateWorkersResponse {
            ok,
            checkout: "/repo".into(),
            branch: Some("main".into()),
            workers,
            merged_files: (0..merged).map(|i| format!("m{i}")).collect(),
            conflicted_files: (0..conflicted).map(|i| format!("c{i}")).collect(),
            message: String::new(),
        }
    }

    // The 0.1.x app's sentences.
    #[test]
    fn the_summary_says_what_happened_as_today() {
        use IntegrateOutcome::*;
        let failed = response(false, vec![worker(Skipped)], 0, 0);
        assert_eq!(
            summary(&failed, Some("not a git repo / no HEAD")),
            "Integration failed: not a git repo / no HEAD 1 skipped."
        );
        assert_eq!(summary(&response(false, vec![], 0, 0), None), "Integration failed: git error");
        assert_eq!(summary(&response(true, vec![], 0, 0), None), "Nothing to integrate.");
        let one = response(true, vec![worker(Merged)], 2, 0);
        assert_eq!(summary(&one, None), "Merged 1 worker (2 files) into main.");
        let mixed = response(true, vec![worker(Merged), worker(Merged), worker(Conflicted), worker(Pending)], 3, 1);
        assert_eq!(
            summary(&mixed, None),
            "Merged 2 workers (3 files) into main. Conflict in 1 file(s) — resolve in the dashboard conflict view, then re-run. 1 worker(s) pending behind it."
        );
    }
}
