//! The domain `surface` (05 G28): each surface of a routine that travels
//! (`<sf>`), every version it kept (`<sf>/v<n>`, its design never changed
//! once written) and its saved state (`<sf>/state`). Pins, issues,
//! candidates and the record of actions stay on their computer.

use std::sync::Arc;

use eos_contracts::{SurfacesChange, SurfacesState};
use eos_core::net::sync::RecordSync;
use eos_core::store::{Outbox, Store, StoredSurface, StoredSurfaceState, StoredSurfaceVersion, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use eos_surface::{Level, MadeBy, Place, Role, VersionStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{SURFACES_CHANGE, SURFACES_STATE};

/// The scope of the state that belongs to the whole surface.
const WHOLE: &str = "";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceRecord {
    routine_id: String,
    level: String,
    place: String,
    role: String,
    title: String,
    current_version: Option<i64>,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionRecord {
    status: String,
    base_version: Option<i64>,
    made_by: String,
    note: String,
    body_json: String,
    checks_json: String,
    created_at: i64,
    kept_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateRecord {
    data_json: String,
    updated_at: i64,
}

pub(crate) struct SurfaceRecords(pub(crate) Arc<dyn Store>);

fn refused(what: impl std::fmt::Display) -> Error {
    Error::Validation(what.to_string())
}

fn word<T>(parse: fn(&str) -> Option<T>, text: &str, what: &str) -> Result<T, Error> {
    parse(text).ok_or_else(|| refused(format!("{what}: unknown word")))
}

/// What travels of a version: one the user kept, now or before.
fn kept(version: &StoredSurfaceVersion) -> bool {
    matches!(version.status, VersionStatus::Kept | VersionStatus::Superseded)
}

fn travels(tx: &dyn Tx, surface: &StoredSurface) -> Result<bool, Error> {
    Ok(tx.routines().find(&surface.routine_id)?.is_some_and(|routine| routine.travels()))
}

fn item(id: String, record: &impl Serialize, at: i64) -> Result<SyncItem, Error> {
    Ok(SyncItem { id, data: serde_json::to_value(record).map_err(Error::storage)?, updated_at: Some(at as f64) })
}

fn surface_item(surface: &StoredSurface) -> Result<SyncItem, Error> {
    let record = SurfaceRecord {
        routine_id: surface.routine_id.clone(),
        level: surface.level.as_str().to_owned(),
        place: surface.place.as_str().to_owned(),
        role: surface.role.as_str().to_owned(),
        title: surface.title.clone(),
        current_version: surface.current_version,
        archived_at: surface.archived_at,
        created_at: surface.created_at,
        updated_at: surface.updated_at,
    };
    item(surface.id.clone(), &record, surface.updated_at)
}

fn version_item(version: &StoredSurfaceVersion) -> Result<SyncItem, Error> {
    let record = VersionRecord {
        status: version.status.as_str().to_owned(),
        base_version: version.base_version,
        made_by: version.made_by.as_str().to_owned(),
        note: version.note.clone(),
        body_json: version.body_json.clone(),
        checks_json: version.checks_json.clone(),
        created_at: version.created_at,
        kept_at: version.kept_at,
    };
    let at = version.kept_at.unwrap_or(version.created_at);
    item(format!("{}/v{}", version.surface_id, version.version), &record, at)
}

fn state_item(state: &StoredSurfaceState) -> Result<SyncItem, Error> {
    let record = StateRecord { data_json: state.data_json.clone(), updated_at: state.updated_at };
    item(format!("{}/state", state.surface_id), &record, state.updated_at)
}

/// A record's id: the surface's, and what of it.
enum Of<'a> {
    Surface(&'a str),
    Version(&'a str, i64),
    State(&'a str),
}

fn of(id: &str) -> Result<Of<'_>, Error> {
    match id.split_once('/') {
        None => Ok(Of::Surface(id)),
        Some((surface, "state")) => Ok(Of::State(surface)),
        Some((surface, version)) => version
            .strip_prefix('v')
            .and_then(|n| n.parse().ok())
            .map(|n| Of::Version(surface, n))
            .ok_or_else(|| refused("no such record of a surface")),
    }
}

fn items_of(tx: &dyn Tx, surface: &StoredSurface) -> Result<Vec<SyncItem>, Error> {
    let mut items = Vec::new();
    let mut versions = tx.surface_versions().of_surface(&surface.id)?;
    versions.reverse();
    for version in versions.iter().filter(|version| kept(version)) {
        items.push(version_item(version)?);
    }
    items.push(surface_item(surface)?);
    if let Some(state) = tx.surface_state().find(&surface.id, WHOLE)? {
        items.push(state_item(&state)?);
    }
    Ok(items)
}

fn get_in(tx: &dyn Tx, id: &str) -> Result<Option<SyncItem>, Error> {
    let surface_id = match of(id)? {
        Of::Surface(surface) | Of::Version(surface, _) | Of::State(surface) => surface,
    };
    let Some(surface) = tx.surfaces().find(surface_id)? else { return Ok(None) };
    if !travels(tx, &surface)? {
        return Ok(None);
    }
    match of(id)? {
        Of::Surface(_) => surface_item(&surface).map(Some),
        Of::Version(_, n) => {
            tx.surface_versions().find(surface_id, n)?.filter(kept).map(|version| version_item(&version)).transpose()
        }
        Of::State(_) => tx.surface_state().find(surface_id, WHOLE)?.map(|state| state_item(&state)).transpose(),
    }
}

fn apply_in(tx: &dyn Tx, out: &mut Outbox, id: &str, data: &Value) -> Result<(), Error> {
    let parse = |what: &str| refused(format!("not a surface's {what}"));
    match of(id)? {
        Of::Surface(surface_id) => {
            let record: SurfaceRecord = serde_json::from_value(data.clone()).map_err(|_| parse("record"))?;
            let local = tx.surfaces().find(surface_id)?;
            let what = match &local {
                None => "created",
                Some(local) if local.archived_at.is_some() && record.archived_at.is_none() => "restored",
                Some(_) if record.archived_at.is_some() => "archived",
                Some(_) => "version",
            };
            tx.surfaces().put(&StoredSurface {
                id: surface_id.to_owned(),
                routine_id: record.routine_id.clone(),
                level: word(Level::parse, &record.level, "level")?,
                place: word(Place::parse, &record.place, "place")?,
                role: word(Role::parse, &record.role, "role")?,
                title: record.title,
                current_version: record.current_version,
                // A candidate waits for the user of the computer that made it.
                candidate_version: local.as_ref().and_then(|local| local.candidate_version),
                needs_redesign_json: local.as_ref().and_then(|local| local.needs_redesign_json.clone()),
                archived_at: record.archived_at,
                created_at: record.created_at,
                updated_at: record.updated_at,
            })?;
            let change =
                SurfacesChange { surface_id: surface_id.to_owned(), routine_id: record.routine_id, what: what.into() };
            out.push(SURFACES_CHANGE.name(), &change);
        }
        Of::Version(surface_id, n) => {
            let record: VersionRecord = serde_json::from_value(data.clone()).map_err(|_| parse("version"))?;
            let status = word(VersionStatus::parse, &record.status, "status")?;
            if !matches!(status, VersionStatus::Kept | VersionStatus::Superseded) {
                return Err(refused("only kept versions travel"));
            }
            let local = tx.surface_versions().find(surface_id, n)?;
            if local.as_ref().is_some_and(|local| local.body_json != record.body_json) {
                return Err(refused("a kept design never changes"));
            }
            serde_json::from_str::<Value>(&record.body_json).map_err(|_| parse("design"))?;
            tx.surface_versions().put(&StoredSurfaceVersion {
                surface_id: surface_id.to_owned(),
                version: n,
                status,
                base_version: record.base_version,
                made_by: word(MadeBy::parse, &record.made_by, "madeBy")?,
                run_id: local.and_then(|local| local.run_id),
                note: record.note,
                body_bytes: record.body_json.len() as i64,
                body_json: record.body_json,
                checks_json: record.checks_json,
                created_at: record.created_at,
                kept_at: record.kept_at,
            })?;
        }
        Of::State(surface_id) => {
            let record: StateRecord = serde_json::from_value(data.clone()).map_err(|_| parse("state"))?;
            serde_json::from_str::<Value>(&record.data_json).map_err(|_| parse("state"))?;
            tx.surface_state().put(&StoredSurfaceState {
                surface_id: surface_id.to_owned(),
                scope: WHOLE.to_owned(),
                bytes: record.data_json.len() as i64,
                data_json: record.data_json,
                updated_at: record.updated_at,
            })?;
            out.push(SURFACES_STATE.name(), &SurfacesState { surface_id: surface_id.to_owned(), scope: WHOLE.into() });
        }
    }
    Ok(())
}

impl RecordSync for SurfaceRecords {
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(self.0.read(|tx| {
            let mut items = Vec::new();
            for routine in tx.routines().list()?.iter().filter(|routine| routine.travels()) {
                for surface in tx.surfaces().of_routine(&routine.id)? {
                    items.extend(items_of(tx, &surface)?);
                }
            }
            Ok(items)
        }))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let id = id.to_owned();
        Box::pin(self.0.read(move |tx| get_in(tx, &id)))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        let (id, data) = (id.to_owned(), data.clone());
        Box::pin(self.0.write(move |tx, out| apply_in(tx, out, &id, &data)))
    }

    /// A surface goes with its routine (05 G27); a version or state that
    /// stopped travelling stays here.
    fn remove<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(Ok(())))
    }
}
