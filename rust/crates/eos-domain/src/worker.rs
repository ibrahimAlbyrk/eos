//! A worker: one agent session and the row that outlives its process.
//!
//! [`Worker`] is what the app reasons about; [`Worker::to_row`] is what
//! clients read (snake_case, flags as `0`/`1`). The state machine is the rule
//! book only: writing the row, logging the event and announcing it are the
//! caller's (`core/src/domain/state-machine.ts`, `value-objects.ts`).

use std::path::PathBuf;

use eos_contracts::{NameSource, Num, WorkerRow, WorkerState};

/// The state as it is stored and wired (`SPAWNING`, …).
pub fn state_name(state: WorkerState) -> &'static str {
    match state {
        WorkerState::Spawning => "SPAWNING",
        WorkerState::Working => "WORKING",
        WorkerState::Idle => "IDLE",
        WorkerState::Ending => "ENDING",
        WorkerState::Done => "DONE",
        WorkerState::Killing => "KILLING",
        WorkerState::Suspended => "SUSPENDED",
    }
}

/// The state a stored name stands for.
pub fn parse_state(name: &str) -> Option<WorkerState> {
    use WorkerState::{Done, Ending, Idle, Killing, Spawning, Suspended, Working};
    [Spawning, Working, Idle, Ending, Done, Killing, Suspended].into_iter().find(|s| state_name(*s) == name)
}

/// Who named a worker, as stored (`default`, `auto`, `user`).
pub fn name_source_name(source: NameSource) -> &'static str {
    match source {
        NameSource::Default => "default",
        NameSource::Auto => "auto",
        NameSource::User => "user",
    }
}

pub fn parse_name_source(name: &str) -> Option<NameSource> {
    [NameSource::Default, NameSource::Auto, NameSource::User].into_iter().find(|s| name_source_name(*s) == name)
}

/// The states a worker in `from` may move to. Anything else is refused.
/// `Done` is near-terminal: the row stays until it is deleted, but a
/// conversation that can be resumed revives through `Done → Spawning`.
/// `Suspended` is set at start-up for a session whose process is gone while
/// its conversation is still on disk.
pub fn allowed_transitions(from: WorkerState) -> &'static [WorkerState] {
    use WorkerState::{Done, Ending, Idle, Killing, Spawning, Suspended, Working};
    match from {
        Spawning => &[Working, Idle, Ending, Done, Killing, Suspended],
        Working => &[Idle, Ending, Done, Killing, Suspended],
        Idle => &[Working, Ending, Done, Killing, Suspended],
        Ending => &[Done, Killing],
        Killing => &[Done],
        Done => &[Spawning],
        Suspended => &[Spawning, Done],
    }
}

/// Whether a worker in `from` may move to `to`. A move to the same state is
/// allowed; callers skip it before touching the row, so it logs nothing.
pub fn can_transition(from: WorkerState, to: WorkerState) -> bool {
    from == to || allowed_transitions(from).contains(&to)
}

/// The session has ended for good (until a resume).
pub fn is_terminal(state: WorkerState) -> bool {
    state == WorkerState::Done
}

/// A live session: starting, working or waiting for input.
pub fn is_active(state: WorkerState) -> bool {
    matches!(state, WorkerState::Spawning | WorkerState::Working | WorkerState::Idle)
}

/// Inside a turn. The turn clock is stamped on every entry into this set
/// from outside it, so a `Spawning → Working` move keeps the first stamp.
pub fn is_busy(state: WorkerState) -> bool {
    matches!(state, WorkerState::Spawning | WorkerState::Working)
}

/// Whether `actor` may read or act on a worker: its own row (where the
/// caller allows that) or one it started. The actor names itself; this keeps
/// an agent's tools to its own workers, it is not an authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Owned,
    /// There is no such worker.
    Missing,
    /// The worker belongs to someone else.
    NotManaged,
}

pub fn ownership(target: Option<&Worker>, target_id: &str, actor_id: &str, allow_self: bool) -> Ownership {
    if allow_self && target_id == actor_id {
        return Ownership::Owned;
    }
    match target {
        None => Ownership::Missing,
        Some(worker) if worker.parent_id.as_deref() == Some(actor_id) => Ownership::Owned,
        Some(_) => Ownership::NotManaged,
    }
}

