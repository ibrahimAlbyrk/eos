//! `capability_installs`, `capability_versions` and `capability_calls`.

use eos_core::Error;
use eos_core::store::{
    CapabilityCallRepo, CapabilityInstallRepo, CapabilityVersionRepo, StoredCall, StoredCapabilityVersion,
    StoredInstall,
};
use eos_domain::capability::health::{Health, HealthState, StateCode};
use eos_kit_sqlite::rusqlite::{self, params};

use crate::tx::{SqliteTx, failed, known, known_or_null, wire_word, word};

const INSTALL_COLUMNS: &str = "id, origin, active_version, state, state_code, state_since, failures, settings_json, \
                               account_label, installed_at, updated_at";

fn install(r: &rusqlite::Row<'_>) -> Result<StoredInstall, Error> {
    let read = || -> rusqlite::Result<StoredInstall> {
        Ok(StoredInstall {
            id: r.get(0)?,
            origin: r.get(1)?,
            active_version: r.get(2)?,
            health: Health {
                state: known(r, 3, HealthState::parse)?,
                code: known_or_null(r, 4, StateCode::parse)?,
                failures: r.get(6)?,
            },
            state_since: r.get(5)?,
            settings_json: r.get(7)?,
            account_label: r.get(8)?,
            installed_at: r.get(9)?,
            updated_at: r.get(10)?,
        })
    };
    read().map_err(failed)
}

const VERSION_COLUMNS: &str = "capability_id, version, status, hash, manifest_json, source, tests_json, review_json, \
                               created_at, activated_at, retired_at";

fn version(r: &rusqlite::Row<'_>) -> Result<StoredCapabilityVersion, Error> {
    let read = || -> rusqlite::Result<StoredCapabilityVersion> {
        Ok(StoredCapabilityVersion {
            capability_id: r.get(0)?,
            version: r.get(1)?,
            status: r.get(2)?,
            hash: r.get(3)?,
            manifest_json: r.get(4)?,
            source: r.get(5)?,
            tests_json: r.get(6)?,
            review_json: r.get(7)?,
            created_at: r.get(8)?,
            activated_at: r.get(9)?,
            retired_at: r.get(10)?,
        })
    };
    read().map_err(failed)
}

const CALL_COLUMNS: &str = "id, capability_id, action, class, caller_kind, worker_id, run_id, version, started_at, \
                            duration_ms, outcome, error_kind";

fn call(r: &rusqlite::Row<'_>) -> Result<StoredCall, Error> {
    let read = || -> rusqlite::Result<StoredCall> {
        Ok(StoredCall {
            id: r.get(0)?,
            capability_id: r.get(1)?,
            action: r.get(2)?,
            class: wire_word(r, 3)?,
            caller_kind: r.get(4)?,
            worker_id: r.get(5)?,
            run_id: r.get(6)?,
            version: r.get(7)?,
            started_at: r.get(8)?,
            duration_ms: r.get(9)?,
            outcome: r.get(10)?,
            error_kind: r.get(11)?,
        })
    };
    read().map_err(failed)
}

impl CapabilityInstallRepo for SqliteTx<'_> {
    fn put(&self, install: &StoredInstall) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO capability_installs ({INSTALL_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
                 ?10, ?11) ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, \
                 active_version = excluded.active_version, state = excluded.state, \
                 state_code = excluded.state_code, state_since = excluded.state_since, \
                 failures = excluded.failures, settings_json = excluded.settings_json, \
                 account_label = excluded.account_label, installed_at = excluded.installed_at, \
                 updated_at = excluded.updated_at"
            ),
            params![
                install.id,
                install.origin,
                install.active_version,
                install.health.state.as_str(),
                install.health.code.as_ref().map(StateCode::as_string),
                install.state_since,
                install.health.failures,
                install.settings_json,
                install.account_label,
                install.installed_at,
                install.updated_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, id: &str) -> Result<Option<StoredInstall>, Error> {
        self.row(&format!("SELECT {INSTALL_COLUMNS} FROM capability_installs WHERE id = ?1"), [id], install)
    }

    fn list(&self) -> Result<Vec<StoredInstall>, Error> {
        self.rows(&format!("SELECT {INSTALL_COLUMNS} FROM capability_installs ORDER BY id"), [], install)
    }
}

impl CapabilityVersionRepo for SqliteTx<'_> {
    fn insert(&self, version: &StoredCapabilityVersion) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO capability_versions ({VERSION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
                 ?10, ?11)"
            ),
            params![
                version.capability_id,
                version.version,
                version.status,
                version.hash,
                version.manifest_json,
                version.source,
                version.tests_json,
                version.review_json,
                version.created_at,
                version.activated_at,
                version.retired_at,
            ],
        )
        .map(drop)
    }

    fn find(&self, capability_id: &str, version_name: &str) -> Result<Option<StoredCapabilityVersion>, Error> {
        self.row(
            &format!("SELECT {VERSION_COLUMNS} FROM capability_versions WHERE capability_id = ?1 AND version = ?2"),
            [capability_id, version_name],
            version,
        )
    }

    fn of_capability(&self, capability_id: &str) -> Result<Vec<StoredCapabilityVersion>, Error> {
        self.rows(
            &format!(
                "SELECT {VERSION_COLUMNS} FROM capability_versions WHERE capability_id = ?1 \
                 ORDER BY created_at DESC, rowid DESC"
            ),
            [capability_id],
            version,
        )
    }
}

impl CapabilityCallRepo for SqliteTx<'_> {
    fn insert(&self, call: &StoredCall) -> Result<(), Error> {
        self.exec(
            &format!(
                "INSERT INTO capability_calls ({CALL_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
                 ?11, ?12)"
            ),
            params![
                call.id,
                call.capability_id,
                call.action,
                word(&call.class)?,
                call.caller_kind,
                call.worker_id,
                call.run_id,
                call.version,
                call.started_at,
                call.duration_ms,
                call.outcome,
                call.error_kind,
            ],
        )
        .map(drop)
    }

    fn recent(&self, capability_id: &str, limit: i64) -> Result<Vec<StoredCall>, Error> {
        self.rows(
            &format!(
                "SELECT {CALL_COLUMNS} FROM capability_calls WHERE capability_id = ?1 \
                 ORDER BY started_at DESC, rowid DESC LIMIT ?2"
            ),
            params![capability_id, limit],
            call,
        )
    }

    fn prune(&self, before: i64, keep: i64) -> Result<usize, Error> {
        let old = self.exec("DELETE FROM capability_calls WHERE started_at < ?1", [before])?;
        let over = self.exec(
            "DELETE FROM capability_calls WHERE rowid IN \
             (SELECT rowid FROM capability_calls ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?1)",
            [keep],
        )?;
        Ok(old + over)
    }
}
