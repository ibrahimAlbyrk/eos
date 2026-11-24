//! The routine reads, each one snapshot of the store turned into wire rows.

use std::sync::Arc;

use eos_contracts::{
    BLUEPRINT_FORMAT, Blueprint, Num, ResultMode, RoutineDetail, RoutineDraft, RoutineOption, RoutineState,
    RoutineSummary, RoutineTakes, RoutineVersion, RoutineVersionRow, RunInput, RunSummary, Rung, Takes, TakesEmpty,
    Trigger, UsualCost, When,
};
use eos_core::store::{Store, StoredDraft, StoredRoutine, StoredRun, StoredVersion, Tx};
use eos_core::{Clock, Error};
use eos_domain::routine::blueprint::{self, Readable};
use eos_domain::routine::numbers::Basis;
use eos_domain::signals::when::describe;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::Value;

use super::usual;
use crate::patterns::ItemPatterns;
use crate::retention::DELETED_KEPT_MS;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// How many of a routine's latest runs its usual cost is read from.
const USUAL_RUNS_READ: i64 = 200;

/// The runs a routine's page lists.
const RECENT_RUNS: i64 = 20;

/// The origin of the routines a feature owns, which the user never lists.
pub(crate) const BUILTIN: &str = "builtin";

pub(crate) fn all(store: &Arc<dyn Store>, clock: &Arc<dyn Clock>, patterns: &Arc<ItemPatterns>) -> Vec<RouteDef> {
    let (list_store, list_clock, list_patterns) = (store.clone(), clock.clone(), patterns.clone());
    let list = RouteDef::get("/api/routines", move |_req: Request| {
        let (store, now, patterns) = (list_store.clone(), list_clock.now_ms(), list_patterns.clone());
        async move {
            patterns.refresh().await;
            let rows = store.read(move |tx| rows(tx, now, &patterns)).await?;
            Ok(Response::json(200, &rows))
        }
    });
    let (detail_store, detail_clock, detail_patterns) = (store.clone(), clock.clone(), patterns.clone());
    let detail = RouteDef::get("/api/routines/{id}", move |req: Request| {
        let (store, now, id) = (detail_store.clone(), detail_clock.now_ms(), param(&req, "id"));
        let patterns = detail_patterns.clone();
        async move {
            patterns.refresh().await;
            let detail = store.read(move |tx| routine_detail(tx, &id, now, &patterns)).await?;
            Ok(Response::json(200, &detail))
        }
    });
    let (versions_store, versions_clock) = (store.clone(), clock.clone());
    let versions = RouteDef::get("/api/routines/{id}/versions", move |req: Request| {
        let (store, now, id) = (versions_store.clone(), versions_clock.now_ms(), param(&req, "id"));
        async move {
            let rows = store
                .read(move |tx| {
                    shown_routine(tx, &id, now)?;
                    Ok(tx.routine_versions().list(&id)?.iter().enumerate().map(version_row).collect::<Vec<_>>())
                })
                .await?;
            Ok(Response::json(200, &rows))
        }
    });
    let (version_store, version_clock) = (store.clone(), clock.clone());
    let version = RouteDef::get("/api/routines/{id}/versions/{versionId}", move |req: Request| {
        let (store, now) = (version_store.clone(), version_clock.now_ms());
        let (id, version_id) = (param(&req, "id"), param(&req, "versionId"));
        async move {
            let version = store
                .read(move |tx| {
                    shown_routine(tx, &id, now)?;
                    let versions = tx.routine_versions().list(&id)?;
                    let at = versions.iter().position(|version| version.id == version_id);
                    let at = at.ok_or_else(|| Error::not_found("version", version_id))?;
                    with_blueprint(at, &versions[at])
                })
                .await?;
            Ok(Response::json(200, &version))
        }
    });
    // Routine text: the user's dashboard only, and their phone may read the list and one routine.
    let read = Access::ui_token().phone_user(Tier::Read);
    vec![
        list.access(read),
        detail.access(read),
        versions.access(Access::ui_token()),
        version.access(Access::ui_token()),
    ]
}

pub(crate) fn param(req: &Request, name: &str) -> String {
    req.param(name).unwrap_or_default().to_owned()
}

/// Gone for good: deleted longer ago than Recently deleted keeps it.
pub(crate) fn gone(routine: &StoredRoutine, now: i64) -> bool {
    routine.state == RoutineState::Deleted && routine.deleted_at.is_some_and(|at| now >= at + DELETED_KEPT_MS)
}

fn shown_routine(tx: &dyn Tx, id: &str, now: i64) -> Result<StoredRoutine, Error> {
    let routine = tx.routines().find(id)?.filter(|routine| !gone(routine, now));
    routine.ok_or_else(|| Error::not_found("routine", id))
}

