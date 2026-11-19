//! `signal_sources`, `signals`, `signal_routes`, `signal_schedules` and
//! `signal_runners`.

use eos_core::Error;
use eos_core::store::{
    BatchedSignal, ManualSignal, NewSignal, SignalRepo, SignalRouteRepo, SignalRunnerRepo, SignalScheduleRepo,
    SignalSourceRepo, SignalTally, StoredSignal, StoredSignalRoute, StoredSignalRunner, StoredSignalSchedule,
    StoredSignalSource,
};
use eos_domain::routine::run::RunState;
use eos_domain::signals::decision::Decision;
use eos_domain::signals::key;
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known};

const SOURCE_COLUMNS: &str = "id, kind, source, scope_json, scope_hash, cursor_json, state, error_kind, failures, \
                              interval_ms, last_poll_at, next_poll_at, last_signal_at, catch_up_json, stopped_at, \
                              created_at, updated_at";

fn source(r: &rusqlite::Row<'_>) -> Result<StoredSignalSource, Error> {
    let read = || -> rusqlite::Result<StoredSignalSource> {
        Ok(StoredSignalSource {
            id: r.get(0)?,
            kind: r.get(1)?,
            source: r.get(2)?,
            scope_json: r.get(3)?,
            scope_hash: r.get(4)?,
            cursor_json: r.get(5)?,
            state: r.get(6)?,
            error_kind: r.get(7)?,
            failures: r.get(8)?,
            interval_ms: r.get(9)?,
            last_poll_at: r.get(10)?,
            next_poll_at: r.get(11)?,
            last_signal_at: r.get(12)?,
            catch_up_json: r.get(13)?,
            stopped_at: r.get(14)?,
            created_at: r.get(15)?,
            updated_at: r.get(16)?,
        })
    };
    read().map_err(failed)
}

/// What `signals.state` says before and after routing.
const RECEIVED: &str = "received";
const ROUTED: &str = "routed";

const SIGNAL_COLUMNS: &str = "id, source_id, key, subject, version, kind, occurred_at, received_at, facts_json, \
                              item_json, depth, state";

fn signal(r: &rusqlite::Row<'_>) -> Result<StoredSignal, Error> {
    let read = || -> rusqlite::Result<StoredSignal> {
        Ok(StoredSignal {
            id: r.get(0)?,
            signal: NewSignal {
                source_id: r.get(1)?,
                key: r.get(2)?,
                subject: r.get(3)?,
                version: r.get(4)?,
                kind: r.get(5)?,
                occurred_at: r.get(6)?,
                received_at: r.get(7)?,
                facts_json: r.get(8)?,
                item_json: r.get(9)?,
                depth: r.get(10)?,
            },
            routed: known(r, 11, |state| match state {
                RECEIVED => Some(false),
                ROUTED => Some(true),
                _ => None,
            })?,
        })
    };
    read().map_err(failed)
}

const ROUTE_COLUMNS: &str = "signal_id, routine_id, routine_version, decision, reason, run_id, model_asked, decided_at";

fn route(r: &rusqlite::Row<'_>) -> Result<StoredSignalRoute, Error> {
    let read = || -> rusqlite::Result<StoredSignalRoute> {
        Ok(StoredSignalRoute {
            signal_id: r.get(0)?,
            routine_id: r.get(1)?,
            routine_version: r.get(2)?,
            decision: known(r, 3, Decision::parse)?,
            reason: r.get(4)?,
            run_id: r.get(5)?,
            model_asked: r.get(6)?,
            decided_at: r.get(7)?,
        })
    };
    read().map_err(failed)
}

const SCHEDULE_COLUMNS: &str =
    "routine_id, slot, spec_hash, zone, armed_at, last_slot_at, next_at, missed, late_by_ms, updated_at";

fn schedule(r: &rusqlite::Row<'_>) -> Result<StoredSignalSchedule, Error> {
    let read = || -> rusqlite::Result<StoredSignalSchedule> {
        Ok(StoredSignalSchedule {
            routine_id: r.get(0)?,
            slot: r.get(1)?,
            spec_hash: r.get(2)?,
            zone: r.get(3)?,
            armed_at: r.get(4)?,
            last_slot_at: r.get(5)?,
            next_at: r.get(6)?,
            missed: r.get(7)?,
            late_by_ms: r.get(8)?,
            updated_at: r.get(9)?,
        })
    };
    read().map_err(failed)
}

