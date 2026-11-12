//! Pushing and pulling a worker's branch without an agent turn: the app reads
//! where the branch stands, picks the one safe git command and runs it
//! (`core/src/use-cases/PushBranch.ts`, `PullBranch.ts`). A diverged branch
//! is reported, never merged: that is the git agent's job.

use std::path::Path;

use eos_contracts::{PullPlanKind, PullResult, PushPlanKind, PushResult, PushStateResponse, WorkerEventType};
use eos_domain::git::pull_plan::{PullPlan, PullState, decide_pull_plan, summarize_pull_result};
use eos_domain::git::push_plan::{PushKind, PushPlan, decide_push_plan, summarize_push_result};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use super::{WorkerGit, no_folder};
use crate::AgentsModule;
use crate::routes::id_of;

pub(super) fn all(m: &AgentsModule) -> Vec<RouteDef> {
    vec![push_state(m.clone()), push(m.clone()), pull(m.clone())]
}

fn push_kind(plan: &PushPlan) -> PushPlanKind {
    match plan {
        PushPlan::Push(target) => match target.kind {
            PushKind::SetUpstream => PushPlanKind::SetUpstream,
            PushKind::FastForward => PushPlanKind::FastForward,
            PushKind::ForceWithLease => PushPlanKind::ForceWithLease,
        },
        PushPlan::UpToDate | PushPlan::BehindOnly => PushPlanKind::Noop,
        PushPlan::Detached | PushPlan::NoRemote => PushPlanKind::Blocked,
    }
}

fn pull_kind(plan: PullPlan) -> PullPlanKind {
    match plan {
        PullPlan::FastForward => PullPlanKind::FastForward,
        PullPlan::UpToDate => PullPlanKind::Noop,
        PullPlan::Diverged { .. } => PullPlanKind::Diverged,
        PullPlan::Detached | PullPlan::NoUpstream => PullPlanKind::Blocked,
    }
}

/// What git printed, when it printed anything.
fn detail_of(stderr: &str, stdout: &str) -> Option<String> {
    let said = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
    (!said.is_empty()).then(|| said.to_owned())
}

pub(crate) async fn push_branch(git: &WorkerGit, cwd: &Path) -> PushResult {
    let state = git.info.push_state(cwd).await;
    let plan = decide_push_plan(&state);
    let (mut reason, mut detail) = (None, None);
    if let PushPlan::Push(target) = &plan {
        let ran = git.push.push(cwd, target).await;
        reason = Some(ran.reason);
        detail = detail_of(&ran.stderr, &ran.stdout);
    }
    let summary = summarize_push_result(&plan, reason);
    PushResult {
        outcome: summary.outcome,
        ok: summary.ok,
        branch: state.branch,
        remote: state.remote,
        ahead: state.ahead.into(),
        behind: state.behind.into(),
        message: summary.message.to_owned(),
        detail,
    }
}

pub(crate) async fn pull_branch(git: &WorkerGit, cwd: &Path) -> PullResult {
    let state = git.info.pull_state(cwd).await;
    let plan = decide_pull_plan(&state);
    let (mut reason, mut detail) = (None, None);
    if plan == PullPlan::FastForward {
        let ran = git.remotes.pull(cwd).await;
        reason = Some(ran.reason);
        detail = detail_of(&ran.stderr, &ran.stdout);
    }
    let summary = summarize_pull_result(plan, reason);
    PullResult {
        outcome: summary.outcome,
        ok: summary.ok,
        branch: state.branch,
        ahead: state.ahead.into(),
        behind: state.behind.into(),
        message: summary.message.to_owned(),
        detail,
    }
}

/// The same decision the push and pull buttons run, so their visibility and
/// their action never disagree. Uncommitted work is reported apart: committed
/// work since the fork must not hide Push.
fn push_state(m: AgentsModule) -> RouteDef {
    RouteDef::get("/workers/{id}/push-state", move |req: Request| {
        let m = m.clone();
        async move {
            let worker = m.worker(&id_of(&req)).await?;
            let Some(dir) = worker.as_ref().and_then(|w| w.readable_work_dir()).map(Path::new) else {
                let blocked = PushStateResponse {
                    branch: None,
                    remote: None,
                    has_upstream: false,
                    ahead: 0,
                    behind: 0,
                    kind: PushPlanKind::Blocked,
                    pushable: false,
                    has_uncommitted: false,
                    pullable: false,
                    pull_kind: PullPlanKind::Blocked,
                };
                return Ok(Response::json(200, &blocked));
            };
            let info = &m.git().info;
            let (state, has_uncommitted) = tokio::join!(info.push_state(dir), info.has_uncommitted_changes(dir));
            let plan = decide_push_plan(&state);
            let pull = decide_pull_plan(&PullState {
                branch: state.branch.clone(),
                has_upstream: state.has_upstream,
                ahead: state.ahead,
                behind: state.behind,
            });
            let answer = PushStateResponse {
                kind: push_kind(&plan),
                pushable: matches!(plan, PushPlan::Push(_)),
                has_uncommitted,
                pullable: pull == PullPlan::FastForward,
                pull_kind: pull_kind(pull),
                branch: state.branch,
                remote: state.remote,
                has_upstream: state.has_upstream,
                ahead: state.ahead.into(),
                behind: state.behind.into(),
            };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().phone(Tier::Read))
}

fn push(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/push", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let worker = m.existing(&id).await?;
            let dir = worker.work_dir().map(Path::new).ok_or_else(no_folder)?;
            let result = push_branch(m.git(), dir).await;
            m.note(&id, WorkerEventType::GitPush, serde_json::to_value(&result).unwrap_or_default()).await?;
            Ok(Response::json(200, &result))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn pull(m: AgentsModule) -> RouteDef {
    RouteDef::post("/workers/{id}/pull", move |req: Request| {
        let m = m.clone();
        async move {
            let id = id_of(&req);
            let worker = m.existing(&id).await?;
            let dir = worker.work_dir().map(Path::new).ok_or_else(no_folder)?;
            let result = pull_branch(m.git(), dir).await;
            m.note(&id, WorkerEventType::GitPull, serde_json::to_value(&result).unwrap_or_default()).await?;
            Ok(Response::json(200, &result))
        }
    })
    .access(Access::ui_token().phone(Tier::High))
}
