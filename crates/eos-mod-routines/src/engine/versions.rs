//! A routine's blueprint written by hand (01 §4.3 "Versions"): a routine
//! made from one, a new version kept from the head, an old version brought
//! back, a routine copied. A received blueprint has the limits it leaves out
//! filled in, is read, meets the rules and gets its trust (G46) before a row
//! is written. A version row never changes, so each write adds one, and
//! announces `routine:change` with the row from its own job.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use eos_contracts::{
    Blueprint, BlueprintIssue, IssueSeverity, Num, ResultMode, RoutineChangeReason, RoutineSaved, RoutineState,
    RunInput, Trigger, VersionAuthor, VersionStatus,
};
use eos_core::Error;
use eos_core::os::ZoneRules;
use eos_core::store::{Outbox, StoredRoutine, StoredVersion, Tx};
use eos_domain::config::price_for_model;
use eos_domain::routine::blueprint::{self, Context, Readable, Severity, canonical_json, hash};
use eos_domain::routine::limits::{RUN_AT_LEAST_USD, RUN_ESTIMATE_TIMES, fill_defaults, per_run_usd};
use eos_domain::routine::{slug, trust};
use eos_domain::run_scope::Trust;
use eos_inbox::{HeadChange, head_changed_in};
use serde_json::Value;

use super::Engine;
use super::control::announce;
use super::lifecycle::{live, row};
use crate::patterns::ItemPatterns;
use crate::routes::{gone, readable, showing_version};

/// What a write refused for a routine whose version was made by a newer
/// Eos says; its routes answer it as `newer_format` (G36).
pub(crate) const NEWER_FORMAT: &str = "the routine was made by a newer Eos";

/// What a write that makes a version comes to.
pub(crate) enum Saved {
    Done(Box<RoutineSaved>),
    /// The blueprint did not meet its rules; nothing was written.
    Refused(Vec<BlueprintIssue>),
}

/// A received blueprint ready for its rules.
pub(crate) struct Prepared {
    pub(crate) blueprint: Blueprint,
    pub(crate) trust: Trust,
}

fn issue(path: &[&str], message: &str) -> BlueprintIssue {
    let path = path.iter().map(|part| (*part).to_owned()).collect();
    BlueprintIssue { path, message: message.to_owned(), severity: IssueSeverity::Error }
}

/// Reads `value`, with its missing limits filled; a new blueprint's run cap
/// is three times its estimate, at least a dollar.
pub(crate) async fn prepare(engine: &Engine, mut value: Value) -> Result<Result<Prepared, Vec<BlueprintIssue>>, Error> {
    let estimate_cap = fill_defaults(&mut value);
    let mut blueprint = match blueprint::read(&value) {
        Ok(Readable::Current(blueprint)) => *blueprint,
        Ok(Readable::Newer { .. }) => return Ok(Err(vec![issue(&["format"], "Was made by a newer Eos")])),
        Err(error) => {
            let issues = error.issues.into_iter().map(|found| BlueprintIssue {
                path: found.path,
                message: found.message,
                severity: IssueSeverity::Error,
            });
            return Ok(Err(issues.collect()));
        }
    };
    if estimate_cap {
        let config = engine.config.current();
        let input = RunInput {
            item: None,
            items: None,
            trigger: None,
            options: Default::default(),
            note: None,
            result: ResultMode::Usual,
            at: None,
        };
        let usual =
            crate::routes::usual(&blueprint, &[], &input, |model| price_for_model(&config, Some(model)).cloned());
        let cap = per_run_usd(usual.usd, RUN_ESTIMATE_TIMES, RUN_AT_LEAST_USD);
        blueprint.limits.per_run_usd = Num((cap * 100.0).round() / 100.0);
    }
    let outside = outside(engine).await?;
    let trust = trust::of_version(&blueprint, |id| outside.contains(id));
    Ok(Ok(Prepared { blueprint, trust }))
}

