//! `surface_defs`, `surface_versions`, `surface_issues`, `surface_edits`,
//! `surface_state`, `surface_pins` and `surface_action_log`.

use eos_core::Error;
use eos_core::store::{
    ActionLogRepo, StoredActionRecord, StoredIssue, StoredSurface, StoredSurfaceEdit, StoredSurfaceState,
    StoredSurfaceVersion, SurfaceEditRepo, SurfaceIssueRepo, SurfacePinRepo, SurfaceRepo, SurfaceStateRepo,
    SurfaceVersionRepo,
};
use eos_kit_sqlite::rusqlite::{self, params};
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};

use crate::tx::{SqliteTx, failed, known, wire_word, word};

const SURFACE_COLUMNS: &str = "id, routine_id, level, place, role, title, current_version, candidate_version, \
                               needs_redesign, archived_at, created_at, updated_at";

fn surface(r: &rusqlite::Row<'_>) -> Result<StoredSurface, Error> {
    let read = || -> rusqlite::Result<StoredSurface> {
        Ok(StoredSurface {
            id: r.get(0)?,
            routine_id: r.get(1)?,
            level: known(r, 2, Level::parse)?,
            place: known(r, 3, Place::parse)?,
            role: known(r, 4, Role::parse)?,
            title: r.get(5)?,
            current_version: r.get(6)?,
            candidate_version: r.get(7)?,
            needs_redesign_json: r.get(8)?,
            archived_at: r.get(9)?,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
        })
    };
    read().map_err(failed)
}

const VERSION_COLUMNS: &str = "surface_id, version, status, base_version, made_by, run_id, note, body, body_bytes, \
                               checks, created_at, kept_at";

fn version(r: &rusqlite::Row<'_>) -> Result<StoredSurfaceVersion, Error> {
    let read = || -> rusqlite::Result<StoredSurfaceVersion> {
        Ok(StoredSurfaceVersion {
            surface_id: r.get(0)?,
            version: r.get(1)?,
            status: known(r, 2, VersionStatus::parse)?,
            base_version: r.get(3)?,
            made_by: known(r, 4, MadeBy::parse)?,
            run_id: r.get(5)?,
            note: r.get(6)?,
            body_json: r.get(7)?,
            body_bytes: r.get(8)?,
            checks_json: r.get(9)?,
            created_at: r.get(10)?,
            kept_at: r.get(11)?,
        })
    };
    read().map_err(failed)
}

const ISSUE_COLUMNS: &str =
    "id, surface_id, seq, run_id, version, kind, status, body, rev, images, trial, kept, created_at, updated_at";

fn issue(r: &rusqlite::Row<'_>) -> Result<StoredIssue, Error> {
    let read = || -> rusqlite::Result<StoredIssue> {
        Ok(StoredIssue {
            id: r.get(0)?,
            surface_id: r.get(1)?,
            seq: r.get(2)?,
            run_id: r.get(3)?,
            version: r.get(4)?,
            kind: known(r, 5, IssueKind::parse)?,
            status: known(r, 6, IssueStatus::parse)?,
            body_json: r.get(7)?,
            rev: r.get(8)?,
            images_json: r.get(9)?,
            trial: r.get(10)?,
            kept: r.get(11)?,
            created_at: r.get(12)?,
            updated_at: r.get(13)?,
        })
    };
    read().map_err(failed)
}

fn state(r: &rusqlite::Row<'_>) -> Result<StoredSurfaceState, Error> {
    let read = || -> rusqlite::Result<StoredSurfaceState> {
        Ok(StoredSurfaceState {
            surface_id: r.get(0)?,
            scope: r.get(1)?,
            data_json: r.get(2)?,
            bytes: r.get(3)?,
            updated_at: r.get(4)?,
        })
    };
    read().map_err(failed)
}

const RECORD_COLUMNS: &str = "id, client_id, action_id, surface_id, issue_id, routine_id, origin, class, args, \
                              decision, status, result, error_kind, created_at, finished_at";