/// What a session has cost so far. Sums, never the size of the context.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub tokens_cache_read: i64,
    /// Cache writes kept five minutes.
    pub tokens_cache_create: i64,
    /// Cache writes kept an hour.
    pub tokens_cache_create_1h: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Worker {
    pub id: String,
    pub state: WorkerState,
    /// The folder it works in; `None` for a worker in a worktree.
    pub cwd: Option<String>,
    /// The repository its worktree was made from.
    pub worktree_from: Option<String>,
    pub branch: Option<String>,
    /// The first prompt, as given.
    pub prompt: String,
    pub name: Option<String>,
    /// Who named it: only a `Default` name may be replaced automatically.
    pub name_source: Option<NameSource>,
    pub pid: Option<i64>,
    pub port: Option<i64>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub parent_id: Option<String>,
    pub model: Option<String>,
    pub usage: Usage,
    /// The prompt size of the latest request: how full the context window is.
    pub last_context_tokens: Option<i64>,
    /// The agent's task list, as the JSON text it was stored as.
    pub tasks: Option<String>,
    pub is_orchestrator: bool,
    pub tool_calls: i64,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub backend_kind: Option<String>,
    pub backend_profile: Option<String>,
    pub agent_role: Option<String>,
    pub worker_definition: Option<String>,
    /// The tool scope it was started with, as JSON text.
    pub tool_scope: Option<String>,
    pub worktree_dir: Option<String>,
    pub turn_started_at: Option<i64>,
    /// What a resume continues: the Claude Code session the TypeScript app
    /// resumes the chat by, else the engine's own (a chat begun in this app).
    pub session_id: Option<String>,
    /// The commit its worktree was forked at: the base of its diff.
    pub fork_base_sha: Option<String>,
    pub with_gateway: bool,
    /// May consult its siblings.
    pub collaborate: bool,
    pub workspace_owner_id: Option<String>,
    /// Its worktree exists on disk.
    pub workspace_ready: bool,
    pub archived_at: Option<i64>,
    /// Its folder is a scratch folder it owns, deleted with it.
    pub scratch: bool,
}

/// A worker's branch in its own worktree: what Try and integrating bring
/// back into the repository it forked from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerBranch {
    /// The repository the worktree forks from.
    pub repo_root: PathBuf,
    /// `None`, or a folder that is gone: the branch's tip stands for the work.
    pub worktree_dir: Option<PathBuf>,
    pub branch: String,
    pub worker_id: String,
}

/// Why a worker has no [`WorkerBranch`] to bring back yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchUnready {
    /// It works without a worktree of its own.
    NoBranch,
    /// Its worktree is not on disk yet.
    NotReady,
}

impl Worker {
    /// Where the agent edits: its worktree, else its folder, else (before the
    /// worktree is known) the repository it forks from.
    pub fn work_dir(&self) -> Option<&str> {
        self.worktree_dir.as_deref().or(self.cwd.as_deref()).or(self.worktree_from.as_deref())
    }

    /// [`work_dir`](Self::work_dir) for git reads: `None` while a worktree
    /// worker's tree is not on disk yet. Read before then, git would fail, or
    /// walk up into the source repository and report its changes as the
    /// worker's, or see a half checked-out tree.
    pub fn readable_work_dir(&self) -> Option<&str> {
        if self.worktree_from.is_some() && self.worktree_dir.is_some() && !self.workspace_ready {
            return None;
        }
        self.work_dir()
    }

