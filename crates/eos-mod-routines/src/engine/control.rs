//! `RoutineControl`: what other areas change of a routine. A change of
//! Freedom is a new kept version made from the head; a pause or a resume is
//! the routine's state. Each is announced on `routine:change`. A routine
//! paused because the gate refused a target resumes only once the user
//! confirmed every recipient its head names (D53).

use std::sync::Arc;

use eos_contracts::{Recipient, RoutineChange, RoutineChangeReason, RoutineState, Rung, VersionAuthor, VersionStatus};
use eos_core::routine::{Confirmed, ResumeError, ResumeRefusal, RoutineControl};
use eos_core::store::{Outbox, StoredRoutine, StoredVersion, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::blueprint::{canonical_json, hash};
use eos_inbox::gate::TARGET_REFUSED;
use serde_json::Value;

use super::Engine;
use crate::ROUTINE_CHANGE;
use crate::patterns::ItemPatterns;
use crate::routes::{readable, summary};

pub(crate) struct Control(pub(crate) Arc<Engine>);

/// The versions whose Freedom and Goes to the user stands behind: written
/// by the user, confirmed from the architect's draft, or restored by the
/// user.
fn confirmed_by_user(version: &StoredVersion) -> bool {
    version.status == VersionStatus::Kept
        && matches!(version.author, VersionAuthor::User | VersionAuthor::Architect | VersionAuthor::Restore)
}

/// The Freedom and Goes to of the newest version the user stands behind,
/// with the Freedom lowered by every kept version Eos wrote after it: Eos
/// only ever takes freedom away (a step-down), never adds it (D9).
pub(crate) fn confirmed_in(tx: &dyn Tx, routine_id: &str) -> Result<Confirmed, Error> {
    let versions = tx.routine_versions().list(routine_id)?;
    for (at, version) in versions.iter().enumerate().rev().filter(|(_, v)| confirmed_by_user(v)) {
        let Some(blueprint) = readable(version)? else { continue };
        let mut freedom = blueprint.freedom;
        for later in
            versions[at + 1..].iter().filter(|v| v.status == VersionStatus::Kept && v.author == VersionAuthor::Eos)
        {
            if let Some(eos) = readable(later)? {
                freedom.rung = freedom.rung.min(eos.freedom.rung);
                freedom.grants.retain(|grant| eos.freedom.grants.contains(grant));
            }
        }
        return Ok(Confirmed { freedom, goes_to: blueprint.goes_to });
    }
    Err(Error::not_found("confirmed routine", routine_id))
}

/// Why `routine` may not resume yet: it is paused because a target was
/// refused and its head names recipients the user has not confirmed.
pub(crate) fn refusal_in(tx: &dyn Tx, routine: &StoredRoutine) -> Result<Option<ResumeRefusal>, Error> {
    if routine.state != RoutineState::Paused || routine.paused_reason.as_deref() != Some(TARGET_REFUSED) {
        return Ok(None);
    }
    let Some(head) = tx.routine_versions().head(&routine.id)? else { return Ok(None) };
    let Some(blueprint) = readable(&head)? else { return Ok(None) };
    let confirmed = match confirmed_in(tx, &routine.id) {
        Ok(confirmed) => confirmed.goes_to,
        Err(Error::NotFound { .. }) => Vec::new(),
        Err(error) => return Err(error),
    };
    let recipients: Vec<Recipient> =
        blueprint.goes_to.into_iter().filter(|recipient| !confirmed.contains(recipient)).collect();
    Ok((!recipients.is_empty()).then_some(ResumeRefusal { recipients }))
}

fn routine(tx: &dyn Tx, routine_id: &str) -> Result<StoredRoutine, Error> {
    tx.routines().find(routine_id)?.ok_or_else(|| Error::not_found("routine", routine_id))
}

pub(crate) fn announce(
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    reason: RoutineChangeReason,
    now: i64,
    patterns: &ItemPatterns,
) -> Result<(), Error> {
    let routine = routine(tx, routine_id)?;
    let row = summary(tx, &routine, now, patterns)?;
    out.push(ROUTINE_CHANGE.name(), &RoutineChange { routine_id: routine_id.to_owned(), reason, row });
    Ok(())
}

pub(crate) fn pause_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    routine_id: &str,
    reason: &str,
    now: i64,
    patterns: &ItemPatterns,
) -> Result<(), Error> {
    if routine(tx, routine_id)?.state != RoutineState::Active {
        return Ok(());
    }
    tx.routines().set_state(routine_id, RoutineState::Paused, Some(reason), now)?;
    super::supervisor::skip_queued_in(tx, out, routine_id, RoutineState::Paused, now)?;
    tracing::info!(routine_id, reason, "a routine was paused");
    announce(tx, out, routine_id, RoutineChangeReason::State, now, patterns)
}

/// A new kept head with the head's blueprint at `rung`; nothing when the
/// head is at `rung` already or `keep` says the move goes the wrong way.
/// A step-down also drops every grant, so no item keeps the freedom the
/// undone send had.
struct NewRung<'a> {
    rung: Rung,
    author: VersionAuthor,
    note: Option<&'a str>,
    keep: fn(current: Rung, next: Rung) -> bool,
    drop_grants: bool,
}