/// The capabilities whose reads bring outside text.
async fn outside(engine: &Engine) -> Result<HashSet<String>, Error> {
    let capabilities = engine.reads.list().await?;
    Ok(capabilities.into_iter().filter(|capability| trust::reads_outside(&capability.manifest)).map(|c| c.id).collect())
}

/// The rules over `blueprint` as routine `routine_id`'s: errors block,
/// warnings are kept beside the version.
pub(crate) fn check_in(
    tx: &dyn Tx,
    routine_id: &str,
    blueprint: &Blueprint,
    zones: &dyn ZoneRules,
    data_dir: &Path,
) -> Result<Vec<BlueprintIssue>, Error> {
    let mut chains = Vec::new();
    for routine in tx.routines().list()? {
        if routine.id == routine_id || routine.state == RoutineState::Deleted {
            continue;
        }
        let Some(other) = showing_version(tx, &routine.id)?.map(|version| readable(&version)).transpose()?.flatten()
        else {
            continue;
        };
        let after = other.when.on.iter().filter_map(|trigger| match trigger {
            Trigger::After { after, .. } => Some(after.routine.clone()),
            _ => None,
        });
        chains.push((routine.id, after.collect()));
    }
    let known = |zone: &str| zones.known(zone);
    let context = Context { routine: routine_id, chains: &chains, known_zone: &known, data_dir: Some(data_dir) };
    let issues = blueprint::validate(blueprint, &context).into_iter().map(|found| BlueprintIssue {
        path: found.path,
        message: found.message,
        severity: match found.severity {
            Severity::Error => IssueSeverity::Error,
            Severity::Warning => IssueSeverity::Warning,
        },
    });
    Ok(issues.collect())
}

pub(crate) fn blocks(issues: &[BlueprintIssue]) -> bool {
    issues.iter().any(|issue| issue.severity == IssueSeverity::Error)
}

/// A version row of `blueprint`.
pub(crate) struct NewVersion<'a> {
    pub(crate) id: &'a str,
    pub(crate) routine_id: &'a str,
    pub(crate) parent_id: Option<String>,
    pub(crate) status: VersionStatus,
    pub(crate) author: VersionAuthor,
    pub(crate) note: Option<String>,
    pub(crate) prepared: &'a Prepared,
    pub(crate) device: &'a str,
    pub(crate) now: i64,
}

pub(crate) fn insert_version(tx: &dyn Tx, version: NewVersion<'_>) -> Result<(), Error> {
    let text = canonical_json(&version.prepared.blueprint);
    tx.routine_versions().insert(&StoredVersion {
        id: version.id.to_owned(),
        routine_id: version.routine_id.to_owned(),
        parent_id: version.parent_id,
        status: version.status,
        author: version.author,
        note: version.note,
        format: version.prepared.blueprint.format,
        hash: hash(&text),
        blueprint: text,
        no_trial: false,
        trust: version.prepared.trust,
        device: Some(version.device.to_owned()),
        created_at: version.now,
    })
}

/// A slug from `name` that no routine that can still come back holds.
pub(crate) fn free_slug(tx: &dyn Tx, name: &str, now: i64) -> Result<String, Error> {
    let held: HashSet<String> =
        tx.routines().list()?.into_iter().filter(|routine| !gone(routine, now)).map(|routine| routine.slug).collect();
    Ok(slug::unique(&slug::of_name(name), |slug| held.contains(slug)))
}