fn record(r: &rusqlite::Row<'_>) -> Result<StoredActionRecord, Error> {
    let read = || -> rusqlite::Result<StoredActionRecord> {
        Ok(StoredActionRecord {
            id: r.get(0)?,
            client_id: r.get(1)?,
            action_id: r.get(2)?,
            surface_id: r.get(3)?,
            issue_id: r.get(4)?,
            routine_id: r.get(5)?,
            origin: r.get(6)?,
            class: wire_word(r, 7)?,
            args_json: r.get(8)?,
            decision: r.get(9)?,
            status: r.get(10)?,
            result_json: r.get(11)?,
            error_kind: r.get(12)?,
            created_at: r.get(13)?,
            finished_at: r.get(14)?,
        })
    };
    read().map_err(failed)
}

impl SurfaceRepo for SqliteTx<'_> {
    fn put(&self, s: &StoredSurface) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT OR REPLACE INTO surface_defs ({SURFACE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, \
                 ?9, ?10, ?11, ?12)"
            ),
            params![
                s.id,
                s.routine_id,
                s.level.as_str(),
                s.place.as_str(),
                s.role.as_str(),
                s.title,
                s.current_version,
                s.candidate_version,
                s.needs_redesign_json,
                s.archived_at,
                s.created_at,
                s.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredSurface>, Error> {
        self.row(&format!("SELECT {SURFACE_COLUMNS} FROM surface_defs WHERE id = ?1"), [id], surface)
    }

    fn list(&self, routine_id: Option<&str>, place: Option<Place>) -> Result<Vec<StoredSurface>, Error> {
        self.rows(
            &format!(
                "SELECT {SURFACE_COLUMNS} FROM surface_defs WHERE archived_at IS NULL \
                 AND (?1 IS NULL OR routine_id = ?1) AND (?2 IS NULL OR place = ?2) ORDER BY created_at, id"
            ),
            params![routine_id, place.map(Place::as_str)],
            surface,
        )
    }

    fn of_routine(&self, routine_id: &str) -> Result<Vec<StoredSurface>, Error> {
        self.rows(
            &format!("SELECT {SURFACE_COLUMNS} FROM surface_defs WHERE routine_id = ?1 ORDER BY created_at, id"),
            [routine_id],
            surface,
        )
    }

    fn remove(&self, id: &str) -> Result<(), Error> {
        let issues: Vec<String> =
            self.rows("SELECT id FROM surface_issues WHERE surface_id = ?1", [id], |r| r.get(0).map_err(failed))?;
        SurfaceIssueRepo::delete(self, &issues)?;
        for table in ["surface_state", "surface_pins", "surface_versions", "surface_action_log"] {
            self.exec(&format!("DELETE FROM {table} WHERE surface_id = ?1"), [id])?;
        }
        self.exec("DELETE FROM surface_defs WHERE id = ?1", [id]).map(drop)
    }
}

impl SurfaceVersionRepo for SqliteTx<'_> {
    fn put(&self, v: &StoredSurfaceVersion) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT OR REPLACE INTO surface_versions ({VERSION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, \
                 ?8, ?9, ?10, ?11, ?12)"
            ),
            params![
                v.surface_id,
                v.version,
                v.status.as_str(),
                v.base_version,
                v.made_by.as_str(),
                v.run_id,
                v.note,
                v.body_json,
                v.body_bytes,
                v.checks_json,
                v.created_at,
                v.kept_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, surface_id: &str, number: i64) -> Result<Option<StoredSurfaceVersion>, Error> {
        self.row(
            &format!("SELECT {VERSION_COLUMNS} FROM surface_versions WHERE surface_id = ?1 AND version = ?2"),
            params![surface_id, number],
            version,
        )
    }

    fn of_surface(&self, surface_id: &str) -> Result<Vec<StoredSurfaceVersion>, Error> {
        self.rows(
            &format!("SELECT {VERSION_COLUMNS} FROM surface_versions WHERE surface_id = ?1 ORDER BY version DESC"),
            [surface_id],
            version,
        )
    }

    fn next_number(&self, surface_id: &str) -> Result<i64, Error> {
        let highest = self.row(
            "SELECT COALESCE(MAX(version), 0) FROM surface_versions WHERE surface_id = ?1",
            [surface_id],
            |r| r.get::<_, i64>(0).map_err(failed),
        )?;
        Ok(highest.unwrap_or(0) + 1)
    }

    fn delete(&self, surface_id: &str, versions: &[i64]) -> Result<usize, Error> {
        let mut gone = 0;
        for version in versions {
            gone += self.exec(
                "DELETE FROM surface_versions WHERE surface_id = ?1 AND version = ?2",
                params![surface_id, version],
            )?;
        }
        Ok(gone)
    }
}

