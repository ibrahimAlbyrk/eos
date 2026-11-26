//! Making a routine from a sentence, and asking its architect for a change.

use std::sync::Arc;

use eos_contracts::{
    ArchitectRequest, DraftStatus, DraftView, RoutineChangeReason, RoutineKind, RoutineSaved, RoutineState, Rung,
    VersionAuthor, VersionStatus,
};
use eos_core::Error;
use eos_core::store::{StoredDraft, StoredRoutine, Tx};
use eos_domain::routine::blueprint::canonical_json;
use eos_domain::routine::limits::fill_defaults;
use eos_prompts::service::no_values;
use serde_json::{Value, json};

use super::{draft, room, say, spawn, young};
use crate::engine::{
    Engine, NEWER_FORMAT, NewVersion, Prepared, announce_routine, editable, free_slug, insert_version, row,
};
use crate::routes::{BUILTIN, readable};

/// The longest name a routine takes from its sentence.
const NAME_MAX: usize = 60;

/// A name from the sentence's first line, cut at a word.
fn name_of(sentence: &str) -> String {
    let line = sentence.trim().lines().next().unwrap_or_default().trim();
    if line.chars().count() <= NAME_MAX {
        return line.to_owned();
    }
    let cut: String = line.chars().take(NAME_MAX).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head).trim_end();
    format!("{cut}…")
}