/// A new draft routine of `value`, made by hand (`hand`) or as a copy
/// (`copy`), its one version a draft authored by the user.
pub(crate) async fn create(
    engine: &Arc<Engine>,
    value: Value,
    note: Option<String>,
    origin: &'static str,
) -> Result<Saved, Error> {
    let prepared = match prepare(engine, value).await? {
        Ok(prepared) => prepared,
        Err(issues) => return Ok(Saved::Refused(issues)),
    };
    let (id, version_id, now) = (engine.ids.routine_id(), engine.ids.routine_version_id(), engine.clock.now_ms());
    let (zones, data_dir, device) = (engine.zones.clone(), engine.data_dir.clone(), engine.device.clone());
    let patterns = engine.patterns.clone();
    let (made, makes) = (id.clone(), prepared.blueprint.makes.kind.clone());
    let saved = engine
        .store
        .write(move |tx, out| {
            let issues = check_in(tx, &id, &prepared.blueprint, zones.as_ref(), &data_dir)?;
            if blocks(&issues) {
                return Ok(Saved::Refused(issues));
            }
            let blueprint = &prepared.blueprint;
            tx.routines().insert(&StoredRoutine {
                id: id.clone(),
                slug: free_slug(tx, &blueprint.name, now)?,
                name: blueprint.name.clone(),
                kind: blueprint.kind,
                state: RoutineState::Draft,
                paused_reason: None,
                head_version_id: None,
                origin: origin.to_owned(),
                task_key: None,
                agents_may_start: false,
                failure_streak: 0,
                created_at: now,
                updated_at: now,
                changed_at: now,
                started_at: None,
                deleted_at: None,
            })?;
            let version = NewVersion {
                id: &version_id,
                routine_id: &id,
                parent_id: None,
                status: VersionStatus::Draft,
                author: VersionAuthor::User,
                note,
                prepared: &prepared,
                device: &device,
                now,
            };
            insert_version(tx, version)?;
            tracing::info!(routine_id = %id, version_id = %version_id, origin, "a routine was made by hand");
            announce(tx, out, &id, RoutineChangeReason::Created, now, &patterns)?;
            Ok(Saved::Done(Box::new(RoutineSaved { row: row(tx, &id, now, &patterns)?, version_id, warnings: issues })))
        })
        .await?;
    if let Saved::Done(done) = &saved {
        super::surfaces::created(engine, &made, &done.version_id, &makes).await;
    }
    Ok(saved)
}

/// A new version of a routine: kept as its head, or while the routine is a
/// draft, its newest draft. `base`, when given, must be the version the
/// routine shows now.
pub(crate) struct Edit {
    pub(crate) base: Option<String>,
    pub(crate) value: Value,
    pub(crate) note: Option<String>,
    pub(crate) author: VersionAuthor,
}

pub(crate) async fn save(engine: &Arc<Engine>, routine_id: &str, edit: Edit) -> Result<Saved, Error> {
    let Edit { base, value, note, author } = edit;
    let prepared = match prepare(engine, value).await? {
        Ok(prepared) => prepared,
        Err(issues) => return Ok(Saved::Refused(issues)),
    };
    let (id, version_id, now) = (routine_id.to_owned(), engine.ids.routine_version_id(), engine.clock.now_ms());
    let (zones, data_dir, device) = (engine.zones.clone(), engine.data_dir.clone(), engine.device.clone());
    let patterns = engine.patterns.clone();
    let saved = engine
        .store
        .write(move |tx, out| {
            live(tx, &id)?;
            let shown = showing_version(tx, &id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            if base.as_ref().is_some_and(|base| *base != shown.id) {
                return Err(Error::Conflict("the routine changed since this edit began".into()));
            }
            if readable(&shown)?.is_none() {
                return Err(Error::Conflict(NEWER_FORMAT.into()));
            }
            let issues = check_in(tx, &id, &prepared.blueprint, zones.as_ref(), &data_dir)?;
            if blocks(&issues) {
                return Ok(Saved::Refused(issues));
            }
            let added = Added {
                routine_id: &id,
                version_id: &version_id,
                author,
                note,
                prepared: &prepared,
                device: &device,
                now,
                patterns: &patterns,
            };
            add_in(tx, out, added)?;
            Ok(Saved::Done(Box::new(RoutineSaved { row: row(tx, &id, now, &patterns)?, version_id, warnings: issues })))
        })
        .await?;
    engine.wake.notify_one();
    Ok(saved)
}

/// A new version of a live routine from the version it shows.
pub(crate) struct Added<'a> {
    pub(crate) routine_id: &'a str,
    pub(crate) version_id: &'a str,
    pub(crate) author: VersionAuthor,
    pub(crate) note: Option<String>,
    pub(crate) prepared: &'a Prepared,
    pub(crate) device: &'a str,
    pub(crate) now: i64,
    pub(crate) patterns: &'a ItemPatterns,
}

