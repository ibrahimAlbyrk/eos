//! Playbooks (04 G12c): one note per routine, kind `playbook`, whose lines
//! every run of the routine reads first. At night, for at most
//! [`REWRITES_PER_NIGHT`] routines whose results the user edited, the
//! model adds lines from the routine's notes; the old lines stay. The
//! candidate is not kept yet: 01's replays run the routine again on up to
//! [`REPLAYS_PER_REWRITE`] of those past items with it, showing their
//! results only. A later night scores them: each replay's result against
//! what the user sent, beside the original run's result. The candidate
//! becomes the playbook's next version only when it comes closer by
//! [`KEEP_MARGIN`](eos_domain::experience::playbook::KEEP_MARGIN); either way the check is kept in `mem_replays`.
//! Candidates under check are kept in `mem_settings` (`playbook.trials`).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_core::agent::OneShotRequest;
use eos_core::routine::RunReplays;
use eos_core::store::{NoteQuery, StoredNote, Tx};
use eos_domain::experience::clean::clean;
use eos_domain::experience::playbook::{text_of, with_additions};
use eos_domain::experience::{Note, NoteBody, NoteKind, NoteState, PlaybookLine, Scope, ScopeLevel, Trust};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::night::Night;
use crate::reflect::{MODEL, TIMEOUT_MS};

mod settle;
use settle::settle_in;

/// Playbooks rewritten in one night, at most.
pub const REWRITES_PER_NIGHT: usize = 2;
/// Past items a candidate is replayed on, at most.
pub const REPLAYS_PER_REWRITE: usize = 3;
/// A candidate whose replays have not all ended is scored anyway after this.
const WAIT_MS: i64 = 24 * 60 * 60 * 1000;
const TRIALS_KEY: &str = "playbook.trials";
/// One added line, at most.
const LINE_CHARS: usize = 200;
/// Edits read in one page.
const EDIT_PAGE: i64 = 500;

/// The prompt that adds lines to a playbook, from the library.
pub trait PlaybookPrompt: Send + Sync {
    /// `(system, request)` over the playbook's lines and the routine's
    /// notes, one a line.
    fn render(&self, playbook: &str, notes: &str) -> Result<(String, String), Error>;
}

/// What the night needs to rewrite playbooks: the prompt and 01's replays.
pub struct PlaybookParts {
    pub prompt: Arc<dyn PlaybookPrompt>,
    pub replays: Arc<dyn RunReplays>,
}

impl std::fmt::Debug for PlaybookParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlaybookParts").finish_non_exhaustive()
    }
}

/// One past run a candidate is checked on, and the user's edit of its result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Past {
    run_id: String,
    edit_id: i64,
}

/// A candidate under check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trial {
    id: String,
    routine_id: String,
    /// The playbook note's version it was written on; 0 when there was none.
    base_rev: i64,
    lines: Vec<PlaybookLine>,
    past: Vec<Past>,
    /// The replay runs, in the order of `past`.
    replays: Vec<String>,
    at: i64,
}

fn trials_in(tx: &dyn Tx) -> Result<Vec<Trial>, Error> {
    let stored = tx.mem_book().setting(TRIALS_KEY)?;
    Ok(stored.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default())
}

fn put_trials_in(tx: &dyn Tx, trials: &[Trial]) -> Result<(), Error> {
    let text = serde_json::to_string(trials).map_err(|e| Error::Storage(e.to_string()))?;
    tx.mem_book().set_setting(TRIALS_KEY, &text)
}

/// A routine's playbook note, when it has one.
pub fn playbook_in(tx: &dyn Tx, routine_id: &str) -> Result<Option<StoredNote>, Error> {
    let query = NoteQuery {
        scope: Some((ScopeLevel::Routine, Some(routine_id.to_owned()))),
        kind: Some(NoteKind::Playbook),
        limit: 10,
        ..NoteQuery::default()
    };
    Ok(tx.mem_notes().list(&query)?.into_iter().find(|n| n.note.state != NoteState::Closed))
}

fn lines_of(note: &Note) -> Vec<PlaybookLine> {
    match &note.body {
        NoteBody::Playbook { lines } => lines.clone(),
        _ => Vec::new(),
    }
}

fn playbook_note(id: &str, routine_id: &str, lines: Vec<PlaybookLine>, now: i64, device: &str) -> Note {
    Note {
        id: id.to_owned(),
        kind: NoteKind::Playbook,
        text: text_of(&lines),
        body: NoteBody::Playbook { lines },
        trust: Trust::Outcome,
        state: NoteState::Firm,
        scope: Scope { level: ScopeLevel::Routine, key: routine_id.to_owned() },
        valid_from: now,
        valid_to: None,
        replaced_by: None,
        do_hooks: Vec::new(),
        avoid_hooks: Vec::new(),
        created_at: now,
        updated_at: now,
        device: device.to_owned(),
    }
}

