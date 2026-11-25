//! `propose_blueprint`: the architect's blueprint, read and checked like one
//! written by hand, as a new draft version from the version the routine
//! shows. An architect version is always a draft: only the user's start
//! keeps it (03 G14). One that asks for a higher rung, a grant that raises
//! some items above what the user confirmed, or a place for results the user
//! has not confirmed opens one `confirm_change` item in the same
//! write; a newer proposal takes its place.

use eos_contracts::{Blueprint, DraftStatus, Freedom, Grant, RoutineChangeReason, Rung, VersionAuthor, VersionStatus};
use eos_core::Error;
use eos_core::routine::Proposal;
use eos_core::store::{Outbox, Tx};
use eos_domain::inbox::ItemKind;
use eos_inbox::{NewItem, Opening, open_in};
use serde_json::{Value, json};

use super::{draft_of, touch};
use crate::engine::{
    Control, Engine, NEWER_FORMAT, NewVersion, Prepared, announce_routine, blocks, check_in, confirmed_in,
    insert_version, prepare,
};
use crate::routes::{readable, showing_version};

/// The subject of a routine's one `confirm_change` item.
const CONFIRM_CHANGE: &str = "confirm_change";

pub(crate) async fn propose(
    engine: &std::sync::Arc<Engine>,
    worker_id: &str,
    value: Value,
    note: Option<String>,
) -> Result<Proposal, Error> {
    touch(engine, worker_id);
    let prepared = match prepare(engine, value).await? {
        Ok(prepared) => prepared,
        Err(issues) => return Ok(Proposal::Refused(issues)),
    };
    let (worker, version_id, now) = (worker_id.to_owned(), engine.ids.routine_version_id(), engine.clock.now_ms());
    let (job, zones, device) = (engine.clone(), engine.zones.clone(), engine.device.clone());
    let data_dir = engine.data_dir.clone();
    let patterns = engine.patterns.clone();
    engine
        .store
        .write(move |tx, out| {
            let mut draft = draft_of(tx, &worker)?;
            let id = draft.routine_id.clone();
            let shown = showing_version(tx, &id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            if readable(&shown)?.is_none() {
                return Err(Error::Conflict(NEWER_FORMAT.into()));
            }
            let issues = check_in(tx, &id, &prepared.blueprint, zones.as_ref(), &data_dir)?;
            if blocks(&issues) {
                return Ok(Proposal::Refused(issues));
            }
            let version = NewVersion {
                id: &version_id,
                routine_id: &id,
                parent_id: Some(shown.id),
                status: VersionStatus::Draft,
                author: VersionAuthor::Architect,
                note,
                prepared: &prepared,
                device: &device,
                now,
            };
            insert_version(tx, version)?;
            let routine = tx.routines().find(&id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            // The name the routine shows follows its head once it has one.
            if routine.head_version_id.is_none() && routine.name != prepared.blueprint.name {
                tx.routines().set_name(&id, &prepared.blueprint.name, now)?;
            }
            draft.draft_version_id = Some(version_id.clone());
            draft.status = DraftStatus::Working;
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            if widens(tx, &id, &prepared)? {
                confirm_change_in(tx, out, &job, &routine.name, &id, &version_id, now)?;
            }
            tracing::info!(routine_id = %id, version_id = %version_id, "an architect proposed a draft");
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now, &patterns)?;
            Ok(Proposal::Drafted { version_id, warnings: issues })
        })
        .await
}

/// Whether `prepared` asks for more than the user confirmed: a higher rung,
/// a grant above the confirmed rung that no confirmed grant holds for the
/// same items at that rung or higher, or a place for results they have not
/// confirmed. A routine the user has confirmed nothing of holds its results
/// as drafts and sends them nowhere.
fn widens(tx: &dyn Tx, routine_id: &str, prepared: &Prepared) -> Result<bool, Error> {
    let (confirmed, goes_to) = match confirmed_in(tx, routine_id) {
        Ok(confirmed) => (confirmed.freedom, confirmed.goes_to),
        Err(Error::NotFound { .. }) => {
            (Freedom { rung: Rung::Draft, grants: Vec::new(), extra: Default::default() }, Vec::new())
        }
        Err(error) => return Err(error),
    };
    let Blueprint { freedom, goes_to: proposed, .. } = &prepared.blueprint;
    let held = |grant: &Grant| {
        confirmed.grants.iter().any(|kept| {
            kept.when == grant.when
                && kept.rung >= grant.rung
                && (kept.covers_irreversible || !grant.covers_irreversible)
        })
    };
    let raising = freedom.grants.iter().any(|grant| grant.rung > confirmed.rung && !held(grant));
    Ok(freedom.rung > confirmed.rung || raising || proposed.iter().any(|recipient| !goes_to.contains(recipient)))
}

fn confirm_change_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    engine: &std::sync::Arc<Engine>,
    name: &str,
    routine_id: &str,
    version_id: &str,
    now: i64,
) -> Result<(), Error> {
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let item = NewItem {
        kind: ItemKind::ConfirmChange,
        producer: "routines".into(),
        routine_id: Some(routine_id.to_owned()),
        run_id: None,
        subject_key: Some(CONFIRM_CHANGE.into()),
        title: format!("Confirm the change to {name}"),
        summary: "Its architect proposes more freedom or new places for its results.".into(),
        payload: json!({"versionId": version_id}),
        by_hand: false,
    };
    open_in(tx, out, &at, item)?;
    tracing::info!(routine_id, version_id, "a change waits for the user to confirm it");
    Ok(())
}
