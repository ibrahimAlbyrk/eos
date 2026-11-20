//! `mem_moments`, `mem_cursors`, `mem_uses`, `mem_stated`, `mem_forgotten`,
//! `mem_settings` and `mem_daily`.

use eos_core::Error;
use eos_core::store::{
    DailyCall, DailyCalls, MemBookRepo, MemCursorRepo, MemMomentRepo, MemUseRepo, StoredForgotten, StoredMoment,
    StoredStated, StoredUse,
};
use eos_domain::experience::Trust;
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known};

const MOMENT_COLUMNS: &str = "id, worker_id, source, run_id, signal, trust, row_from, row_to, cues, state, note_id, \
                              attempts, created_at, done_at";

fn moment(r: &rusqlite::Row<'_>) -> Result<StoredMoment, Error> {
    let read = || -> rusqlite::Result<StoredMoment> {
        Ok(StoredMoment {
            id: r.get(0)?,
            worker_id: r.get(1)?,
            source: r.get(2)?,
            run_id: r.get(3)?,
            signal: r.get(4)?,
            trust: known(r, 5, Trust::parse)?,
            row_from: r.get(6)?,
            row_to: r.get(7)?,
            cues: r.get(8)?,
            state: r.get(9)?,
            note_id: r.get(10)?,
            attempts: r.get(11)?,
            created_at: r.get(12)?,
            done_at: r.get(13)?,
        })
    };
    read().map_err(failed)
}

impl MemMomentRepo for SqliteTx<'_> {
    fn insert(&self, m: &StoredMoment) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO mem_moments ({MOMENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
            params![
                m.id,
                m.worker_id,
                m.source,
                m.run_id,
                m.signal,
                m.trust.as_str(),
                m.row_from,
                m.row_to,
                m.cues,
                m.state,
                m.note_id,
                m.attempts,
                m.created_at,
                m.done_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredMoment>, Error> {
        self.row(&format!("SELECT {MOMENT_COLUMNS} FROM mem_moments WHERE id = ?1"), [id], moment)
    }

    fn pending(&self, limit: i64) -> Result<Vec<StoredMoment>, Error> {
        self.rows(
            &format!(
                "SELECT {MOMENT_COLUMNS} FROM mem_moments WHERE state = 'pending' ORDER BY \
                 CASE trust WHEN 'said' THEN 0 WHEN 'outcome' THEN 1 WHEN 'did' THEN 2 ELSE 3 END, created_at, id \
                 LIMIT ?1"
            ),
            [limit],
            moment,
        )
    }

    fn count_pending(&self) -> Result<i64, Error> {
        self.row("SELECT COUNT(*) FROM mem_moments WHERE state = 'pending'", [], |r| r.get(0).map_err(failed))
            .map(Option::unwrap_or_default)
    }

    fn finish(&self, id: &str, state: &str, note_id: Option<&str>, at: i64) -> Result<(), Error> {
        self.exec(
            "UPDATE mem_moments SET state = ?2, note_id = ?3, done_at = ?4 WHERE id = ?1",
            params![id, state, note_id, at],
        )
        .map(drop)
    }

    fn add_attempt(&self, id: &str) -> Result<i64, Error> {
        self.exec("UPDATE mem_moments SET attempts = attempts + 1 WHERE id = ?1", [id])?;
        self.row("SELECT attempts FROM mem_moments WHERE id = ?1", [id], |r| r.get(0).map_err(failed))?
            .ok_or_else(|| Error::not_found("moment", id))
    }

    fn skip_older(&self, before: i64, at: i64) -> Result<usize, Error> {
        self.exec(
            "UPDATE mem_moments SET state = 'skipped', done_at = ?2 WHERE state = 'pending' AND created_at < ?1",
            [before, at],
        )
    }

    fn prune_done(&self, before: i64) -> Result<usize, Error> {
        self.exec("DELETE FROM mem_moments WHERE state != 'pending' AND done_at < ?1", [before])
    }

    fn clear(&self) -> Result<(), Error> {
        self.exec("DELETE FROM mem_moments", []).map(drop)
    }
}

impl MemCursorRepo for SqliteTx<'_> {
    fn get(&self, key: &str) -> Result<Option<i64>, Error> {
        self.row("SELECT last_row FROM mem_cursors WHERE key = ?1", [key], |r| r.get(0).map_err(failed))
    }

    fn set(&self, key: &str, last_row: i64, at: i64) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO mem_cursors (key, last_row, updated_at) VALUES (?1, ?2, ?3)",
            params![key, last_row, at],
        )
        .map(drop)
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        self.exec("DELETE FROM mem_cursors WHERE key = ?1", [key]).map(drop)
    }
}

const USE_COLUMNS: &str = "id, note_id, worker_id, run_id, how, epoch, at, acted, outcome";

fn used(r: &rusqlite::Row<'_>) -> Result<StoredUse, Error> {
    let read = || -> rusqlite::Result<StoredUse> {
        Ok(StoredUse {
            id: r.get(0)?,
            note_id: r.get(1)?,
            worker_id: r.get(2)?,
            run_id: r.get(3)?,
            how: r.get(4)?,
            epoch: r.get(5)?,
            at: r.get(6)?,
            acted: r.get(7)?,
            outcome: r.get(8)?,
        })
    };
    read().map_err(failed)
}

