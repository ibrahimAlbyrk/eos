//! The domain `routine`: each routine and its kept versions.

use std::sync::Arc;

use eos_contracts::{RoutineChangeReason, RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::net::sync::RecordSync;
use eos_core::store::{Outbox, StoredRoutine, StoredVersion, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::blueprint::{self, hash};
use eos_domain::run_scope::Trust;
use eos_domain::sync::SyncItem;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{refused, travels};
use crate::engine::{Engine, announce_routine, delete};
use crate::routes::BUILTIN;

/// The origin of a routine that came from another computer.
const SYNC: &str = "sync";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutineRecord {
    slug: String,
    name: String,
    kind: RoutineKind,
    state: RoutineState,
    paused_reason: Option<String>,
    head: String,
    agents_may_start: bool,
    created_at: i64,
    changed_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionRecord {
    parent_id: Option<String>,
    author: VersionAuthor,
    note: Option<String>,
    format: i64,
    /// The canonical JSON, as stored.
    blueprint: String,
    hash: String,
    no_trial: bool,
    trust: String,
    device: Option<String>,
    created_at: i64,
}

pub(crate) struct RoutineRecords(pub(crate) Arc<Engine>);

fn routine_item(routine: &StoredRoutine) -> Result<SyncItem, Error> {
    let record = RoutineRecord {
        slug: routine.slug.clone(),
        name: routine.name.clone(),
        kind: routine.kind,
        state: routine.state,
        paused_reason: routine.paused_reason.clone(),
        head: routine.head_version_id.clone().unwrap_or_default(),
        agents_may_start: routine.agents_may_start,
        created_at: routine.created_at,
        changed_at: routine.changed_at,
        deleted_at: routine.deleted_at,
    };
    let data = serde_json::to_value(record).map_err(Error::storage)?;
    Ok(SyncItem { id: routine.id.clone(), data, updated_at: Some(routine.changed_at as f64) })
}

fn version_item(version: &StoredVersion) -> Result<SyncItem, Error> {
    let record = VersionRecord {
        parent_id: version.parent_id.clone(),
        author: version.author,
        note: version.note.clone(),
        format: version.format,
        blueprint: version.blueprint.clone(),
        hash: version.hash.clone(),
        no_trial: version.no_trial,
        trust: version.trust.as_str().to_owned(),
        device: version.device.clone(),
        created_at: version.created_at,
    };
    let data = serde_json::to_value(record).map_err(Error::storage)?;
    let id = format!("{}/{}", version.routine_id, version.id);
    Ok(SyncItem { id, data, updated_at: Some(version.created_at as f64) })
}

/// The routine's records: its kept versions first, so a computer that
/// reads them in order finds the head before the routine names it.
fn items_of(tx: &dyn Tx, routine: &StoredRoutine) -> Result<Vec<SyncItem>, Error> {
    let mut items = Vec::new();
    for version in tx.routine_versions().list(&routine.id)? {
        if version.status == VersionStatus::Kept {
            items.push(version_item(&version)?);
        }
    }
    items.push(routine_item(routine)?);
    Ok(items)
}

fn get_in(tx: &dyn Tx, id: &str) -> Result<Option<SyncItem>, Error> {
    let (routine_id, version_id) = match id.split_once('/') {
        Some((routine_id, version_id)) => (routine_id, Some(version_id)),
        None => (id, None),
    };
    let Some(routine) = tx.routines().find(routine_id)?.filter(travels) else { return Ok(None) };
    match version_id {
        None => routine_item(&routine).map(Some),
        Some(version_id) => tx
            .routine_versions()
            .find(routine_id, version_id)?
            .filter(|version| version.status == VersionStatus::Kept)
            .map(|version| version_item(&version))
            .transpose(),
    }
}

/// A slug no other live routine has: the newer of two gets `-2` (01 G35).
fn free_slug(tx: &dyn Tx, routine_id: &str, slug: &str) -> Result<String, Error> {
    let taken: Vec<String> = tx
        .routines()
        .list()?
        .into_iter()
        .filter(|other| {
            other.id != routine_id && !matches!(other.state, RoutineState::Deleted | RoutineState::Transient)
        })
        .map(|other| other.slug)
        .collect();
    let mut candidate = slug.to_owned();
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = format!("{slug}-{n}");
        n += 1;
    }
    Ok(candidate)
}

fn apply_routine_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    engine: &Engine,
    id: &str,
    record: &RoutineRecord,
    now: i64,
) -> Result<(), Error> {
    let at = record.changed_at;
    let reason = match tx.routines().find(id)? {
        Some(local) if local.origin == BUILTIN => {
            return Err(refused("a built-in routine never comes through sync"));
        }
        None => {
            tx.routines().insert(&StoredRoutine {
                id: id.to_owned(),
                slug: free_slug(tx, id, &record.slug)?,
                name: record.name.clone(),
                kind: record.kind,
                state: record.state,
                paused_reason: record.paused_reason.clone(),
                head_version_id: Some(record.head.clone()),
                origin: SYNC.to_owned(),
                task_key: None,
                agents_may_start: record.agents_may_start,
                failure_streak: 0,
                created_at: record.created_at,
                updated_at: now,
                changed_at: at,
                started_at: None,
                deleted_at: record.deleted_at,
            })?;
            RoutineChangeReason::Created
        }
        Some(local) => {
            let routines = tx.routines();
            if local.name != record.name {
                routines.set_name(id, &record.name, at)?;
            }
            if local.kind != record.kind {
                routines.set_kind(id, record.kind, at)?;
            }
            if local.head_version_id.as_deref() != Some(record.head.as_str()) {
                routines.set_head(id, &record.head, at)?;
            }
            routines.set_deleted_at(id, record.deleted_at, at)?;
            routines.set_state(id, record.state, record.paused_reason.as_deref(), at)?;
            if local.head_version_id.as_deref() != Some(record.head.as_str()) {
                RoutineChangeReason::Version
            } else {
                RoutineChangeReason::State
            }
        }
    };
    announce_routine(tx, out, id, reason, now, &engine.patterns)
}

fn apply_version_in(tx: &dyn Tx, routine_id: &str, version_id: &str, record: &VersionRecord) -> Result<(), Error> {
    if let Some(local) = tx.routine_versions().find(routine_id, version_id)? {
        // A kept version never changes: the same one again is no change.
        return if local.hash == record.hash { Ok(()) } else { Err(refused("a kept version never changes")) };
    }
    if hash(&record.blueprint) != record.hash {
        return Err(refused("the version's blueprint does not match its hash"));
    }
    let json: Value = serde_json::from_str(&record.blueprint).map_err(|_| refused("the blueprint is not JSON"))?;
    // A newer format is kept readable and not runnable (01 G36); a known one must be a blueprint.
    blueprint::read(&json).map_err(|_| refused("the version holds no blueprint"))?;
    let trust = Trust::parse(&record.trust).ok_or_else(|| refused("trust: unknown word"))?;
    tx.routine_versions().insert(&StoredVersion {
        id: version_id.to_owned(),
        routine_id: routine_id.to_owned(),
        parent_id: record.parent_id.clone(),
        status: VersionStatus::Kept,
        author: record.author,
        note: record.note.clone(),
        format: record.format,
        blueprint: record.blueprint.clone(),
        hash: record.hash.clone(),
        no_trial: record.no_trial,
        trust,
        device: record.device.clone(),
        created_at: record.created_at,
    })
}

impl RoutineRecords {
    async fn apply_now(&self, id: &str, data: &Value) -> Result<(), Error> {
        let engine = self.0.clone();
        if let Some((routine_id, version_id)) = id.split_once('/') {
            let record: VersionRecord = serde_json::from_value(data.clone()).map_err(refused)?;
            let (routine_id, version_id) = (routine_id.to_owned(), version_id.to_owned());
            let now = engine.clock.now_ms();
            let patterns = engine.patterns.clone();
            return engine
                .store
                .write(move |tx, out| {
                    apply_version_in(tx, &routine_id, &version_id, &record)?;
                    // The routine named it its head before it came.
                    match tx.routines().find(&routine_id)? {
                        Some(routine) if routine.head_version_id.as_deref() == Some(version_id.as_str()) => {
                            announce_routine(tx, out, &routine_id, RoutineChangeReason::Version, now, &patterns)
                        }
                        _ => Ok(()),
                    }
                })
                .await;
        }
        let record: RoutineRecord = serde_json::from_value(data.clone()).map_err(refused)?;
        let local = engine.store.read({
            let id = id.to_owned();
            move |tx| tx.routines().find(&id)
        });
        // Deleted on the other computer: its runs here stop as a delete here would stop them.
        if record.state == RoutineState::Deleted
            && local.await?.is_some_and(|local| local.state != RoutineState::Deleted)
        {
            delete(&engine, id).await?;
        }
        let (id, now) = (id.to_owned(), engine.clock.now_ms());
        let writer = engine.clone();
        engine.store.write(move |tx, out| apply_routine_in(tx, out, &writer, &id, &record, now)).await?;
        engine.wake.notify_one();
        Ok(())
    }

    /// Gone for good on the other computer: here it goes to Recently
    /// deleted, which clears it in its time.
    async fn remove_now(&self, id: &str) -> Result<(), Error> {
        if id.contains('/') {
            return Ok(());
        }
        let found = self.0.store.read({
            let id = id.to_owned();
            move |tx| tx.routines().find(&id)
        });
        match found.await? {
            Some(local) if travels(&local) && local.state != RoutineState::Deleted => {
                delete(&self.0, id).await.map(drop)
            }
            _ => Ok(()),
        }
    }
}

impl RecordSync for RoutineRecords {
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(self.0.store.read(|tx| {
            let mut items = Vec::new();
            for routine in tx.routines().list()?.iter().filter(|routine| travels(routine)) {
                items.extend(items_of(tx, routine)?);
            }
            Ok(items)
        }))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let id = id.to_owned();
        Box::pin(self.0.store.read(move |tx| get_in(tx, &id)))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.apply_now(id, data))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.remove_now(id))
    }
}
