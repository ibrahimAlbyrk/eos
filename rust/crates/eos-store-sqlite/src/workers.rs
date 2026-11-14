//! `workers` (`infra/src/persistence/SqliteWorkerRepo.ts`).

use eos_contracts::{NameSource, WorkerState};
use eos_core::Error;
use eos_core::store::{NewWorker, WorkerRepo};
use eos_domain::worker::{name_source_name, parse_name_source, parse_state, state_name};
use eos_domain::{Usage, Worker};
use eos_kit_sqlite::rusqlite::{Row, params};

use crate::tx::{SqliteTx, failed};

/// Every column a [`Worker`] holds, in the order [`worker`] reads them. Named
/// one by one: the table grew by `ALTER TABLE`, so its own column order
/// differs between a migrated file and nothing else should depend on it.
///
/// The session a resume continues is the Claude Code one the TypeScript app
/// resumes the chat by (`workers.session_id`, never written here), else this
/// app's own (`engine_sessions`): a chat begun here has only that one.
const COLUMNS: &str = "id, state, cwd, worktree_from, branch, prompt, name, name_source, pid, port, started_at, \
    ended_at, exit_code, parent_id, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, \
    tokens_cache_create_1h, cost_usd, last_context_tokens, tasks, is_orchestrator, tool_calls, permission_mode, \
    effort, backend_kind, backend_profile, agent_role, worker_definition, tool_scope, worktree_dir, \
    turn_started_at, \
    COALESCE(NULLIF(session_id, ''), (SELECT s.session_id FROM engine_sessions s WHERE s.worker_id = workers.id)), \
    fork_base_sha, with_gateway, collaborate, workspace_owner_id, workspace_ready, archived_at, scratch";

fn worker(row: &Row<'_>) -> Result<Worker, Error> {
    // Flags and counters written before their column existed are NULL: off, zero.
    let flag = |i: usize| row.get::<_, Option<i64>>(i).map(|v| v.unwrap_or(0) != 0);
    let count = |i: usize| row.get::<_, Option<i64>>(i).map(Option::unwrap_or_default);
    let read = || -> eos_kit_sqlite::rusqlite::Result<(Worker, String)> {
        let state: String = row.get(1)?;
        let name_source: Option<String> = row.get(7)?;
        let worker = Worker {
            id: row.get(0)?,
            state: WorkerState::Done,
            cwd: row.get(2)?,
            worktree_from: row.get(3)?,
            branch: row.get(4)?,
            prompt: row.get(5)?,
            name: row.get(6)?,
            name_source: name_source.as_deref().and_then(parse_name_source),
            pid: row.get(8)?,
            port: row.get(9)?,
            started_at: row.get(10)?,
            ended_at: row.get(11)?,
            exit_code: row.get(12)?,
            parent_id: row.get(13)?,
            model: row.get(14)?,
            usage: Usage {
                tokens_in: count(15)?,
                tokens_out: count(16)?,
                tokens_cache_read: count(17)?,
                tokens_cache_create: count(18)?,
                tokens_cache_create_1h: count(19)?,
                cost_usd: row.get::<_, Option<f64>>(20)?.unwrap_or_default(),
            },
            last_context_tokens: row.get(21)?,
            tasks: row.get(22)?,
            is_orchestrator: flag(23)?,
            tool_calls: count(24)?,
            permission_mode: row.get(25)?,
            effort: row.get(26)?,
            backend_kind: row.get(27)?,
            backend_profile: row.get(28)?,
            agent_role: row.get(29)?,
            worker_definition: row.get(30)?,
            tool_scope: row.get(31)?,
            worktree_dir: row.get(32)?,
            turn_started_at: row.get(33)?,
            session_id: row.get(34)?,
            fork_base_sha: row.get(35)?,
            with_gateway: flag(36)?,
            collaborate: flag(37)?,
            workspace_owner_id: row.get(38)?,
            workspace_ready: flag(39)?,
            archived_at: row.get(40)?,
            scratch: flag(41)?,
        };
        Ok((worker, state))
    };
    let (mut worker, state) = read().map_err(failed)?;
    // Older rows may carry the name in another case.
    worker.state = parse_state(&state.to_ascii_uppercase())
        .ok_or_else(|| Error::Storage(format!("worker {} has an unknown state: {state}", worker.id)))?;
    Ok(worker)
}