/// Writes `added` as the routine's head, or while the routine is a draft,
/// its newest draft, and announces it. Answers whether it was kept as the
/// head.
pub(crate) fn add_in(tx: &dyn Tx, out: &mut Outbox, added: Added<'_>) -> Result<bool, Error> {
    let Added { routine_id, version_id, author, note, prepared, device, now, patterns } = added;
    let routine = live(tx, routine_id)?;
    let shown = showing_version(tx, routine_id)?.ok_or_else(|| Error::not_found("routine", routine_id))?;
    let kept = routine.state != RoutineState::Draft;
    let before = if kept { readable(&shown)? } else { None };
    let version = NewVersion {
        id: version_id,
        routine_id,
        parent_id: Some(shown.id),
        status: if kept { VersionStatus::Kept } else { VersionStatus::Draft },
        author,
        note,
        prepared,
        device,
        now,
    };
    insert_version(tx, version)?;
    if kept {
        tx.routines().set_head(routine_id, version_id, now)?;
    }
    if let Some(before) = before {
        let after = &prepared.blueprint;
        let change = HeadChange {
            freedom_by_hand: matches!(author, VersionAuthor::User | VersionAuthor::Restore)
                && before.freedom != after.freedom,
            work: before.who != after.who || before.how != after.how || before.makes != after.makes,
        };
        head_changed_in(tx, out, routine_id, after.freedom.rung, change, now)?;
    }
    if routine.name != prepared.blueprint.name {
        tx.routines().set_name(routine_id, &prepared.blueprint.name, now)?;
    }
    tracing::info!(routine_id, version_id, author = ?author, "a routine got a new version");
    announce(tx, out, routine_id, RoutineChangeReason::Version, now, patterns)?;
    Ok(kept)
}

/// The stored blueprint of one of a live routine's versions, as it is kept.
async fn stored_blueprint(engine: &Engine, routine_id: &str, version_id: Option<&str>) -> Result<Value, Error> {
    let (id, version_id) = (routine_id.to_owned(), version_id.map(str::to_owned));
    let version = engine
        .store
        .read(move |tx| {
            live(tx, &id)?;
            let version = match &version_id {
                Some(version_id) => tx.routine_versions().find(&id, version_id)?,
                None => showing_version(tx, &id)?,
            };
            version.ok_or_else(|| Error::not_found("version", version_id.unwrap_or(id)))
        })
        .await?;
    serde_json::from_str(&version.blueprint).map_err(|_| Error::storage(format!("version {} is not JSON", version.id)))
}

/// `POST …/versions/:versionId/restore`: the old version's blueprint as a
/// new version from the head.
pub(crate) async fn restore(engine: &Arc<Engine>, routine_id: &str, version_id: &str) -> Result<Saved, Error> {
    let value = stored_blueprint(engine, routine_id, Some(version_id)).await?;
    save(engine, routine_id, Edit { base: None, value, note: None, author: VersionAuthor::Restore }).await
}

/// `POST …/copy`: "start another like this", a draft of the blueprint the
/// routine shows.
pub(crate) async fn copy(engine: &Arc<Engine>, routine_id: &str) -> Result<Saved, Error> {
    let value = stored_blueprint(engine, routine_id, None).await?;
    create(engine, value, None, "copy").await
}