const RUNNER_COLUMNS: &str = "routine_id, holder_device, epoch, seen_seq, seen_at, handoff_json";

fn runner(r: &rusqlite::Row<'_>) -> Result<StoredSignalRunner, Error> {
    let read = || -> rusqlite::Result<StoredSignalRunner> {
        Ok(StoredSignalRunner {
            routine_id: r.get(0)?,
            holder_device: r.get(1)?,
            epoch: r.get(2)?,
            seen_seq: r.get(3)?,
            seen_at: r.get(4)?,
            handoff_json: r.get(5)?,
        })
    };
    read().map_err(failed)
}

impl SignalSourceRepo for SqliteTx<'_> {
    fn insert(&self, source: &StoredSignalSource) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO signal_sources ({SOURCE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                 ?12, ?13, ?14, ?15, ?16, ?17)"
            ),
            params![
                source.id,
                source.kind,
                source.source,
                source.scope_json,
                source.scope_hash,
                source.cursor_json,
                source.state,
                source.error_kind,
                source.failures,
                source.interval_ms,
                source.last_poll_at,
                source.next_poll_at,
                source.last_signal_at,
                source.catch_up_json,
                source.stopped_at,
                source.created_at,
                source.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredSignalSource>, Error> {
        self.row(&format!("SELECT {SOURCE_COLUMNS} FROM signal_sources WHERE id = ?1"), [id], source)
    }

    fn by_scope(&self, scope_hash: &str) -> Result<Option<StoredSignalSource>, Error> {
        self.row(&format!("SELECT {SOURCE_COLUMNS} FROM signal_sources WHERE scope_hash = ?1"), [scope_hash], source)
    }

    fn update(&self, source: &StoredSignalSource) -> Result<(), Error> {
        self.exec(
            "UPDATE signal_sources SET kind = ?2, source = ?3, scope_json = ?4, scope_hash = ?5, cursor_json = ?6, \
             state = ?7, error_kind = ?8, failures = ?9, interval_ms = ?10, last_poll_at = ?11, next_poll_at = ?12, \
             last_signal_at = ?13, catch_up_json = ?14, stopped_at = ?15, updated_at = ?16 WHERE id = ?1",
            params![
                source.id,
                source.kind,
                source.source,
                source.scope_json,
                source.scope_hash,
                source.cursor_json,
                source.state,
                source.error_kind,
                source.failures,
                source.interval_ms,
                source.last_poll_at,
                source.next_poll_at,
                source.last_signal_at,
                source.catch_up_json,
                source.stopped_at,
                source.updated_at,
            ],
        )
        .map(drop)
    }
}

impl SqliteTx<'_> {
    /// Inserts a signal in `state`; `None` when its source has the key.
    fn insert_signal(&self, signal: &NewSignal, state: &str) -> Result<Option<i64>, Error> {
        let inserted = self.exec(
            "INSERT INTO signals (source_id, key, subject, version, kind, occurred_at, received_at, facts_json, \
             item_json, depth, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
             ON CONFLICT (source_id, key) DO NOTHING",
            params![
                signal.source_id,
                signal.key,
                signal.subject,
                signal.version,
                signal.kind,
                signal.occurred_at,
                signal.received_at,
                signal.facts_json,
                signal.item_json,
                signal.depth,
                state,
            ],
        )?;
        Ok((inserted > 0).then(|| self.conn.last_insert_rowid()))
    }
}