/// The playbook a run of `routine_id` reads: candidate `candidate` for a
/// replay of it, else the routine's own.
pub fn for_pack_in(
    tx: &dyn Tx,
    routine_id: &str,
    candidate: Option<&str>,
    now: i64,
) -> Result<Option<StoredNote>, Error> {
    let current = playbook_in(tx, routine_id)?;
    let Some(candidate) = candidate else { return Ok(current) };
    let trial = trials_in(tx)?.into_iter().find(|t| t.id == candidate && t.routine_id == routine_id);
    let Some(trial) = trial else { return Ok(current) };
    let mut shown = current.unwrap_or_else(|| StoredNote {
        rowid: 0,
        note: playbook_note(&trial.id, routine_id, Vec::new(), now, ""),
        cues: String::new(),
        counters: Default::default(),
        activation: 0.0,
        rev: 0,
        forgotten_at: None,
    });
    shown.note.text = text_of(&trial.lines);
    shown.note.body = NoteBody::Playbook { lines: trial.lines };
    Ok(Some(shown))
}

/// What one night did with playbooks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Rewritten {
    /// Candidates sent to replay.
    pub tried: usize,
    /// Candidates scored.
    pub scored: usize,
    /// Of those, kept as the playbook's next version.
    pub kept: usize,
}

/// The routines whose results the user edited, latest edit first, each with
/// its newest edited runs (at most [`REPLAYS_PER_REWRITE`]), newest first.
fn edited_in(tx: &dyn Tx) -> Result<Vec<(String, Vec<Past>)>, Error> {
    // routine → run → (its latest edit, when)
    let mut runs: BTreeMap<String, BTreeMap<String, (i64, i64)>> = BTreeMap::new();
    let mut cursor = 0;
    loop {
        let page = tx.inbox_edits().since(cursor, EDIT_PAGE)?;
        for stored in &page {
            let edit = &stored.edit;
            runs.entry(edit.routine_id.clone()).or_default().insert(edit.run_id.clone(), (stored.id, edit.at));
            cursor = stored.id;
        }
        if (page.len() as i64) < EDIT_PAGE {
            break;
        }
    }
    let mut routines: Vec<(i64, String, Vec<Past>)> = runs
        .into_iter()
        .map(|(routine, runs)| {
            let mut runs: Vec<(String, (i64, i64))> = runs.into_iter().collect();
            runs.sort_by_key(|(_, (id, _))| std::cmp::Reverse(*id));
            let latest = runs.first().map_or(0, |(_, (_, at))| *at);
            let past = runs
                .into_iter()
                .take(REPLAYS_PER_REWRITE)
                .map(|(run_id, (edit_id, _))| Past { run_id, edit_id })
                .collect();
            (latest, routine, past)
        })
        .collect();
    routines.sort_by_key(|(latest, _, _)| std::cmp::Reverse(*latest));
    Ok(routines.into_iter().map(|(_, routine, past)| (routine, past)).collect())
}

/// What a rewrite starts from: the playbook's lines and version, and the
/// routine's notes that are not in it yet.
struct Base {
    lines: Vec<PlaybookLine>,
    rev: i64,
    notes: Vec<(String, String)>,
}

fn base_in(tx: &dyn Tx, routine_id: &str) -> Result<Option<Base>, Error> {
    let active = tx.routines().find(routine_id)?.is_some_and(|r| r.state == RoutineState::Active);
    if !active {
        return Ok(None);
    }
    let playbook = playbook_in(tx, routine_id)?;
    let lines = playbook.as_ref().map(|p| lines_of(&p.note)).unwrap_or_default();
    let used: BTreeSet<&str> = lines.iter().flat_map(|l| l.from.iter().map(String::as_str)).collect();
    let query = NoteQuery {
        scope: Some((ScopeLevel::Routine, Some(routine_id.to_owned()))),
        limit: 200,
        ..NoteQuery::default()
    };
    let notes: Vec<(String, String)> = tx
        .mem_notes()
        .list(&query)?
        .into_iter()
        .map(|stored| stored.note)
        .filter(|n| matches!(n.kind, NoteKind::Lesson | NoteKind::Fact | NoteKind::Skill))
        .filter(|n| matches!(n.state, NoteState::Firm | NoteState::Trying) && n.trust != Trust::Guess)
        .filter(|n| !used.contains(n.id.as_str()))
        .map(|n| (n.id, n.text))
        .collect();
    if notes.is_empty() {
        return Ok(None);
    }
    Ok(Some(Base { lines, rev: playbook.map_or(0, |p| p.rev), notes }))
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "skip": {"type": "boolean"},
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "maxLength": LINE_CHARS},
                        "from": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["text", "from"]
                }
            }
        },
        "required": ["skip"]
    })
}

/// The lines the model added, each with the offered notes it came from.
fn added(answer: &Value, offered: &BTreeSet<String>) -> Vec<PlaybookLine> {
    if answer.get("skip").and_then(Value::as_bool).unwrap_or(false) {
        return Vec::new();
    }
    let lines = answer.get("lines").and_then(Value::as_array).cloned().unwrap_or_default();
    lines
        .iter()
        .filter_map(|line| {
            let text = line.get("text")?.as_str()?.chars().take(LINE_CHARS).collect::<String>();
            let from = line.get("from").and_then(Value::as_array).cloned().unwrap_or_default();
            let from = from.iter().filter_map(Value::as_str).filter(|id| offered.contains(*id)).map(str::to_owned);
            Some(PlaybookLine { text, from: from.collect() })
        })
        .collect()
}