/// The draft a routine has before its architect's first proposal: the
/// sentence's name, the rung the user started it at and slots that pass
/// shape, so it is listed and read.
fn placeholder(name: &str, rung: Rung) -> Result<Prepared, Error> {
    let mut value = json!({
        "format": 1,
        "name": name,
        "summary": "",
        "icon": "sparkle",
        "kind": "standing",
        "takes": {"kind": "none", "label": "", "placeholder": "", "empty": "none", "many": false},
        "when": {"on": []},
        "which": {},
        "who": {"depth": "solo", "agents": [], "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"format": "", "checkAgent": false},
        "makes": {"kind": "nothing", "description": ""},
        "freedom": {"rung": rung},
    });
    fill_defaults(&mut value);
    let blueprint = serde_json::from_value(value).map_err(|e| Error::storage(e.to_string()))?;
    Ok(Prepared { blueprint, trust: eos_domain::run_scope::Trust::Trusted })
}

/// The user's routines, one a line, for the architect to steer clear of.
fn routine_names(tx: &dyn Tx) -> Result<String, Error> {
    let mut lines = Vec::new();
    for routine in tx.routines().list()? {
        if routine.origin == BUILTIN || routine.state == RoutineState::Deleted {
            continue;
        }
        lines.push(format!("- {}", routine.name));
    }
    Ok(if lines.is_empty() { "None yet.".into() } else { lines.join("\n") })
}

async fn capability_lines(engine: &Engine) -> Result<String, Error> {
    let capabilities = engine.reads.list().await?;
    let lines: Vec<String> =
        capabilities.iter().map(|c| format!("- {} ({}): {}", c.id, c.manifest.name, c.manifest.summary)).collect();
    Ok(if lines.is_empty() { "Nothing beyond this computer.".into() } else { lines.join("\n") })
}

/// What the user chose with the Home input's pills, as the architect reads
/// it beside the sentence.
fn choices_of(asked: &ArchitectRequest) -> String {
    let mut lines = Vec::new();
    if let Some(rung) = asked.rung {
        let words = if rung == Rung::Ask { "ask before each run" } else { "hold each result as a draft" };
        lines.push(format!("- Freedom: {words} (keep the blueprint's freedom rung at this)"));
    }
    if let Some(project) = &asked.project {
        lines.push(format!("- Project: the project at {project}"));
    }
    if lines.is_empty() { String::new() } else { format!("\n\nWhat the user chose with it:\n{}", lines.join("\n")) }
}

/// `POST /api/routines/architect`: the routine (a draft, origin
/// `architect`), its placeholder version at the rung the user chose, its
/// draft row and its architect, at the model the user chose, whose first
/// message is `routine/architect-make`.
pub(crate) async fn make(engine: &Arc<Engine>, asked: &ArchitectRequest) -> Result<RoutineSaved, Error> {
    room(engine, None)?;
    let (sentence, attachments) = (asked.sentence.as_str(), &asked.attachments);
    let name = name_of(sentence);
    let prepared = placeholder(&name, asked.rung.unwrap_or(Rung::Draft))?;
    let (id, version_id, now) = (engine.ids.routine_id(), engine.ids.routine_version_id(), engine.clock.now_ms());
    let (routine_id, purpose, device) = (id.clone(), sentence.to_owned(), engine.device.clone());
    let patterns = engine.patterns.clone();
    let (saved, routines) = engine
        .store
        .write(move |tx, out| {
            let routines = routine_names(tx)?;
            tx.routines().insert(&StoredRoutine {
                id: id.clone(),
                slug: free_slug(tx, &name, now)?,
                name: name.clone(),
                kind: RoutineKind::Standing,
                state: RoutineState::Draft,
                paused_reason: None,
                head_version_id: None,
                origin: "architect".into(),
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
                author: VersionAuthor::Architect,
                note: None,
                prepared: &prepared,
                device: &device,
                now,
            };
            insert_version(tx, version)?;
            tx.routines().insert_draft(&StoredDraft {
                routine_id: id.clone(),
                purpose,
                architect_id: None,
                base_version_id: None,
                draft_version_id: Some(version_id.clone()),
                question: None,
                status: DraftStatus::Working,
                created_at: now,
                updated_at: now,
            })?;
            tracing::info!(routine_id = %id, "a routine was made for its architect");
            announce_routine(tx, out, &id, RoutineChangeReason::Created, now, &patterns)?;
            let saved = RoutineSaved { row: row(tx, &id, now, &patterns)?, version_id, warnings: Vec::new() };
            Ok((saved, routines))
        })
        .await?;
    let mut request = sentence.to_owned();
    if !attachments.is_empty() {
        request.push_str("\n\nFiles the user gave with it:\n");
        request.push_str(&attachments.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n"));
    }
    request.push_str(&choices_of(asked));
    let prompt = make_prompt(engine, request, routines).await?;
    let name = saved.row.as_ref().map(|row| row.name.clone()).unwrap_or_default();
    let worker_id = spawn(engine, &routine_id, &name, prompt, asked.model.clone()).await?;
    set_architect(engine, &routine_id, &worker_id).await?;
    Ok(saved)
}

async fn make_prompt(engine: &Engine, sentence: String, routines: String) -> Result<String, Error> {
    let values = [("SENTENCE", sentence), ("ROUTINES", routines), ("CAPABILITIES", capability_lines(engine).await?)];
    render(engine, "routine/architect-make", values)
}

/// What a draft with no architect starts a new one from.
enum Restart {
    Make { name: String, sentence: String, routines: String },
    Change { name: String, text: String, blueprint: String },
}

/// A new architect for a draft whose own never started (its session
/// failed to spawn): from the user's sentence for a routine still being
/// made, from the version it changes for a change. Its id; the draft's
/// architect when another start named one first.
pub(crate) async fn restart(engine: &Engine, routine_id: &str) -> Result<String, Error> {
    let id = routine_id.to_owned();
    let from = engine
        .store
        .read(move |tx| {
            let routine = tx.routines().find(&id)?.ok_or_else(|| Error::not_found("routine", &id))?;
            let draft = tx.routines().draft(&id)?.ok_or_else(|| Error::not_found("draft", &id))?;
            let Some(base) = draft.base_version_id else {
                let others = routine_names(tx)?;
                let own = format!("- {}", routine.name);
                let routines = others.lines().filter(|line| *line != own).collect::<Vec<_>>().join("\n");
                let routines = if routines.is_empty() { "None yet.".into() } else { routines };
                return Ok(Restart::Make { name: routine.name, sentence: draft.purpose, routines });
            };
            let version = tx.routine_versions().find(&id, &base)?.ok_or_else(|| Error::not_found("version", &base))?;
            let blueprint = readable(&version)?.ok_or_else(|| Error::Conflict(NEWER_FORMAT.into()))?;
            Ok(Restart::Change { name: routine.name, text: draft.purpose, blueprint: canonical_json(&blueprint) })
        })
        .await?;
    let (name, prompt) = match from {
        Restart::Make { name, sentence, routines } => (name, make_prompt(engine, sentence, routines).await?),
        Restart::Change { name, text, blueprint } => {
            (name, render(engine, "routine/architect-change", [("TEXT", text), ("BLUEPRINT", blueprint)])?)
        }
    };
    let worker_id = spawn(engine, routine_id, &name, prompt, None).await?;
    let named = claim_architect(engine, routine_id, &worker_id).await?;
    if named != worker_id {
        super::suspend(engine, &worker_id).await;
    }
    tracing::info!(routine_id, "a draft with no architect got a new one");
    Ok(named)
}

/// Names `worker_id` the draft's architect unless one is named already;
/// the architect the draft names after.
async fn claim_architect(engine: &Engine, routine_id: &str, worker_id: &str) -> Result<String, Error> {
    let (id, worker, now) = (routine_id.to_owned(), worker_id.to_owned(), engine.clock.now_ms());
    let patterns = engine.patterns.clone();
    engine
        .store
        .write(move |tx, out| {
            let mut draft = tx.routines().draft(&id)?.ok_or_else(|| Error::not_found("draft", &id))?;
            if let Some(named) = draft.architect_id {
                return Ok(named);
            }
            draft.architect_id = Some(worker.clone());
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now, &patterns)?;
            Ok(worker)
        })
        .await
}

fn render<const N: usize>(engine: &Engine, id: &str, values: [(&str, String); N]) -> Result<String, Error> {
    let values = values.into_iter().map(|(name, value)| (name.to_owned(), Value::String(value))).collect();
    engine.prompts.render(id, &values, &no_values())
}

/// Names the routine's architect on its draft row, once its session is up.
async fn set_architect(engine: &Engine, routine_id: &str, worker_id: &str) -> Result<(), Error> {
    let (id, worker, now) = (routine_id.to_owned(), worker_id.to_owned(), engine.clock.now_ms());
    let patterns = engine.patterns.clone();
    engine
        .store
        .write(move |tx, out| {
            let Some(mut draft) = tx.routines().draft(&id)? else { return Ok(()) };
            draft.architect_id = Some(worker);
            draft.updated_at = now;
            tx.routines().update_draft(&draft)?;
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now, &patterns)
        })
        .await
}

/// Who takes a change: the architect to revive, or the head blueprint a
/// new one starts from.
enum Taker {
    Revive(String),
    /// `old` is the architect it replaces.
    Start {
        name: String,
        blueprint: String,
        old: Option<String>,
    },
}

/// `POST /api/routines/:id/change`: the routine's architect gets the
/// request when it is younger than seven days; otherwise a new one starts
/// from the head (`routine/architect-change`). Its proposal is a draft the
/// user keeps through start.
pub(crate) async fn change(engine: &Arc<Engine>, routine_id: &str, text: &str) -> Result<DraftView, Error> {
    let (id, purpose, now) = (routine_id.to_owned(), text.to_owned(), engine.clock.now_ms());
    let patterns = engine.patterns.clone();
    let taker = engine
        .store
        .write(move |tx, out| {
            let routine = editable(tx, &id)?;
            let head = tx.routine_versions().head(&id)?;
            let head = head.ok_or_else(|| Error::Conflict("a routine is changed once it has started".into()))?;
            let blueprint = readable(&head)?.ok_or_else(|| Error::Conflict(NEWER_FORMAT.into()))?;
            let draft = tx.routines().draft(&id)?;
            let architect = draft.as_ref().and_then(|draft| draft.architect_id.clone());
            let session = match &architect {
                Some(worker_id) => tx.routine_sessions().find(worker_id)?,
                None => None,
            };
            let row = StoredDraft {
                routine_id: id.clone(),
                purpose,
                architect_id: architect.clone(),
                base_version_id: Some(head.id.clone()),
                draft_version_id: None,
                question: None,
                status: DraftStatus::Working,
                created_at: now,
                updated_at: now,
            };
            match draft {
                Some(_) => tx.routines().update_draft(&row)?,
                None => tx.routines().insert_draft(&row)?,
            }
            announce_routine(tx, out, &id, RoutineChangeReason::Draft, now, &patterns)?;
            Ok(match (architect, session) {
                (Some(worker_id), Some(session)) if young(&session, now) => Taker::Revive(worker_id),
                (old, _) => Taker::Start { name: routine.name, blueprint: canonical_json(&blueprint), old },
            })
        })
        .await?;
    match taker {
        Taker::Revive(worker_id) => say(engine, &worker_id, text).await?,
        Taker::Start { name, blueprint, old } => {
            if let Some(old) = old {
                super::suspend(engine, &old).await;
            }
            let prompt =
                render(engine, "routine/architect-change", [("TEXT", text.to_owned()), ("BLUEPRINT", blueprint)])?;
            let worker_id = spawn(engine, routine_id, &name, prompt, None).await?;
            set_architect(engine, routine_id, &worker_id).await?;
        }
    }
    tracing::info!(routine_id, "a change was asked of a routine's architect");
    draft::view(engine, routine_id).await
}

#[cfg(test)]
mod tests {
    use super::name_of;

    #[test]
    fn a_long_sentence_names_its_routine_by_its_first_words() {
        assert_eq!(name_of("  Review my pull requests\nevery morning"), "Review my pull requests");
        let long = "Every weekday morning read the new issues in acme/game and sort them into the right milestones";
        assert_eq!(name_of(long), "Every weekday morning read the new issues in acme/game and…");
    }
}
