//! Tables of JSON documents: `worker_definitions`, `dream_*`, `transfers`,
//! `genui_views` (`SqliteRuntimeWorkerDefinitionStore.ts`, `SqliteDreamRepo.ts`,
//! `SqliteTransferRepo.ts`, `SqliteGenuiViewRepo.ts`).

use eos_contracts::{
    DreamCandidate, DreamRun, TransferRecord, Validate, ViewRecord, ViewState, WorkerDefinition, WorkerDefinitionRecord,
};
use eos_core::Error;
use eos_core::store::{DreamRepo, GenuiViewRepo, StoredViewState, TransferRepo, WorkerDefinitionRepo};
use eos_kit_sqlite::rusqlite::params;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::tx::{SqliteTx, failed};

/// A stored document as its type, or `None` when it no longer fits: the
/// row is skipped, as today.
fn document<T: DeserializeOwned + Validate>(json: &str) -> Option<T> {
    eos_contracts::parse(&serde_json::from_str::<Value>(json).ok()?).ok()
}

/// The document as JSON, and the fields kept beside it in their own columns.
fn encode<T: Serialize>(doc: &T, fields: &[&str]) -> Result<(String, Vec<Value>), Error> {
    let value = serde_json::to_value(doc).map_err(Error::storage)?;
    let picked = fields.iter().map(|f| value.get(f).cloned().unwrap_or(Value::Null)).collect();
    Ok((value.to_string(), picked))
}

fn text(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_default()
}

fn whole(value: &Value) -> i64 {
    value.as_f64().map_or(0, |n| n as i64)
}

impl SqliteTx<'_> {
    fn documents<T: DeserializeOwned + Validate>(
        &self,
        sql: &str,
        params: impl eos_kit_sqlite::rusqlite::Params,
    ) -> Result<Vec<T>, Error> {
        let stored: Vec<String> = self.rows(sql, params, |r| r.get(0).map_err(failed))?;
        Ok(stored.iter().filter_map(|json| document(json)).collect())
    }
}

impl WorkerDefinitionRepo for SqliteTx<'_> {
    fn create(&self, owner_id: &str, definition: &WorkerDefinition, now: i64) -> Result<(), Error> {
        let json = serde_json::to_string(definition).map_err(Error::storage)?;
        self.exec(
            "INSERT INTO worker_definitions (owner, name, json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) \
             ON CONFLICT(owner, name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
            params![owner_id, definition.name, json, now],
        )
        .map(drop)
    }

    fn list_for(&self, owner_id: &str) -> Result<Vec<WorkerDefinitionRecord>, Error> {
        let stored: Vec<WorkerDefinition> =
            self.documents("SELECT json FROM worker_definitions WHERE owner = ?1", [owner_id])?;
        // A record is the definition plus where it came from.
        Ok(stored
            .iter()
            .filter_map(|definition| {
                let mut record = serde_json::to_value(definition).ok()?;
                record.as_object_mut()?.insert("source".into(), "runtime".into());
                serde_json::from_value(record).ok()
            })
            .collect())
    }

    fn delete_for_owner(&self, owner_id: &str) -> Result<(), Error> {
        self.exec("DELETE FROM worker_definitions WHERE owner = ?1", [owner_id]).map(drop)
    }
}

impl DreamRepo for SqliteTx<'_> {
    fn save(&self, run: &DreamRun) -> Result<(), Error> {
        let (json, fields) = encode(run, &["id", "startedAt"])?;
        self.exec(
            "INSERT INTO dream_runs (id, started_at, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![text(&fields[0]), whole(&fields[1]), json],
        )
        .map(drop)
    }

    fn get(&self, id: &str) -> Result<Option<DreamRun>, Error> {
        Ok(self.documents("SELECT data FROM dream_runs WHERE id = ?1", [id])?.pop())
    }

    fn list(&self, limit: i64) -> Result<Vec<DreamRun>, Error> {
        self.documents("SELECT data FROM dream_runs ORDER BY started_at DESC LIMIT ?1", [limit])
    }

    fn watermark(&self, worker_id: &str) -> Result<i64, Error> {
        let found = self.row("SELECT last_event_id FROM dream_watermarks WHERE worker_id = ?1", [worker_id], |r| {
            r.get::<_, Option<i64>>(0).map_err(failed)
        })?;
        Ok(found.flatten().unwrap_or(0))
    }

    fn set_watermark(&self, worker_id: &str, event_id: i64) -> Result<(), Error> {
        self.exec(
            "INSERT INTO dream_watermarks (worker_id, last_event_id) VALUES (?1, ?2) \
             ON CONFLICT(worker_id) DO UPDATE SET last_event_id = excluded.last_event_id",
            params![worker_id, event_id],
        )
        .map(drop)
    }

    fn excluded(&self) -> Result<Vec<String>, Error> {
        self.rows("SELECT worker_id FROM dream_exclusions", [], |r| r.get(0).map_err(failed))
    }

    fn set_excluded(&self, worker_id: &str, excluded: bool) -> Result<(), Error> {
        let sql = if excluded {
            "INSERT INTO dream_exclusions (worker_id) VALUES (?1) ON CONFLICT(worker_id) DO NOTHING"
        } else {
            "DELETE FROM dream_exclusions WHERE worker_id = ?1"
        };
        self.exec(sql, [worker_id]).map(drop)
    }

    fn candidates(&self) -> Result<Vec<DreamCandidate>, Error> {
        self.documents("SELECT data FROM dream_candidates ORDER BY last_seen DESC", [])
    }

    fn replace_candidates(&self, candidates: &[DreamCandidate]) -> Result<(), Error> {
        self.exec("DELETE FROM dream_candidates", [])?;
        for candidate in candidates {
            let (json, fields) = encode(candidate, &["id", "lastSeen"])?;
            self.exec(
                "INSERT INTO dream_candidates (id, last_seen, data) VALUES (?1, ?2, ?3)",
                params![text(&fields[0]), whole(&fields[1]), json],
            )?;
        }
        Ok(())
    }
}