impl SignalRepo for SqliteTx<'_> {
    fn ingest(&self, signal: &NewSignal) -> Result<Option<i64>, Error> {
        self.insert_signal(signal, RECEIVED)
    }

    fn insert_manual(&self, manual: &ManualSignal) -> Result<i64, Error> {
        let signal = NewSignal {
            source_id: manual.source_id.clone(),
            key: key::manual(&manual.run_id),
            subject: manual.subject.clone(),
            version: manual.version.clone(),
            kind: "manual".to_owned(),
            occurred_at: manual.at,
            received_at: manual.at,
            facts_json: None,
            item_json: manual.item_json.clone(),
            depth: 0,
        };
        // A run id is new, so its key is too: a second signal for one run is a bug.
        let id = self
            .insert_signal(&signal, ROUTED)?
            .ok_or_else(|| Error::Storage("the run has a signal already".to_owned()))?;
        SignalRouteRepo::insert(
            self,
            &StoredSignalRoute {
                signal_id: id,
                routine_id: manual.routine_id.clone(),
                routine_version: manual.routine_version.clone(),
                decision: Decision::Run,
                reason: None,
                run_id: Some(manual.run_id.clone()),
                model_asked: false,
                decided_at: manual.at,
            },
        )?;
        Ok(id)
    }

    fn find(&self, id: i64) -> Result<Option<StoredSignal>, Error> {
        self.row(&format!("SELECT {SIGNAL_COLUMNS} FROM signals WHERE id = ?1"), [id], signal)
    }

    fn received(&self, limit: i64) -> Result<Vec<StoredSignal>, Error> {
        self.rows(
            &format!("SELECT {SIGNAL_COLUMNS} FROM signals WHERE state = ?1 ORDER BY id LIMIT ?2"),
            params![RECEIVED, limit],
            signal,
        )
    }

    fn mark_routed(&self, id: i64) -> Result<(), Error> {
        self.exec("UPDATE signals SET state = ?2 WHERE id = ?1", params![id, ROUTED]).map(drop)
    }

    fn received_count(&self) -> Result<i64, Error> {
        self.row("SELECT COUNT(*) FROM signals WHERE state = ?1", [RECEIVED], |r| r.get(0).map_err(failed))
            .map(Option::unwrap_or_default)
    }

    fn page(
        &self,
        routine: Option<&str>,
        decision: Option<Decision>,
        before: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredSignal>, Error> {
        let decision = decision.map(Decision::as_str);
        self.rows(
            &format!(
                "SELECT {SIGNAL_COLUMNS} FROM signals s WHERE (?1 IS NULL OR s.id < ?1) \
                 AND ((?2 IS NULL AND ?3 IS NULL) OR EXISTS (SELECT 1 FROM signal_routes r \
                 WHERE r.signal_id = s.id AND (?2 IS NULL OR r.routine_id = ?2) AND (?3 IS NULL OR r.decision = ?3))) \
                 ORDER BY s.id DESC LIMIT ?4"
            ),
            params![before, routine, decision, limit],
            signal,
        )
    }
}