impl MemUseRepo for SqliteTx<'_> {
    fn insert(&self, u: &StoredUse) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO mem_uses ({USE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
            params![u.id, u.note_id, u.worker_id, u.run_id, u.how, u.epoch, u.at, u.acted, u.outcome],
        )
        .map(drop)
    }

    fn of_worker(&self, worker_id: &str, epoch: i64) -> Result<Vec<StoredUse>, Error> {
        self.rows(
            &format!("SELECT {USE_COLUMNS} FROM mem_uses WHERE worker_id = ?1 AND epoch >= ?2 ORDER BY at, id"),
            params![worker_id, epoch],
            used,
        )
    }

    fn of_run(&self, run_id: &str) -> Result<Vec<StoredUse>, Error> {
        self.rows(&format!("SELECT {USE_COLUMNS} FROM mem_uses WHERE run_id = ?1 ORDER BY at, id"), [run_id], used)
    }

    fn times_of_note(&self, note_id: &str, limit: i64) -> Result<Vec<i64>, Error> {
        self.rows(
            "SELECT at FROM mem_uses WHERE note_id = ?1 ORDER BY at DESC LIMIT ?2",
            params![note_id, limit],
            |r| r.get(0).map_err(failed),
        )
    }

    fn set_acted(&self, id: &str) -> Result<(), Error> {
        self.exec("UPDATE mem_uses SET acted = 1 WHERE id = ?1", [id]).map(drop)
    }

    fn settle(&self, worker_id: Option<&str>, run_id: Option<&str>, outcome: &str) -> Result<usize, Error> {
        self.exec(
            "UPDATE mem_uses SET outcome = ?3 WHERE outcome IS NULL AND \
             ((?1 IS NOT NULL AND worker_id = ?1) OR (?2 IS NOT NULL AND run_id = ?2))",
            params![worker_id, run_id, outcome],
        )
    }

    fn prune(&self, before: i64) -> Result<usize, Error> {
        self.exec("DELETE FROM mem_uses WHERE at < ?1", [before])
    }

    fn clear(&self) -> Result<(), Error> {
        self.exec("DELETE FROM mem_uses", []).map(drop)
    }
}

fn forgotten(r: &rusqlite::Row<'_>) -> Result<StoredForgotten, Error> {
    let read = || -> rusqlite::Result<StoredForgotten> {
        Ok(StoredForgotten { note_id: r.get(0)?, fingerprint: r.get(1)?, snapshot: r.get(2)?, at: r.get(3)? })
    };
    read().map_err(failed)
}

impl MemBookRepo for SqliteTx<'_> {
    fn put_stated(&self, s: &StoredStated) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO mem_stated (memory_id, worker_id, row_id, at) VALUES (?1, ?2, ?3, ?4)",
            params![s.memory_id, s.worker_id, s.row_id, s.at],
        )
        .map(drop)
    }

    fn stated(&self) -> Result<Vec<StoredStated>, Error> {
        self.rows("SELECT memory_id, worker_id, row_id, at FROM mem_stated ORDER BY at DESC, memory_id", [], |r| {
            let read = || -> rusqlite::Result<StoredStated> {
                Ok(StoredStated { memory_id: r.get(0)?, worker_id: r.get(1)?, row_id: r.get(2)?, at: r.get(3)? })
            };
            read().map_err(failed)
        })
    }

    fn put_forgotten(&self, f: &StoredForgotten) -> Result<(), Error> {
        self.exec(
            "INSERT OR REPLACE INTO mem_forgotten (note_id, fingerprint, snapshot, at) VALUES (?1, ?2, ?3, ?4)",
            params![f.note_id, f.fingerprint, f.snapshot, f.at],
        )
        .map(drop)
    }

    fn forgotten(&self, note_id: &str) -> Result<Option<StoredForgotten>, Error> {
        self.row(
            "SELECT note_id, fingerprint, snapshot, at FROM mem_forgotten WHERE note_id = ?1",
            [note_id],
            forgotten,
        )
    }

    fn forgotten_since(&self, since: i64) -> Result<Vec<StoredForgotten>, Error> {
        self.rows(
            "SELECT note_id, fingerprint, snapshot, at FROM mem_forgotten WHERE at >= ?1 ORDER BY at DESC, note_id",
            [since],
            forgotten,
        )
    }

    fn remove_forgotten(&self, note_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM mem_forgotten WHERE note_id = ?1", [note_id]).map(drop)
    }

    fn prune_forgotten(&self, before: i64) -> Result<Vec<String>, Error> {
        let ids: Vec<String> =
            self.rows("SELECT note_id FROM mem_forgotten WHERE at < ?1 ORDER BY note_id", [before], |r| {
                r.get(0).map_err(failed)
            })?;
        self.exec("DELETE FROM mem_forgotten WHERE at < ?1", [before])?;
        Ok(ids)
    }

    fn setting(&self, key: &str) -> Result<Option<String>, Error> {
        self.row("SELECT value FROM mem_settings WHERE key = ?1", [key], |r| r.get(0).map_err(failed))
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<(), Error> {
        self.exec("INSERT OR REPLACE INTO mem_settings (key, value) VALUES (?1, ?2)", [key, value]).map(drop)
    }

    fn daily(&self, day: &str) -> Result<DailyCalls, Error> {
        self.row("SELECT classifier, reflections, night_calls FROM mem_daily WHERE day = ?1", [day], |r| {
            let read = || -> rusqlite::Result<DailyCalls> {
                Ok(DailyCalls { classifier: r.get(0)?, reflections: r.get(1)?, night_calls: r.get(2)? })
            };
            read().map_err(failed)
        })
        .map(Option::unwrap_or_default)
    }

    fn count_call(&self, day: &str, call: DailyCall) -> Result<DailyCalls, Error> {
        let column = match call {
            DailyCall::Classifier => "classifier",
            DailyCall::Reflection => "reflections",
            DailyCall::Night => "night_calls",
        };
        self.exec(
            &format!(
                "INSERT INTO mem_daily (day, {column}) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET {column} = {column} + 1"
            ),
            [day],
        )?;
        self.daily(day)
    }
}