impl Night {
    /// Scores the candidates whose replays ended; the rules alone, always.
    pub(crate) async fn settle_playbooks(&self, rewritten: &mut Rewritten) -> Result<(), Error> {
        let (now, device) = (self.0.clock.now_ms(), self.0.device.clone());
        let (scored, kept) = self.0.store.write(move |tx, out| settle_in(tx, out, now, &device)).await?;
        rewritten.scored = scored;
        rewritten.kept = kept;
        Ok(())
    }

    /// Writes candidates for the routines the user edited most lately and
    /// sends each to replay; one night call each.
    pub(crate) async fn rewrite_playbooks(
        &self,
        parts: &PlaybookParts,
        stop: &AtomicBool,
        rewritten: &mut Rewritten,
    ) -> Result<(), Error> {
        let (edited, waiting) = self
            .0
            .store
            .read(|tx| {
                let waiting: BTreeSet<String> = trials_in(tx)?.into_iter().map(|t| t.routine_id).collect();
                Ok((edited_in(tx)?, waiting))
            })
            .await?;
        for (routine_id, past) in edited.into_iter().filter(|(routine, _)| !waiting.contains(routine)) {
            if rewritten.tried >= REWRITES_PER_NIGHT || stop.load(Ordering::SeqCst) {
                break;
            }
            let id = routine_id.clone();
            let Some(base) = self.0.store.read(move |tx| base_in(tx, &id)).await? else { continue };
            if !self.count_call().await? {
                break;
            }
            let notes: Vec<String> = base.notes.iter().map(|(id, text)| format!("- [{id}] {text}")).collect();
            let current: Vec<String> = base.lines.iter().map(|l| format!("- {}", l.text)).collect();
            let (system, prompt) = parts.prompt.render(&current.join("\n"), &notes.join("\n"))?;
            let request =
                OneShotRequest::new(prompt).system(system).model(Some(MODEL)).schema(schema()).timeout_ms(TIMEOUT_MS);
            let answer = match self.0.one_shot.complete(request).await {
                Ok(answer) => answer.structured.unwrap_or(Value::Null),
                Err(e) => {
                    tracing::warn!(error = %e, "memory: a playbook was not rewritten");
                    continue;
                }
            };
            let offered: BTreeSet<String> = base.notes.iter().map(|(id, _)| id.clone()).collect();
            let cleaned: Vec<PlaybookLine> = added(&answer, &offered)
                .into_iter()
                .filter_map(|line| clean(&self.0.scrubber, &line.text).ok().map(|text| PlaybookLine { text, ..line }))
                .collect();
            let lines = with_additions(&base.lines, cleaned);
            if lines.len() == base.lines.len() {
                continue;
            }
            let trial = Trial {
                id: self.0.ids.note_id(),
                routine_id: routine_id.clone(),
                base_rev: base.rev,
                lines,
                past,
                replays: Vec::new(),
                at: self.0.clock.now_ms(),
            };
            self.replay(parts, trial).await?;
            rewritten.tried += 1;
        }
        Ok(())
    }

    /// Keeps the candidate, then asks 01 to replay it; a refused replay
    /// drops it.
    async fn replay(&self, parts: &PlaybookParts, mut trial: Trial) -> Result<(), Error> {
        let kept = trial.clone();
        self.0
            .store
            .write(move |tx, _| {
                let mut trials = trials_in(tx)?;
                trials.push(kept);
                put_trials_in(tx, &trials)
            })
            .await?;
        let runs: Vec<String> = trial.past.iter().map(|p| p.run_id.clone()).collect();
        let started = parts.replays.replay(&trial.routine_id, &trial.id, &runs).await;
        let id = trial.id.clone();
        match started {
            Ok(replays) => {
                tracing::info!(runs = replays.len(), "memory: a playbook candidate is replayed");
                trial.replays = replays;
                self.0
                    .store
                    .write(move |tx, _| {
                        let mut trials = trials_in(tx)?;
                        trials.iter_mut().filter(|t| t.id == trial.id).for_each(|t| t.replays = trial.replays.clone());
                        put_trials_in(tx, &trials)
                    })
                    .await
            }
            Err(e) => {
                tracing::warn!(error = ?e, "memory: a playbook candidate could not be replayed");
                self.0
                    .store
                    .write(move |tx, _| {
                        let trials: Vec<Trial> = trials_in(tx)?.into_iter().filter(|t| t.id != id).collect();
                        put_trials_in(tx, &trials)
                    })
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn added_lines_name_only_offered_notes() {
        let offered: BTreeSet<String> = ["mn-1".to_owned()].into();
        let answer = json!({"skip": false, "lines": [{"text": "Name the test.", "from": ["mn-1", "mn-9"]}]});
        assert_eq!(
            added(&answer, &offered),
            vec![PlaybookLine { text: "Name the test.".into(), from: vec!["mn-1".into()] }]
        );
        assert!(added(&json!({"skip": true, "lines": [{"text": "x", "from": []}]}), &offered).is_empty());
    }
}