impl SignalRouteRepo for SqliteTx<'_> {
    fn insert(&self, route: &StoredSignalRoute) -> Result<(), Error> {
        self.exec(
            &format!("INSERT INTO signal_routes ({ROUTE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
            params![
                route.signal_id,
                route.routine_id,
                route.routine_version,
                route.decision.as_str(),
                route.reason,
                route.run_id,
                route.model_asked,
                route.decided_at,
            ],
        )
        .map(drop)
    }

    fn put(&self, route: &StoredSignalRoute) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO signal_routes ({ROUTE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT (signal_id, routine_id) DO UPDATE SET routine_version = excluded.routine_version, \
                 decision = excluded.decision, reason = excluded.reason, run_id = excluded.run_id, \
                 model_asked = excluded.model_asked, decided_at = excluded.decided_at"
            ),
            params![
                route.signal_id,
                route.routine_id,
                route.routine_version,
                route.decision.as_str(),
                route.reason,
                route.run_id,
                route.model_asked,
                route.decided_at,
            ],
        )
        .map(drop)
    }

    fn tally(&self, routine_id: &str, since: i64) -> Result<Vec<SignalTally>, Error> {
        self.rows(
            "SELECT r.decision, u.state, COUNT(*) FROM signal_routes r LEFT JOIN runs u ON u.id = r.run_id \
             WHERE r.routine_id = ?1 AND r.decided_at >= ?2 GROUP BY r.decision, u.state ORDER BY r.decision, u.state",
            params![routine_id, since],
            |r| {
                let read = || -> rusqlite::Result<SignalTally> {
                    let state: Option<String> = r.get(1)?;
                    Ok(SignalTally {
                        decision: known(r, 0, Decision::parse)?,
                        run_state: state.as_deref().and_then(RunState::parse),
                        signals: r.get(2)?,
                    })
                };
                read().map_err(failed)
            },
        )
    }

    fn by_signal(&self, signal_id: i64) -> Result<Vec<StoredSignalRoute>, Error> {
        self.rows(
            &format!("SELECT {ROUTE_COLUMNS} FROM signal_routes WHERE signal_id = ?1 ORDER BY routine_id"),
            [signal_id],
            route,
        )
    }

    fn runs_of_subject(&self, routine_id: &str, subject: &str) -> Result<Vec<String>, Error> {
        self.rows(
            "SELECT r.run_id FROM signal_routes r JOIN signals s ON s.id = r.signal_id \
             WHERE r.routine_id = ?1 AND s.subject = ?2 AND r.decision = ?3 AND r.run_id IS NOT NULL \
             ORDER BY r.signal_id",
            params![routine_id, subject, Decision::Run.as_str()],
            |r| r.get(0).map_err(failed),
        )
    }

    fn open_batch(&self, routine_id: &str) -> Result<Vec<BatchedSignal>, Error> {
        self.rows(
            "SELECT r.signal_id, r.decided_at, s.item_json FROM signal_routes r JOIN signals s ON s.id = r.signal_id \
             WHERE r.routine_id = ?1 AND r.decision = ?2 AND r.run_id IS NULL ORDER BY r.signal_id",
            params![routine_id, Decision::Batched.as_str()],
            |r| {
                let read = || -> rusqlite::Result<BatchedSignal> {
                    Ok(BatchedSignal { signal_id: r.get(0)?, decided_at: r.get(1)?, item_json: r.get(2)? })
                };
                read().map_err(failed)
            },
        )
    }

    fn set_run(&self, routine_id: &str, signal_ids: &[i64], run_id: &str) -> Result<(), Error> {
        for signal_id in signal_ids {
            self.exec(
                "UPDATE signal_routes SET run_id = ?3 WHERE signal_id = ?1 AND routine_id = ?2",
                params![signal_id, routine_id, run_id],
            )?;
        }
        Ok(())
    }

    fn count_since(&self, routine_id: &str, decision: Decision, since: i64) -> Result<i64, Error> {
        self.row(
            "SELECT COUNT(*) FROM signal_routes WHERE routine_id = ?1 AND decision = ?2 AND decided_at >= ?3",
            params![routine_id, decision.as_str(), since],
            |r| r.get(0).map_err(failed),
        )
        .map(Option::unwrap_or_default)
    }
}

impl SignalScheduleRepo for SqliteTx<'_> {
    fn put(&self, schedule: &StoredSignalSchedule) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO signal_schedules ({SCHEDULE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
                 ON CONFLICT (routine_id, slot) DO UPDATE SET spec_hash = excluded.spec_hash, \
                 zone = excluded.zone, armed_at = excluded.armed_at, last_slot_at = excluded.last_slot_at, \
                 next_at = excluded.next_at, missed = excluded.missed, late_by_ms = excluded.late_by_ms, \
                 updated_at = excluded.updated_at"
            ),
            params![
                schedule.routine_id,
                schedule.slot,
                schedule.spec_hash,
                schedule.zone,
                schedule.armed_at,
                schedule.last_slot_at,
                schedule.next_at,
                schedule.missed,
                schedule.late_by_ms,
                schedule.updated_at,
            ],
        )
        .map(drop)
    }

    fn of_routine(&self, routine_id: &str) -> Result<Vec<StoredSignalSchedule>, Error> {
        self.rows(
            &format!("SELECT {SCHEDULE_COLUMNS} FROM signal_schedules WHERE routine_id = ?1 ORDER BY slot"),
            [routine_id],
            schedule,
        )
    }
}

impl SignalRunnerRepo for SqliteTx<'_> {
    fn put(&self, runner: &StoredSignalRunner) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO signal_runners ({RUNNER_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT (routine_id) DO UPDATE SET holder_device = excluded.holder_device, \
                 epoch = excluded.epoch, seen_seq = excluded.seen_seq, seen_at = excluded.seen_at, \
                 handoff_json = excluded.handoff_json"
            ),
            params![
                runner.routine_id,
                runner.holder_device,
                runner.epoch,
                runner.seen_seq,
                runner.seen_at,
                runner.handoff_json,
            ],
        )
        .map(drop)
    }

    fn find(&self, routine_id: &str) -> Result<Option<StoredSignalRunner>, Error> {
        self.row(&format!("SELECT {RUNNER_COLUMNS} FROM signal_runners WHERE routine_id = ?1"), [routine_id], runner)
    }
}