    /// The worker's branch in its own worktree, once that tree is on disk.
    pub fn branch_ref(&self) -> Result<WorkerBranch, BranchUnready> {
        let (Some(repo_root), Some(branch)) = (&self.worktree_from, &self.branch) else {
            return Err(BranchUnready::NoBranch);
        };
        // The folder is written on the row at insert, long before the tree exists.
        let Some(worktree_dir) = self.worktree_dir.as_ref().filter(|_| self.workspace_ready) else {
            return Err(BranchUnready::NotReady);
        };
        Ok(WorkerBranch {
            repo_root: PathBuf::from(repo_root),
            worktree_dir: Some(PathBuf::from(worktree_dir)),
            branch: branch.clone(),
            worker_id: self.id.clone(),
        })
    }

    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }

    /// The row as clients read it, without the parts a route adds (`context`,
    /// `awaiting_question`, `prompt_clipped`).
    pub fn to_row(&self) -> WorkerRow {
        let flag = |on: bool| Some(Some(Num::from(i64::from(on))));
        let int = |v: Option<i64>| Some(v.map(Num::from));
        let text = |v: &Option<String>| Some(v.clone());
        WorkerRow {
            id: self.id.clone(),
            state: self.state,
            cwd: self.cwd.clone(),
            worktree_from: self.worktree_from.clone(),
            branch: self.branch.clone(),
            prompt: self.prompt.clone(),
            prompt_clipped: None,
            name: self.name.clone(),
            name_source: self.name_source,
            pid: self.pid.map(Num::from),
            port: self.port.map(Num::from),
            started_at: self.started_at.into(),
            ended_at: self.ended_at.map(Num::from),
            exit_code: self.exit_code.map(Num::from),
            parent_id: text(&self.parent_id),
            model: text(&self.model),
            tokens_in: int(Some(self.usage.tokens_in)),
            tokens_out: int(Some(self.usage.tokens_out)),
            tokens_cache_read: int(Some(self.usage.tokens_cache_read)),
            tokens_cache_create: int(Some(self.usage.tokens_cache_create)),
            tokens_cache_create_1h: int(Some(self.usage.tokens_cache_create_1h)),
            cost_usd: Some(Some(Num::from(self.usage.cost_usd))),
            last_context_tokens: int(self.last_context_tokens),
            tasks: text(&self.tasks),
            context: None,
            awaiting_question: None,
            is_orchestrator: flag(self.is_orchestrator),
            tool_calls: int(Some(self.tool_calls)),
            permission_mode: text(&self.permission_mode),
            effort: text(&self.effort),
            backend_kind: text(&self.backend_kind),
            backend_profile: text(&self.backend_profile),
            agent_role: text(&self.agent_role),
            worker_definition: text(&self.worker_definition),
            tool_scope: text(&self.tool_scope),
            worktree_dir: text(&self.worktree_dir),
            turn_started_at: int(self.turn_started_at),
            session_id: text(&self.session_id),
            fork_base_sha: text(&self.fork_base_sha),
            with_gateway: flag(self.with_gateway),
            collaborate: flag(self.collaborate),
            workspace_owner_id: text(&self.workspace_owner_id),
            workspace_ready: flag(self.workspace_ready),
            archived_at: int(self.archived_at),
            scratch: flag(self.scratch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkerState::{Done, Ending, Idle, Killing, Spawning, Suspended, Working};

    const ALL: [WorkerState; 7] = [Spawning, Working, Idle, Ending, Done, Killing, Suspended];

    // core/src/__tests__/state-machine.test.ts
    #[test]
    fn the_transition_table_is_todays() {
        let allowed: Vec<(WorkerState, WorkerState)> = ALL
            .iter()
            .flat_map(|from| ALL.iter().map(move |to| (*from, *to)))
            .filter(|(f, t)| f != t && can_transition(*f, *t))
            .collect();
        assert_eq!(allowed.len(), 6 + 5 + 5 + 2 + 1 + 1 + 2);
        for state in ALL {
            assert!(can_transition(state, state), "{state:?} to itself");
        }
        assert!(can_transition(Done, Spawning), "a finished chat can be resumed");
        assert!(can_transition(Suspended, Spawning) && can_transition(Suspended, Done));
        assert!(!can_transition(Done, Working));
        assert!(!can_transition(Killing, Idle));
        assert!(!can_transition(Ending, Working));
        assert!(!can_transition(Suspended, Idle));
    }

    #[test]
    fn stored_names_are_the_wire_names() {
        for state in ALL {
            assert_eq!(serde_json::to_value(state).expect("serializes"), state_name(state));
            assert_eq!(parse_state(state_name(state)), Some(state));
        }
        assert_eq!(parse_state("working"), None);
        for source in [NameSource::Default, NameSource::Auto, NameSource::User] {
            assert_eq!(serde_json::to_value(source).expect("serializes"), name_source_name(source));
            assert_eq!(parse_name_source(name_source_name(source)), Some(source));
        }
    }

    #[test]
    fn state_groups() {
        assert_eq!(ALL.iter().filter(|s| is_active(**s)).count(), 3);
        assert_eq!(ALL.iter().filter(|s| is_busy(**s)).count(), 2);
        assert!(is_terminal(Done) && !is_terminal(Suspended));
    }

    fn sample() -> Worker {
        Worker {
            id: "w-BUSY".into(),
            state: Suspended,
            cwd: Some("/work/beta".into()),
            worktree_from: None,
            branch: None,
            prompt: "Summarize notes.md.".into(),
            name: Some("Summarize notes".into()),
            name_source: Some(NameSource::Auto),
            pid: None,
            port: None,
            started_at: 1_790_000_400_000,
            ended_at: None,
            exit_code: None,
            parent_id: None,
            model: Some("opus".into()),
            usage: Usage { tokens_in: 400, tokens_out: 20, cost_usd: 0.02, ..Usage::default() },
            last_context_tokens: Some(400),
            tasks: None,
            is_orchestrator: false,
            tool_calls: 1,
            permission_mode: Some("plan".into()),
            effort: Some("high".into()),
            backend_kind: Some("claude".into()),
            backend_profile: None,
            agent_role: Some("focused".into()),
            worker_definition: None,
            tool_scope: None,
            worktree_dir: None,
            turn_started_at: Some(1_790_000_401_000),
            session_id: Some("0b8f3c1e-0000-4000-8000-000000000001".into()),
            fork_base_sha: None,
            with_gateway: false,
            collaborate: false,
            workspace_owner_id: None,
            workspace_ready: true,
            archived_at: None,
            scratch: false,
        }
    }

    // The row `GET /workers` answered for this worker (fixtures/wire/recordings/11-chats.json),
    // without the `context` a route adds.
    #[test]
    fn the_wire_row_is_the_recorded_one() {
        let row = serde_json::to_value(sample().to_row()).expect("serializes");
        let recorded: serde_json::Value = serde_json::from_str(
            r#"{"agent_role": "focused", "archived_at": null, "backend_kind": "claude", "backend_profile": null,
            "branch": null, "collaborate": 0, "cost_usd": 0.02, "cwd": "/work/beta", "effort": "high",
            "ended_at": null, "exit_code": null, "fork_base_sha": null, "id": "w-BUSY", "is_orchestrator": 0,
            "last_context_tokens": 400, "model": "opus", "name": "Summarize notes", "name_source": "auto",
            "parent_id": null, "permission_mode": "plan", "pid": null, "port": null,
            "prompt": "Summarize notes.md.", "scratch": 0, "session_id": "0b8f3c1e-0000-4000-8000-000000000001",
            "started_at": 1790000400000, "state": "SUSPENDED", "tasks": null, "tokens_cache_create": 0,
            "tokens_cache_create_1h": 0, "tokens_cache_read": 0, "tokens_in": 400, "tokens_out": 20,
            "tool_calls": 1, "tool_scope": null, "turn_started_at": 1790000401000, "with_gateway": 0,
            "worker_definition": null, "workspace_owner_id": null, "workspace_ready": 1, "worktree_dir": null,
            "worktree_from": null}"#,
        )
        .expect("the recorded row");
        let (row, recorded) = (row.as_object().expect("object"), recorded.as_object().expect("object"));
        for (key, want) in recorded {
            assert_eq!(row.get(key), Some(want), "{key}");
        }
        assert_eq!(row.len(), recorded.len(), "no extra keys");
    }

    // core/src/__tests__/WorkerOwnership.test.ts
    #[test]
    fn an_actor_owns_itself_and_the_workers_it_started() {
        let mut child = sample();
        child.parent_id = Some("o-1".into());
        assert_eq!(ownership(Some(&child), "w-BUSY", "o-1", false), Ownership::Owned);
        assert_eq!(ownership(Some(&child), "w-BUSY", "o-2", false), Ownership::NotManaged);
        assert_eq!(ownership(Some(&sample()), "w-BUSY", "o-1", true), Ownership::NotManaged, "no parent at all");
        assert_eq!(ownership(None, "w-x", "o-1", true), Ownership::Missing);
        assert_eq!(ownership(None, "o-1", "o-1", true), Ownership::Owned, "itself, before the row is even read");
        assert_eq!(ownership(None, "o-1", "o-1", false), Ownership::Missing);
    }

    #[test]
    fn the_work_dir_prefers_the_worktree() {
        let mut worker = sample();
        assert_eq!(worker.work_dir(), Some("/work/beta"));
        worker.worktree_dir = Some("/trees/x".into());
        assert_eq!(worker.work_dir(), Some("/trees/x"));
        worker.worktree_dir = None;
        worker.cwd = None;
        worker.worktree_from = Some("/repo".into());
        assert_eq!(worker.work_dir(), Some("/repo"));
    }
}
