//! `routines`, `routine_drafts`, `routine_versions`, `routine_sessions` and
//! `routine_spend`.

use eos_core::Error;
use eos_core::store::{
    RoutineRepo, RoutineSessionRepo, RoutineSpendRepo, RoutineVersionRepo, StoredDraft, StoredRoutine,
    StoredRoutineSession, StoredSpend, StoredVersion,
};
use eos_domain::run_scope::Trust;
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known, wire_word, word};

const ROUTINE_COLUMNS: &str = "id, slug, name, kind, state, paused_reason, head_version_id, origin, task_key, \
                               agents_may_start, failure_streak, created_at, updated_at, changed_at, started_at, \
                               deleted_at";

fn routine(r: &rusqlite::Row<'_>) -> Result<StoredRoutine, Error> {
    let read = || -> rusqlite::Result<StoredRoutine> {
        Ok(StoredRoutine {
            id: r.get(0)?,
            slug: r.get(1)?,
            name: r.get(2)?,
            kind: wire_word(r, 3)?,
            state: wire_word(r, 4)?,
            paused_reason: r.get(5)?,
            head_version_id: r.get(6)?,
            origin: r.get(7)?,
            task_key: r.get(8)?,
            agents_may_start: r.get(9)?,
            failure_streak: r.get(10)?,
            created_at: r.get(11)?,
            updated_at: r.get(12)?,
            changed_at: r.get(13)?,
            started_at: r.get(14)?,
            deleted_at: r.get(15)?,
        })
    };
    read().map_err(failed)
}

const DRAFT_COLUMNS: &str =
    "routine_id, purpose, architect_id, base_version_id, draft_version_id, question, status, created_at, updated_at";

fn draft(r: &rusqlite::Row<'_>) -> Result<StoredDraft, Error> {
    let read = || -> rusqlite::Result<StoredDraft> {
        Ok(StoredDraft {
            routine_id: r.get(0)?,
            purpose: r.get(1)?,
            architect_id: r.get(2)?,
            base_version_id: r.get(3)?,
            draft_version_id: r.get(4)?,
            question: r.get(5)?,
            status: wire_word(r, 6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    };
    read().map_err(failed)
}

const VERSION_COLUMNS: &str =
    "id, routine_id, parent_id, status, author, note, format, blueprint, hash, no_trial, trust, device, created_at";

fn version(r: &rusqlite::Row<'_>) -> Result<StoredVersion, Error> {
    let read = || -> rusqlite::Result<StoredVersion> {
        Ok(StoredVersion {
            id: r.get(0)?,
            routine_id: r.get(1)?,
            parent_id: r.get(2)?,
            status: wire_word(r, 3)?,
            author: wire_word(r, 4)?,
            note: r.get(5)?,
            format: r.get(6)?,
            blueprint: r.get(7)?,
            hash: r.get(8)?,
            no_trial: r.get(9)?,
            trust: known(r, 10, Trust::parse)?,
            device: r.get(11)?,
            created_at: r.get(12)?,
        })
    };
    read().map_err(failed)
}

const SESSION_COLUMNS: &str = "worker_id, routine_id, run_id, role, agent_key, created_at";

fn session(r: &rusqlite::Row<'_>) -> Result<StoredRoutineSession, Error> {
    let read = || -> rusqlite::Result<StoredRoutineSession> {
        Ok(StoredRoutineSession {
            worker_id: r.get(0)?,
            routine_id: r.get(1)?,
            run_id: r.get(2)?,
            role: r.get(3)?,
            agent_key: r.get(4)?,
            created_at: r.get(5)?,
        })
    };
    read().map_err(failed)
}

impl RoutineRepo for SqliteTx<'_> {
    fn insert(&self, routine: &StoredRoutine) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO routines ({ROUTINE_COLUMNS}) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
            ),
            params![
                routine.id,
                routine.slug,
                routine.name,
                word(&routine.kind)?,
                word(&routine.state)?,
                routine.paused_reason,
                routine.head_version_id,
                routine.origin,
                routine.task_key,
                routine.agents_may_start,
                routine.failure_streak,
                routine.created_at,
                routine.updated_at,
                routine.changed_at,
                routine.started_at,
                routine.deleted_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredRoutine>, Error> {
        self.row(&format!("SELECT {ROUTINE_COLUMNS} FROM routines WHERE id = ?1"), [id], routine)
    }

    fn list(&self) -> Result<Vec<StoredRoutine>, Error> {
        self.rows(&format!("SELECT {ROUTINE_COLUMNS} FROM routines ORDER BY created_at, rowid"), [], routine)
    }

    fn insert_draft(&self, draft: &StoredDraft) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO routine_drafts ({DRAFT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
            params![
                draft.routine_id,
                draft.purpose,
                draft.architect_id,
                draft.base_version_id,
                draft.draft_version_id,
                draft.question,
                word(&draft.status)?,
                draft.created_at,
                draft.updated_at,
            ],
        )
        .map(drop)
    }

    fn draft(&self, routine_id: &str) -> Result<Option<StoredDraft>, Error> {
        self.row(&format!("SELECT {DRAFT_COLUMNS} FROM routine_drafts WHERE routine_id = ?1"), [routine_id], draft)
    }
}

impl RoutineVersionRepo for SqliteTx<'_> {
    fn insert(&self, version: &StoredVersion) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO routine_versions ({VERSION_COLUMNS}) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
            ),
            params![
                version.id,
                version.routine_id,
                version.parent_id,
                word(&version.status)?,
                word(&version.author)?,
                version.note,
                version.format,
                version.blueprint,
                version.hash,
                version.no_trial,
                version.trust.as_str(),
                version.device,
                version.created_at,
            ],
        )
        .map(drop)
    }

    fn list(&self, routine_id: &str) -> Result<Vec<StoredVersion>, Error> {
        self.rows(
            &format!("SELECT {VERSION_COLUMNS} FROM routine_versions WHERE routine_id = ?1 ORDER BY created_at, rowid"),
            [routine_id],
            version,
        )
    }

    fn find(&self, routine_id: &str, id: &str) -> Result<Option<StoredVersion>, Error> {
        self.row(
            &format!("SELECT {VERSION_COLUMNS} FROM routine_versions WHERE routine_id = ?1 AND id = ?2"),
            [routine_id, id],
            version,
        )
    }

    fn head(&self, routine_id: &str) -> Result<Option<StoredVersion>, Error> {
        self.row(
            &format!(
                "SELECT {VERSION_COLUMNS} FROM routine_versions WHERE routine_id = ?1 \
                 AND id = (SELECT head_version_id FROM routines WHERE id = ?1)"
            ),
            [routine_id],
            version,
        )
    }
}