impl TransferRepo for SqliteTx<'_> {
    fn save(&self, transfer: &TransferRecord) -> Result<(), Error> {
        let (json, fields) = encode(transfer, &["id", "createdAt"])?;
        self.exec(
            "INSERT INTO transfers (id, created_at, data) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![text(&fields[0]), whole(&fields[1]), json],
        )
        .map(drop)
    }

    fn get(&self, id: &str) -> Result<Option<TransferRecord>, Error> {
        Ok(self.documents("SELECT data FROM transfers WHERE id = ?1", [id])?.pop())
    }

    fn list(&self, limit: i64) -> Result<Vec<TransferRecord>, Error> {
        self.documents("SELECT data FROM transfers ORDER BY created_at DESC LIMIT ?1", [limit])
    }

    fn remove(&self, ids: &[String]) -> Result<(), Error> {
        for id in ids {
            self.exec("DELETE FROM transfers WHERE id = ?1", [id])?;
        }
        Ok(())
    }
}

impl GenuiViewRepo for SqliteTx<'_> {
    fn save(&self, view: &ViewRecord) -> Result<(), Error> {
        // The row keeps the record's parts in columns and only the spec as JSON.
        let (_, f) = encode(view, &["id", "workerId", "kind", "title", "spec", "createdAt"])?;
        self.exec(
            "INSERT INTO genui_views (id, worker_id, kind, title, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, kind = excluded.kind, title = excluded.title, \
               data = excluded.data",
            params![text(&f[0]), text(&f[1]), text(&f[2]), text(&f[3]), f[4].to_string(), whole(&f[5])],
        )
        .map(drop)
    }

    fn get(&self, id: &str) -> Result<Option<ViewRecord>, Error> {
        type Stored = (String, String, String, String, String, i64);
        let stored: Option<Stored> = self.row(
            "SELECT id, worker_id, kind, title, data, created_at FROM genui_views WHERE id = ?1",
            [id],
            |r| {
                let read = || Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?));
                read().map_err(failed)
            },
        )?;
        Ok(stored.and_then(|(id, worker_id, kind, title, data, created_at)| {
            let spec: Value = serde_json::from_str(&data).ok()?;
            let record = serde_json::json!({
                "id": id, "workerId": worker_id, "kind": kind, "title": title, "createdAt": created_at, "spec": spec,
            });
            eos_contracts::parse(&record).ok()
        }))
    }

    fn get_state(&self, id: &str) -> Result<Option<StoredViewState>, Error> {
        let stored: Option<(String, i64)> =
            self.row("SELECT data, updated_at FROM genui_view_state WHERE id = ?1", [id], |r| {
                Ok((r.get(0).map_err(failed)?, r.get(1).map_err(failed)?))
            })?;
        Ok(stored
            .and_then(|(json, updated_at)| Some(StoredViewState { state: document::<ViewState>(&json)?, updated_at })))
    }

    fn put_state(&self, id: &str, state: &ViewState, at: i64) -> Result<(), Error> {
        let json = serde_json::to_string(state).map_err(Error::storage)?;
        self.exec(
            "INSERT INTO genui_view_state (id, data, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![id, json, at],
        )
        .map(drop)
    }

    fn remove_by_worker(&self, worker_id: &str) -> Result<(), Error> {
        self.exec(
            "DELETE FROM genui_view_state WHERE id IN (SELECT id FROM genui_views WHERE worker_id = ?1)",
            [worker_id],
        )?;
        self.exec("DELETE FROM genui_views WHERE worker_id = ?1", [worker_id]).map(drop)
    }
}