impl SqliteTx<'_> {
    fn workers_where(&self, tail: &str, params: impl eos_kit_sqlite::rusqlite::Params) -> Result<Vec<Worker>, Error> {
        self.rows(&format!("SELECT {COLUMNS} FROM workers {tail}"), params, worker)
    }
}

impl WorkerRepo for SqliteTx<'_> {
    fn insert(&self, w: &NewWorker) -> Result<(), Error> {
        self.exec(
            "INSERT INTO workers (id, state, cwd, worktree_from, branch, prompt, name, name_source, pid, port, \
             started_at, parent_id, model, effort, is_orchestrator, backend_kind, backend_profile, agent_role, \
             worker_definition, tool_scope, with_gateway, collaborate, turn_started_at, worktree_dir, \
             workspace_owner_id, workspace_ready, scratch) \
             VALUES (?1, 'SPAWNING', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, \
             ?19, ?20, ?21, ?10, ?22, ?23, ?24, ?25)",
            params![
                w.id,
                w.cwd,
                w.worktree_from,
                w.branch,
                w.prompt,
                w.name,
                name_source_name(w.name_source),
                w.pid,
                w.port,
                w.started_at,
                w.parent_id,
                w.model,
                w.effort,
                w.is_orchestrator,
                w.backend_kind,
                w.backend_profile,
                w.agent_role,
                w.worker_definition,
                w.tool_scope,
                w.with_gateway,
                w.collaborate,
                w.worktree_dir,
                w.workspace_owner_id,
                w.workspace_ready,
                w.scratch,
            ],
        )?;
        Ok(())
    }

    fn find(&self, id: &str) -> Result<Option<Worker>, Error> {
        self.row(&format!("SELECT {COLUMNS} FROM workers WHERE id = ?1"), [id], worker)
    }

    fn list_all(&self) -> Result<Vec<Worker>, Error> {
        self.workers_where("ORDER BY started_at DESC", [])
    }

    fn list_by_parent(&self, parent_id: &str) -> Result<Vec<Worker>, Error> {
        self.workers_where("WHERE parent_id = ?1 ORDER BY started_at DESC", [parent_id])
    }

    fn list_orchestrators(&self) -> Result<Vec<Worker>, Error> {
        self.workers_where("WHERE is_orchestrator = 1 ORDER BY started_at ASC", [])
    }

    fn list_active(&self) -> Result<Vec<Worker>, Error> {
        self.workers_where("WHERE archived_at IS NULL ORDER BY started_at DESC", [])
    }

    fn list_archived(&self) -> Result<Vec<Worker>, Error> {
        self.workers_where("WHERE archived_at IS NOT NULL ORDER BY started_at DESC", [])
    }

    fn find_children_ids(&self, parent_id: &str) -> Result<Vec<String>, Error> {
        self.rows("SELECT id FROM workers WHERE parent_id = ?1", [parent_id], |r| r.get(0).map_err(failed))
    }

    fn count_by_state(&self) -> Result<Vec<(String, i64)>, Error> {
        self.rows("SELECT state, COUNT(*) FROM workers GROUP BY state", [], |r| {
            Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?))
        })
    }

    fn update_state(&self, id: &str, state: WorkerState) -> Result<(), Error> {
        self.exec("UPDATE workers SET state = ?1 WHERE id = ?2", params![state_name(state), id]).map(drop)
    }

    fn set_turn_started_at(&self, id: &str, ts: i64) -> Result<(), Error> {
        self.exec("UPDATE workers SET turn_started_at = ?1 WHERE id = ?2", params![ts, id]).map(drop)
    }

    fn mark_done(&self, id: &str, ended_at: i64, exit_code: Option<i64>) -> Result<(), Error> {
        self.exec(
            "UPDATE workers SET state = 'DONE', ended_at = ?1, exit_code = ?2 WHERE id = ?3",
            params![ended_at, exit_code, id],
        )
        .map(drop)
    }

    fn add_usage(&self, id: &str, delta: &Usage) -> Result<(), Error> {
        self.exec(
            "UPDATE workers SET \
               tokens_in = COALESCE(tokens_in, 0) + ?1, \
               tokens_out = COALESCE(tokens_out, 0) + ?2, \
               tokens_cache_read = COALESCE(tokens_cache_read, 0) + ?3, \
               tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?4, \
               tokens_cache_create_1h = COALESCE(tokens_cache_create_1h, 0) + ?5, \
               cost_usd = COALESCE(cost_usd, 0) + ?6 \
             WHERE id = ?7",
            params![
                delta.tokens_in,
                delta.tokens_out,
                delta.tokens_cache_read,
                delta.tokens_cache_create,
                delta.tokens_cache_create_1h,
                delta.cost_usd,
                id
            ],
        )
        .map(drop)
    }

    fn set_context_tokens(&self, id: &str, tokens: i64) -> Result<(), Error> {
        self.exec("UPDATE workers SET last_context_tokens = ?1 WHERE id = ?2", params![tokens, id]).map(drop)
    }

    fn increment_tool_calls(&self, id: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET tool_calls = COALESCE(tool_calls, 0) + 1 WHERE id = ?1", [id]).map(drop)
    }

    fn update_name(&self, id: &str, name: Option<&str>, source: NameSource) -> Result<(), Error> {
        self.exec(
            "UPDATE workers SET name = ?1, name_source = ?2 WHERE id = ?3",
            params![name, name_source_name(source), id],
        )
        .map(drop)
    }

    fn update_name_if_source(
        &self,
        id: &str,
        name: &str,
        expected: NameSource,
        next: NameSource,
    ) -> Result<bool, Error> {
        let changed = self.exec(
            "UPDATE workers SET name = ?1, name_source = ?2 WHERE id = ?3 AND name_source = ?4",
            params![name, name_source_name(next), id, name_source_name(expected)],
        )?;
        Ok(changed > 0)
    }

    fn update_permission_mode(&self, id: &str, mode: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET permission_mode = ?1 WHERE id = ?2", [mode, id]).map(drop)
    }

    fn update_model(&self, id: &str, model: &str, effort: Option<&str>) -> Result<(), Error> {
        self.exec("UPDATE workers SET model = ?1, effort = ?2 WHERE id = ?3", params![model, effort, id]).map(drop)
    }

    fn update_backend_kind(&self, id: &str, kind: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET backend_kind = ?1 WHERE id = ?2", [kind, id]).map(drop)
    }

    fn set_worktree_dir(&self, id: &str, dir: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET worktree_dir = ?1 WHERE id = ?2", [dir, id]).map(drop)
    }

    fn set_fork_base_sha(&self, id: &str, sha: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET fork_base_sha = ?1 WHERE id = ?2", [sha, id]).map(drop)
    }

    fn set_workspace_ready(&self, id: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET workspace_ready = 1 WHERE id = ?1", [id]).map(drop)
    }

    fn set_engine_session(&self, id: &str, session_id: &str) -> Result<(), Error> {
        self.exec(
            "INSERT INTO engine_sessions (worker_id, session_id) VALUES (?1, ?2) \
             ON CONFLICT (worker_id) DO UPDATE SET session_id = excluded.session_id",
            [id, session_id],
        )
        .map(drop)
    }

    fn set_tasks(&self, id: &str, tasks: Option<&str>) -> Result<(), Error> {
        self.exec("UPDATE workers SET tasks = ?1 WHERE id = ?2", params![tasks, id]).map(drop)
    }

    fn clear_runtime(&self, id: &str) -> Result<(), Error> {
        self.exec("UPDATE workers SET pid = NULL, port = NULL WHERE id = ?1", [id]).map(drop)
    }

    fn set_archived(&self, id: &str, at: Option<i64>) -> Result<(), Error> {
        self.exec("UPDATE workers SET archived_at = ?1 WHERE id = ?2", params![at, id]).map(drop)
    }

    fn reactivate(&self, id: &str, pid: Option<i64>, port: i64) -> Result<(), Error> {
        self.exec(
            "UPDATE workers SET pid = ?1, port = ?2, ended_at = NULL, exit_code = NULL WHERE id = ?3",
            params![pid, port, id],
        )
        .map(drop)
    }

    fn delete(&self, id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM engine_sessions WHERE worker_id = ?1", [id])?;
        self.exec("DELETE FROM workers WHERE id = ?1", [id]).map(drop)
    }
}