impl RoutineSessionRepo for SqliteTx<'_> {
    fn insert(&self, session: &StoredRoutineSession) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO routine_sessions ({SESSION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"),
            params![
                session.worker_id,
                session.routine_id,
                session.run_id,
                session.role,
                session.agent_key,
                session.created_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, worker_id: &str) -> Result<Option<StoredRoutineSession>, Error> {
        self.row(&format!("SELECT {SESSION_COLUMNS} FROM routine_sessions WHERE worker_id = ?1"), [worker_id], session)
    }

    fn by_run(&self, run_id: &str) -> Result<Vec<StoredRoutineSession>, Error> {
        self.rows(
            &format!("SELECT {SESSION_COLUMNS} FROM routine_sessions WHERE run_id = ?1 ORDER BY rowid"),
            [run_id],
            session,
        )
    }
}

impl RoutineSpendRepo for SqliteTx<'_> {
    fn add(&self, day: &str, routine_id: &str, kind: &str, cost_usd: f64) -> Result<(), Error> {
        self.exec(
            "INSERT INTO routine_spend (day, routine_id, kind, cost_usd, count) VALUES (?1, ?2, ?3, ?4, 1) \
             ON CONFLICT(day, routine_id, kind) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, count = count + 1",
            params![day, routine_id, kind, cost_usd],
        )
        .map(drop)
    }

    fn of_day(&self, day: &str) -> Result<Vec<StoredSpend>, Error> {
        self.rows(
            "SELECT day, routine_id, kind, cost_usd, count FROM routine_spend WHERE day = ?1 ORDER BY routine_id, kind",
            [day],
            |r| {
                let read = || -> rusqlite::Result<StoredSpend> {
                    Ok(StoredSpend {
                        day: r.get(0)?,
                        routine_id: r.get(1)?,
                        kind: r.get(2)?,
                        cost_usd: r.get(3)?,
                        count: r.get(4)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }
}