impl SurfaceIssueRepo for SqliteTx<'_> {
    fn put(&self, i: &StoredIssue) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT OR REPLACE INTO surface_issues ({ISSUE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, \
                 ?9, ?10, ?11, ?12, ?13, ?14)"
            ),
            params![
                i.id,
                i.surface_id,
                i.seq,
                i.run_id,
                i.version,
                i.kind.as_str(),
                i.status.as_str(),
                i.body_json,
                i.rev,
                i.images_json,
                i.trial,
                i.kept,
                i.created_at,
                i.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredIssue>, Error> {
        self.row(&format!("SELECT {ISSUE_COLUMNS} FROM surface_issues WHERE id = ?1"), [id], issue)
    }

    fn of_surface(&self, surface_id: &str, before: Option<&str>, limit: i64) -> Result<Vec<StoredIssue>, Error> {
        self.rows(
            &format!(
                "SELECT {ISSUE_COLUMNS} FROM surface_issues WHERE surface_id = ?1 AND (?2 IS NULL OR \
                 (created_at, id) < (SELECT created_at, id FROM surface_issues WHERE id = ?2)) \
                 ORDER BY created_at DESC, id DESC LIMIT ?3"
            ),
            params![surface_id, before, limit],
            issue,
        )
    }

    fn of_run(&self, run_id: &str) -> Result<Vec<StoredIssue>, Error> {
        self.rows(
            &format!("SELECT {ISSUE_COLUMNS} FROM surface_issues WHERE run_id = ?1 ORDER BY created_at, id"),
            [run_id],
            issue,
        )
    }

    fn next_seq(&self, surface_id: &str) -> Result<i64, Error> {
        let highest =
            self.row("SELECT COALESCE(MAX(seq), 0) FROM surface_issues WHERE surface_id = ?1", [surface_id], |r| {
                r.get::<_, i64>(0).map_err(failed)
            })?;
        Ok(highest.unwrap_or(0) + 1)
    }

    fn delete(&self, ids: &[String]) -> Result<usize, Error> {
        let mut gone = 0;
        for id in ids {
            self.exec("DELETE FROM surface_edits WHERE issue_id = ?1", [id])?;
            self.exec("DELETE FROM surface_state WHERE scope = ?1", [id])?;
            gone += self.exec("DELETE FROM surface_issues WHERE id = ?1", [id])?;
        }
        Ok(gone)
    }
}

impl SurfaceStateRepo for SqliteTx<'_> {
    fn put(&self, s: &StoredSurfaceState) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO surface_state (surface_id, scope, data, bytes, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.surface_id, s.scope, s.data_json, s.bytes, s.updated_at],
        )
        .map(drop)
    }

    fn find(&self, surface_id: &str, scope: &str) -> Result<Option<StoredSurfaceState>, Error> {
        self.row(
            "SELECT surface_id, scope, data, bytes, updated_at FROM surface_state WHERE surface_id = ?1 AND scope = ?2",
            [surface_id, scope],
            state,
        )
    }
}