impl Control {
    fn set_rung(&self, routine_id: &str, change: NewRung<'_>) -> BoxFuture<'_, Result<(), Error>> {
        let (engine, id) = (self.0.clone(), routine_id.to_owned());
        let note = change.note.map(str::to_owned);
        let (rung, author, keep, drop_grants) = (change.rung, change.author, change.keep, change.drop_grants);
        Box::pin(async move {
            let now = engine.clock.now_ms();
            let version_id = engine.ids.routine_version_id();
            let (device, patterns) = (engine.device.clone(), engine.patterns.clone());
            engine
                .store
                .write(move |tx, out| {
                    let head = tx.routine_versions().head(&id)?.ok_or_else(|| Error::not_found("routine", &id))?;
                    let mut blueprint = readable(&head)?
                        .ok_or_else(|| Error::Conflict("the routine was made by a newer Eos".into()))?;
                    let moves = keep(blueprint.freedom.rung, rung);
                    let drops = drop_grants && !blueprint.freedom.grants.is_empty();
                    if !moves && !drops {
                        return Ok(());
                    }
                    if moves {
                        blueprint.freedom.rung = rung;
                    }
                    if drops {
                        blueprint.freedom.grants.clear();
                    }
                    let text = canonical_json(&blueprint);
                    tx.routine_versions().insert(&StoredVersion {
                        id: version_id.clone(),
                        routine_id: id.clone(),
                        parent_id: Some(head.id.clone()),
                        status: VersionStatus::Kept,
                        author,
                        note,
                        format: head.format,
                        hash: hash(&text),
                        blueprint: text,
                        no_trial: head.no_trial,
                        trust: head.trust,
                        device: Some(device),
                        created_at: now,
                    })?;
                    tx.routines().set_head(&id, &version_id, now)?;
                    tracing::info!(routine_id = %id, version_id = %version_id, "a routine's freedom changed");
                    announce(tx, out, &id, RoutineChangeReason::Version, now, &patterns)
                })
                .await
        })
    }
}

impl RoutineControl for Control {
    fn confirmed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Confirmed, Error>> {
        let id = routine_id.to_owned();
        Box::pin(self.0.store.read(move |tx| confirmed_in(tx, &id)))
    }

    fn confirmed_in(&self, tx: &dyn Tx, routine_id: &str) -> Result<Confirmed, Error> {
        confirmed_in(tx, routine_id)
    }

    fn raise<'a>(&'a self, routine_id: &'a str, rung: Rung) -> BoxFuture<'a, Result<(), Error>> {
        let higher = |current: Rung, next: Rung| next > current;
        let raise = NewRung { rung, author: VersionAuthor::User, note: None, keep: higher, drop_grants: false };
        self.set_rung(routine_id, raise)
    }

    fn step_down<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let lower = |current: Rung, next: Rung| next < current;
        self.set_rung(
            routine_id,
            NewRung {
                rung: Rung::Draft,
                author: VersionAuthor::Eos,
                note: Some(reason),
                keep: lower,
                drop_grants: true,
            },
        )
    }

    fn pause<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let (engine, id, reason) = (self.0.clone(), routine_id.to_owned(), reason.to_owned());
        Box::pin(async move {
            let now = engine.clock.now_ms();
            let patterns = engine.patterns.clone();
            engine.store.write(move |tx, out| pause_in(tx, out, &id, &reason, now, &patterns)).await
        })
    }

    fn pause_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), Error> {
        pause_in(tx, out, routine_id, reason, self.0.clock.now_ms(), &self.0.patterns)
    }

    fn resume_paused<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let (engine, reason) = (self.0.clone(), reason.to_owned());
        Box::pin(async move {
            let (now, patterns) = (engine.clock.now_ms(), engine.patterns.clone());
            engine
                .store
                .write(move |tx, out| {
                    for routine in tx.routines().list()? {
                        if routine.state == RoutineState::Paused && routine.paused_reason.as_deref() == Some(&reason) {
                            if refusal_in(tx, &routine)?.is_some() {
                                tracing::info!(routine_id = %routine.id, "a routine stays paused: recipients to confirm");
                                continue;
                            }
                            tx.routines().set_state(&routine.id, RoutineState::Active, None, now)?;
                            tracing::info!(routine_id = %routine.id, reason = %reason, "a routine was resumed");
                            announce(tx, out, &routine.id, RoutineChangeReason::State, now, &patterns)?;
                        }
                    }
                    Ok(())
                })
                .await?;
            // Triggered runs it holds may leave the queue now.
            engine.wake.notify_one();
            Ok(())
        })
    }

    fn resume_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), ResumeError> {
        let routine = routine(tx, routine_id)?;
        if routine.state != RoutineState::Paused || routine.paused_reason.as_deref() != Some(reason) {
            return Ok(());
        }
        if let Some(refusal) = refusal_in(tx, &routine)? {
            return Err(ResumeError::Unconfirmed(refusal));
        }
        let now = self.0.clock.now_ms();
        tx.routines().set_state(routine_id, RoutineState::Active, None, now)?;
        tracing::info!(routine_id, reason, "a routine was resumed");
        announce(tx, out, routine_id, RoutineChangeReason::State, now, &self.0.patterns)?;
        // Triggered runs it holds may leave the queue: the supervisor's next
        // pass is a write job, so it reads this one's commit.
        self.0.wake.notify_one();
        Ok(())
    }

    fn using_capability<'a>(&'a self, capability_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>> {
        let id = capability_id.to_owned();
        Box::pin(self.0.store.read(move |tx| {
            let mut users = Vec::new();
            for routine in tx.routines().list()? {
                if routine.state == RoutineState::Deleted {
                    continue;
                }
                let Some(head) = tx.routine_versions().head(&routine.id)? else { continue };
                let Some(blueprint) = readable(&head)? else { continue };
                if blueprint.needs.iter().any(|need| names(need, &id)) {
                    users.push(routine.id);
                }
            }
            Ok(users)
        }))
    }
}

/// A need is kept as it came: a capability's id, or an object with one.
pub(crate) fn names(need: &Value, capability_id: &str) -> bool {
    match need {
        Value::String(id) => id == capability_id,
        Value::Object(fields) => fields.get("id").and_then(Value::as_str) == Some(capability_id),
        _ => false,
    }
}