fn rows(tx: &dyn Tx, now: i64, patterns: &ItemPatterns) -> Result<Vec<RoutineSummary>, Error> {
    let mut rows = Vec::new();
    for routine in tx.routines().list()? {
        if routine.origin == BUILTIN || gone(&routine, now) {
            continue;
        }
        if let Some(row) = summary(tx, &routine, now, patterns)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn routine_detail(tx: &dyn Tx, id: &str, now: i64, patterns: &ItemPatterns) -> Result<RoutineDetail, Error> {
    let routine = shown_routine(tx, id, now)?;
    let row = summary(tx, &routine, now, patterns)?.ok_or_else(|| Error::not_found("routine", id))?;
    let versions = tx.routine_versions().list(id)?;
    let head = versions.iter().position(|version| Some(&version.id) == routine.head_version_id.as_ref());
    Ok(RoutineDetail {
        routine: row,
        head: head.map(|at| with_blueprint(at, &versions[at])).transpose()?,
        draft: tx.routines().draft(id)?.map(draft),
        runs: run_summaries(tx, &tx.runs().by_routine(id, RECENT_RUNS)?)?,
    })
}

/// What a row shows of a blueprint.
struct Shown {
    summary: String,
    icon: String,
    aliases: Vec<String>,
    rung: Rung,
    takes: Takes,
    options: Vec<RoutineOption>,
}

impl Shown {
    fn of(blueprint: Blueprint) -> Self {
        Self {
            summary: blueprint.summary,
            icon: blueprint.icon,
            aliases: blueprint.aliases,
            rung: blueprint.freedom.rung,
            takes: blueprint.takes,
            options: blueprint.options,
        }
    }

    /// A newer format's slots as far as this app reads them (G36): it is
    /// listed and read, never run here.
    fn newer(value: &Value) -> Self {
        fn slot<T: serde::de::DeserializeOwned>(value: &Value) -> Option<T> {
            serde_json::from_value(value.clone()).ok()
        }
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        let takes = slot(&value["takes"]).unwrap_or_else(|| Takes {
            kind: String::new(),
            source: None,
            label: String::new(),
            placeholder: String::new(),
            empty: TakesEmpty::None,
            many: false,
            extra: serde_json::Map::new(),
        });
        Self {
            summary: text("summary"),
            icon: text("icon"),
            aliases: slot(&value["aliases"]).unwrap_or_default(),
            rung: slot(&value["freedom"]["rung"]).unwrap_or(Rung::Draft),
            takes,
            options: slot(&value["options"]).unwrap_or_default(),
        }
    }
}

/// The routine's row, from the blueprint it shows: its head, or while it is
/// being made, its newest version, with its kind's item patterns. None
/// when it has no version. Every routine row is built here.
pub(crate) fn summary(
    tx: &dyn Tx,
    routine: &StoredRoutine,
    now: i64,
    patterns: &ItemPatterns,
) -> Result<Option<RoutineSummary>, Error> {
    let Some(shown) = showing_version(tx, &routine.id)? else {
        return Ok(None);
    };
    let typed = readable(&shown)?;
    let (trigger_line, usual) = match &typed {
        Some(blueprint) => (Some(describe(&named(tx, &blueprint.when)?)), usual_cost(tx, &routine.id, blueprint)?),
        None => {
            let when = serde_json::from_value::<When>(stored_json(&shown)?["when"].clone()).ok();
            (when.map(|when| named(tx, &when)).transpose()?.as_ref().map(describe), None)
        }
    };
    let blueprint = match typed {
        Some(blueprint) => Shown::of(blueprint),
        None => Shown::newer(&stored_json(&shown)?),
    };
    let counts = tx.runs().counts(&routine.id, now - 7 * DAY_MS)?;
    let last_run = run_summaries(tx, tx.runs().by_routine(&routine.id, 1)?.first())?.pop();
    Ok(Some(RoutineSummary {
        id: routine.id.clone(),
        slug: routine.slug.clone(),
        name: routine.name.clone(),
        summary: blueprint.summary,
        icon: blueprint.icon,
        aliases: blueprint.aliases,
        kind: routine.kind,
        state: routine.state,
        paused_reason: routine.paused_reason.clone(),
        rung: blueprint.rung,
        trigger_line,
        takes: RoutineTakes { item_patterns: patterns.of(&blueprint.takes.kind), takes: blueprint.takes },
        options: blueprint.options.into_iter().filter(|option| option.inline).collect(),
        usual,
        runs7d: counts.since,
        active_runs: counts.live,
        last_run,
        stats: Some(super::numbers::stats_in(tx, routine, counts.since, now)?),
    }))
}

/// `when` with each routine an `after` waits on named as the user named
/// it; one that is gone keeps its id.
fn named(tx: &dyn Tx, when: &When) -> Result<When, Error> {
    let mut when = when.clone();
    for trigger in &mut when.on {
        if let Trigger::After { after, .. } = trigger
            && let Some(upstream) = tx.routines().find(&after.routine)?
        {
            after.routine = upstream.name;
        }
    }
    Ok(when)
}

/// What a run with the default options usually costs and takes, from the
/// routine's own finished runs; none while it has too few.
fn usual_cost(tx: &dyn Tx, routine_id: &str, blueprint: &Blueprint) -> Result<Option<UsualCost>, Error> {
    let runs = tx.runs().by_routine(routine_id, USUAL_RUNS_READ)?;
    let input = RunInput {
        item: None,
        items: None,
        trigger: None,
        options: Default::default(),
        note: None,
        result: ResultMode::Usual,
        at: None,
        surface: None,
    };
    let found = usual(blueprint, &runs, &input, |_| None);
    Ok((found.basis == Basis::History).then_some(UsualCost { usd: Num(found.usd), ms: found.ms }))
}

/// The version a routine shows and runs from: its head, or while it is
/// being made, its newest version.
pub(crate) fn showing_version(tx: &dyn Tx, routine_id: &str) -> Result<Option<StoredVersion>, Error> {
    match tx.routine_versions().head(routine_id)? {
        Some(head) => Ok(Some(head)),
        None => Ok(tx.routine_versions().list(routine_id)?.pop()),
    }
}

fn stored_json(version: &StoredVersion) -> Result<Value, Error> {
    serde_json::from_str(&version.blueprint).map_err(|_| Error::storage(format!("version {} is not JSON", version.id)))
}

/// The version's blueprint as this app runs it; None for a newer format.
pub(crate) fn readable(version: &StoredVersion) -> Result<Option<Blueprint>, Error> {
    let read = blueprint::read(&stored_json(version)?);
    match read.map_err(|_| Error::storage(format!("version {} is no blueprint", version.id)))? {
        Readable::Current(blueprint) => Ok(Some(*blueprint)),
        Readable::Newer { .. } => Ok(None),
    }
}

/// A version's row; `at` is its place among the routine's versions by time made.
fn version_row((at, version): (usize, &StoredVersion)) -> RoutineVersionRow {
    RoutineVersionRow {
        id: version.id.clone(),
        number: at as i64 + 1,
        parent_id: version.parent_id.clone(),
        status: version.status,
        author: version.author,
        note: version.note.clone(),
        format: version.format,
        runnable: version.format <= BLUEPRINT_FORMAT,
        created_at: version.created_at,
    }
}

pub(crate) fn with_blueprint(at: usize, version: &StoredVersion) -> Result<RoutineVersion, Error> {
    Ok(RoutineVersion { row: version_row((at, version)), hash: version.hash.clone(), blueprint: stored_json(version)? })
}

fn draft(draft: StoredDraft) -> RoutineDraft {
    RoutineDraft {
        purpose: draft.purpose,
        status: draft.status,
        question: draft.question.as_deref().map(|stored| crate::architect::question_of(stored).0),
        base_version_id: draft.base_version_id,
        draft_version_id: draft.draft_version_id,
        updated_at: draft.updated_at,
    }
}

/// The rows of `runs`, each saying whether it waits on the user.
pub(crate) fn run_summaries<'a>(
    tx: &dyn Tx,
    runs: impl IntoIterator<Item = &'a StoredRun>,
) -> Result<Vec<RunSummary>, Error> {
    let waiting = tx.runs().waiting_on_user()?;
    Ok(runs.into_iter().map(|run| run_summary(run, waiting.contains(&run.id))).collect())
}

fn run_summary(run: &StoredRun, needs_user: bool) -> RunSummary {
    let input: Option<RunInput> = serde_json::from_str(&run.input).ok();
    let item = input.and_then(|input| input.item.or_else(|| input.items.and_then(|items| items.into_iter().next())));
    RunSummary {
        id: run.id.clone(),
        routine_id: run.routine_id.clone(),
        kind: run.kind.clone(),
        origin: run.origin.clone(),
        state: run.state.as_str().to_owned(),
        station: run.station.map(|station| station.as_str().to_owned()),
        reason: run.reason.map(|reason| reason.as_str().to_owned()),
        outcome: run.outcome.map(|outcome| outcome.as_str().to_owned()),
        headline: run.headline.clone(),
        item_title: item.and_then(|item| item.title),
        needs_user,
        cost_usd: Num(run.cost_usd),
        work_ms: run.work_ms,
        created_at: run.created_at,
        started_at: run.started_at,
        ended_at: run.ended_at,
    }
}