impl SurfaceEditRepo for SqliteTx<'_> {
    fn insert(&self, e: &StoredSurfaceEdit) -> Result<(), Error> {
        self.exec(
            "INSERT INTO surface_edits (issue_id, rev, op, path, before, after, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![e.issue_id, e.rev, e.op, e.path, e.before_json, e.after_json, e.at],
        )
        .map(drop)
    }

    fn of_issue(&self, issue_id: &str) -> Result<Vec<StoredSurfaceEdit>, Error> {
        self.rows(
            "SELECT issue_id, rev, op, path, before, after, at FROM surface_edits WHERE issue_id = ?1 ORDER BY rev",
            [issue_id],
            |r| {
                let read = || -> rusqlite::Result<StoredSurfaceEdit> {
                    Ok(StoredSurfaceEdit {
                        issue_id: r.get(0)?,
                        rev: r.get(1)?,
                        op: r.get(2)?,
                        path: r.get(3)?,
                        before_json: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        after_json: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        at: r.get(6)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }
}

impl SurfacePinRepo for SqliteTx<'_> {
    fn list(&self) -> Result<Vec<(u8, String)>, Error> {
        self.rows("SELECT slot, surface_id FROM surface_pins ORDER BY slot", [], |r| {
            Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?))
        })
    }

    fn replace(&self, pins: &[(u8, String)], at: i64) -> Result<(), Error> {
        self.exec("DELETE FROM surface_pins", [])?;
        for (slot, surface_id) in pins {
            self.exec(
                "INSERT INTO surface_pins (slot, surface_id, pinned_at) VALUES (?1, ?2, ?3)",
                params![slot, surface_id, at],
            )?;
        }
        Ok(())
    }

    fn remove(&self, surface_id: &str) -> Result<bool, Error> {
        Ok(self.exec("DELETE FROM surface_pins WHERE surface_id = ?1", [surface_id])? > 0)
    }
}

impl SqliteTx<'_> {
    fn write_record(&self, verb: &str, r: &StoredActionRecord) -> Result<usize, Error> {
        self.exec(
            &format!(
                "{verb} INTO surface_action_log ({RECORD_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
                 ?10, ?11, ?12, ?13, ?14, ?15)"
            ),
            params![
                r.id,
                r.client_id,
                r.action_id,
                r.surface_id,
                r.issue_id,
                r.routine_id,
                r.origin,
                word(&r.class)?,
                r.args_json,
                r.decision,
                r.status,
                r.result_json,
                r.error_kind,
                r.created_at,
                r.finished_at,
            ],
        )
    }
}

impl ActionLogRepo for SqliteTx<'_> {
    fn insert(&self, record: &StoredActionRecord) -> Result<(), Error> {
        if let Some(client_id) = &record.client_id
            && self.by_client(client_id)?.is_some()
        {
            return Err(Error::Conflict(format!("an action record holds client id {client_id}")));
        }
        self.write_record("INSERT", record).map(drop)
    }

    fn update(&self, record: &StoredActionRecord) -> Result<(), Error> {
        self.write_record("INSERT OR REPLACE", record).map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredActionRecord>, Error> {
        self.row(&format!("SELECT {RECORD_COLUMNS} FROM surface_action_log WHERE id = ?1"), [id], record)
    }

    fn by_client(&self, client_id: &str) -> Result<Option<StoredActionRecord>, Error> {
        self.row(&format!("SELECT {RECORD_COLUMNS} FROM surface_action_log WHERE client_id = ?1"), [client_id], record)
    }

    fn count_since(&self, surface_id: &str, since: i64) -> Result<i64, Error> {
        let n = self.row(
            "SELECT COUNT(*) FROM surface_action_log WHERE surface_id = ?1 AND created_at >= ?2",
            params![surface_id, since],
            |r| r.get::<_, i64>(0).map_err(failed),
        )?;
        Ok(n.unwrap_or(0))
    }
}
