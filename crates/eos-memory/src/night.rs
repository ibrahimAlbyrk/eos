//! Night tidying (04 G14, G19): once a night, and on demand. The rules'
//! steps always run: every note's state is read again from its counters
//! (unused notes cool), the same lesson learned twice is kept once, a
//! forgotten note's text goes once it can no longer come back, and the
//! journal and the record of uses are pruned. Then, where the host lets a
//! model be asked (the same gate as reflection), at most
//! [`NIGHT_CALLS_PER_DAY`] calls a day turn lessons learned in several places
//! into one general note. The Learning switch stops the model steps.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use eos_contracts::ExperienceChange;
use eos_core::agent::{OneShot, OneShotRequest};
use eos_core::os::TimeZone;
use eos_core::store::{DailyCall, NoteQuery, Store, StoredLink, StoredNote, Tx};
use eos_core::{Clock, Error, Ids};
use eos_domain::experience::clean::clean;
use eos_domain::experience::moments::word_similarity;
use eos_domain::experience::night::{Twin, general_scope, lesson_groups, same_lesson};
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Trust, state};
use eos_domain::redact::Scrubber;
use eos_domain::time::{iso_from_ms, wall_clock};
use serde_json::json;

use crate::credit::restand_in;
use crate::forget::{FORGOTTEN_KEPT_MS, RESTORE_MS};
use crate::merge::{MEMORY_CHANGE, version};
use crate::recall::Recall;
use crate::reflect::{Gate, MODEL, ModelGate, TIMEOUT_MS};
use crate::settings;

/// Model calls the night may make in one local day.
pub const NIGHT_CALLS_PER_DAY: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Done moments are kept this long, uses this long.
const MOMENTS_KEPT_MS: i64 = 30 * DAY_MS;
const USES_KEPT_MS: i64 = 180 * DAY_MS;
const PAGE: i64 = 500;
/// A general note's text, at most.
const GENERAL_CHARS: usize = 300;

/// The prompt that turns several lessons into one, from the library.
pub trait GeneralizePrompt: Send + Sync {
    /// `(system, request)` over the lessons, one a line.
    fn render(&self, lessons: &str) -> Result<(String, String), Error>;
}

pub struct NightParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub zone: Arc<dyn TimeZone>,
    pub one_shot: Arc<dyn OneShot>,
    pub gate: Arc<dyn ModelGate>,
    pub prompt: Arc<dyn GeneralizePrompt>,
    pub recall: Arc<Recall>,
    pub scrubber: Arc<Scrubber>,
    pub device: String,
}

impl std::fmt::Debug for NightParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NightParts").finish_non_exhaustive()
    }
}

/// What one night did, by count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tidied {
    /// Notes whose state changed.
    pub moved: usize,
    /// Notes closed as the same lesson as another.
    pub deduped: usize,
    /// General notes made.
    pub generalized: usize,
    /// Forgotten notes whose text went.
    pub erased: usize,
    /// Stopped before the end.
    pub stopped: bool,
}

/// The general note's text in the model's answer; `None` when it skipped.
fn general_text(answer: &serde_json::Value) -> Option<String> {
    if answer.get("skip").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    answer.get("text").and_then(serde_json::Value::as_str).map(str::to_owned)
}

fn general_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "skip": {"type": "boolean"},
            "text": {"type": "string", "maxLength": GENERAL_CHARS}
        },
        "required": ["skip"]
    })
}

/// A note with the hooks the night compares it by.
struct Seen {
    stored: StoredNote,
    /// Its hooks without the routine's and project's.
    hooks: BTreeSet<String>,
}

pub struct Night(NightParts);

impl std::fmt::Debug for Night {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Night").finish_non_exhaustive()
    }
}

impl Night {
    pub fn new(parts: NightParts) -> Self {
        Self(parts)
    }

    fn day(&self, now: i64) -> String {
        let local = wall_clock(now, &|at| self.0.zone.offset_minutes_at(at));
        iso_from_ms(local).chars().take(10).collect()
    }

    /// Tidies every note; `stop` ends it between steps and between calls.
    pub async fn tidy(&self, stop: &AtomicBool) -> Result<Tidied, Error> {
        let started = self.0.clock.now_ms();
        let mut tidied = Tidied::default();
        self.prune(started, &mut tidied).await?;
        let notes = self.read().await?;
        tidied.moved = self.restand(&notes, started).await?;
        tidied.deduped = self.dedupe(&notes).await?;
        let learning = self.0.store.read(|tx| Ok(settings::read_in(tx)?.learning)).await?;
        if learning && !stop.load(Ordering::SeqCst) && self.0.gate.gate().await == Gate::Model {
            tidied.generalized = self.generalize(&notes, stop).await?;
        }
        tidied.stopped = stop.load(Ordering::SeqCst);
        tracing::info!(
            moved = tidied.moved,
            deduped = tidied.deduped,
            generalized = tidied.generalized,
            erased = tidied.erased,
            stopped = tidied.stopped,
            ms = self.0.clock.now_ms() - started,
            "memory: night tidied"
        );
        Ok(tidied)
    }

    /// The journal, the uses and the forgotten: what may go, goes.
    async fn prune(&self, now: i64, tidied: &mut Tidied) -> Result<(), Error> {
        tidied.erased = self
            .0
            .store
            .write(move |tx, _| {
                tx.mem_moments().prune_done(now - MOMENTS_KEPT_MS)?;
                tx.mem_uses().prune(now - USES_KEPT_MS)?;
                tx.mem_book().prune_forgotten(now - FORGOTTEN_KEPT_MS)?;
                let mut erased = 0;
                let query = NoteQuery { forgotten: true, limit: i64::MAX, ..NoteQuery::default() };
                for stored in tx.mem_notes().list(&query)? {
                    if stored.forgotten_at.is_some_and(|at| at < now - RESTORE_MS) {
                        tx.mem_notes().delete(&stored.note.id)?;
                        // Nothing brings it back now: only its fingerprint stays.
                        if let Some(mut record) = tx.mem_book().forgotten(&stored.note.id)? {
                            record.snapshot = "{}".to_owned();
                            tx.mem_book().put_forgotten(&record)?;
                        }
                        erased += 1;
                    }
                }
                Ok(erased)
            })
            .await?;
        Ok(())
    }

    /// Every note not closed, with its hooks.
    async fn read(&self) -> Result<Vec<Seen>, Error> {
        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let query = NoteQuery { before: before.clone(), limit: PAGE, ..NoteQuery::default() };
            let page = self.0.store.read(move |tx| page_in(tx, &query)).await?;
            let Some(last) = page.last() else { break };
            before = Some((last.stored.note.updated_at, last.stored.note.id.clone()));
            let full = page.len() as i64 == PAGE;
            seen.extend(page.into_iter().filter(|s| s.stored.note.state != NoteState::Closed));
            if !full {
                break;
            }
        }
        Ok(seen)
    }

    async fn restand(&self, notes: &[Seen], now: i64) -> Result<usize, Error> {
        let mut moved = 0;
        for chunk in notes.chunks(PAGE as usize) {
            let ids: Vec<(String, NoteState)> =
                chunk.iter().map(|s| (s.stored.note.id.clone(), s.stored.note.state)).collect();
            moved += self
                .0
                .store
                .write(move |tx, out| {
                    let mut changed = Vec::new();
                    for (id, was) in ids {
                        if restand_in(tx, &id, now)?.is_some_and(|state| state != was) {
                            changed.push(id);
                        }
                    }
                    let count = changed.len();
                    if count > 0 {
                        out.push(MEMORY_CHANGE, &ExperienceChange { ids: changed, action: "changed".into() });
                    }
                    Ok(count)
                })
                .await?;
        }
        Ok(moved)
    }

    /// How alike two notes' meanings are: their vectors, else their words.
    fn meaning(&self, a: &StoredNote, b: &StoredNote) -> f64 {
        self.0.recall.similarity(a.rowid, b.rowid).unwrap_or_else(|| word_similarity(&a.note.text, &b.note.text))
    }

    async fn dedupe(&self, notes: &[Seen]) -> Result<usize, Error> {
        let mut by_hooks: HashMap<&BTreeSet<String>, Vec<&Seen>> = HashMap::new();
        for seen in notes.iter().filter(|s| !s.hooks.is_empty()) {
            by_hooks.entry(&seen.hooks).or_default().push(seen);
        }
        let mut closing: Vec<(String, String)> = Vec::new();
        let mut closed: BTreeSet<String> = BTreeSet::new();
        for group in by_hooks.values() {
            for (i, a) in group.iter().enumerate() {
                for b in &group[i + 1..] {
                    if closed.contains(&a.stored.note.id) || closed.contains(&b.stored.note.id) {
                        continue;
                    }
                    if let Some((kept, gone)) = same_lesson(&twin(a), &twin(b), self.meaning(&a.stored, &b.stored)) {
                        closed.insert(gone.clone());
                        closing.push((kept, gone));
                    }
                }
            }
        }
        let count = closing.len();
        if count > 0 {
            let (device, now) = (self.0.device.clone(), self.0.clock.now_ms());
            self.0.store.write(move |tx, out| close_in(tx, out, &closing, "same", &device, now)).await?;
        }
        Ok(count)
    }

    async fn generalize(&self, notes: &[Seen], stop: &AtomicBool) -> Result<usize, Error> {
        let lessons: Vec<(String, BTreeSet<String>)> = notes
            .iter()
            .filter(|s| s.stored.note.kind == NoteKind::Lesson && s.stored.note.trust != Trust::Guess)
            .map(|s| (s.stored.note.id.clone(), s.hooks.clone()))
            .collect();
        let by_id: HashMap<&str, &Seen> = notes.iter().map(|s| (s.stored.note.id.as_str(), s)).collect();
        let mut made = 0;
        for group in lesson_groups(&lessons) {
            if stop.load(Ordering::SeqCst) || !self.count_call().await? {
                break;
            }
            let members: Vec<&Seen> = group.iter().filter_map(|id| by_id.get(id.as_str()).copied()).collect();
            let listed: Vec<String> = members.iter().map(|s| format!("- {}", s.stored.note.text)).collect();
            let (system, prompt) = self.0.prompt.render(&listed.join("\n"))?;
            let request = OneShotRequest::new(prompt)
                .system(system)
                .model(Some(MODEL))
                .schema(general_schema())
                .timeout_ms(TIMEOUT_MS);
            let answer = match self.0.one_shot.complete(request).await {
                Ok(answer) => answer.structured.as_ref().and_then(general_text),
                Err(e) => {
                    tracing::warn!(error = %e, "memory: a general note was not made");
                    None
                }
            };
            let Some(text) = answer else { continue };
            let Ok(text) = clean(&self.0.scrubber, &text) else { continue };
            if text.trim().is_empty() {
                continue;
            }
            let note = self.general_note(&members, text);
            let (members, device) = (group.clone(), self.0.device.clone());
            self.0.store.write(move |tx, out| insert_general_in(tx, out, &note, &members, &device)).await?;
            made += 1;
        }
        Ok(made)
    }

    /// One more night call today, unless the day's are spent.
    async fn count_call(&self) -> Result<bool, Error> {
        let day = self.day(self.0.clock.now_ms());
        self.0
            .store
            .write(move |tx, _| {
                if tx.mem_book().daily(&day)?.night_calls >= NIGHT_CALLS_PER_DAY {
                    return Ok(false);
                }
                tx.mem_book().count_call(&day, DailyCall::Night).map(|_| true)
            })
            .await
    }

    fn general_note(&self, members: &[&Seen], text: String) -> Note {
        let now = self.0.clock.now_ms();
        let scopes: Vec<_> = members.iter().map(|s| s.stored.note.scope.clone()).collect();
        // The weakest trust among its lessons bounds the general note.
        let trust = members.iter().map(|s| s.stored.note.trust).min_by(|a, b| a.cap().total_cmp(&b.cap()));
        let trust = trust.unwrap_or(Trust::Outcome);
        let first = &members[0].stored.note;
        Note {
            id: self.0.ids.note_id(),
            kind: NoteKind::Lesson,
            text,
            body: NoteBody::None {},
            trust,
            state: state::initial(trust),
            scope: general_scope(&scopes),
            valid_from: now,
            valid_to: None,
            replaced_by: None,
            do_hooks: first.do_hooks.clone(),
            avoid_hooks: first.avoid_hooks.clone(),
            created_at: now,
            updated_at: now,
            device: self.0.device.clone(),
        }
    }
}

fn twin(seen: &Seen) -> Twin<'_> {
    Twin { id: &seen.stored.note.id, kind: seen.stored.note.kind, scope: &seen.stored.note.scope, hooks: &seen.hooks }
}

/// A page of notes with the hooks each is about, the routine's and the
/// project's left out.
fn page_in(tx: &dyn Tx, query: &NoteQuery) -> Result<Vec<Seen>, Error> {
    let notes = tx.mem_notes().list(query)?;
    let ids: Vec<String> = notes.iter().map(|n| n.note.id.clone()).collect();
    let links = tx.mem_graph().links(&ids)?;
    let about: Vec<&StoredLink> = links.iter().filter(|l| l.rel == "about" && l.b.starts_with("mh-")).collect();
    let hook_ids: Vec<String> = about.iter().map(|l| l.b.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let scoped: BTreeSet<String> = tx
        .mem_graph()
        .hooks(&hook_ids)?
        .into_iter()
        .filter(|h| matches!(h.kind, HookKind::Routine | HookKind::Project))
        .map(|h| h.id)
        .collect();
    let mut hooks: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for link in about.iter().filter(|l| !scoped.contains(&l.b)) {
        hooks.entry(link.a.as_str()).or_default().insert(link.b.clone());
    }
    Ok(notes
        .iter()
        .map(|stored| Seen {
            hooks: hooks.get(stored.note.id.as_str()).cloned().unwrap_or_default(),
            stored: stored.clone(),
        })
        .collect())
}

/// Closes each `(by, closed)` pair's second note as replaced by its first.
fn close_in(
    tx: &dyn Tx,
    out: &mut eos_core::store::Outbox,
    pairs: &[(String, String)],
    why: &str,
    device: &str,
    now: i64,
) -> Result<(), Error> {
    let mut changed = Vec::new();
    for (by, id) in pairs {
        let Some(old) = tx.mem_notes().find(id)? else { continue };
        if old.note.state == NoteState::Closed {
            continue;
        }
        let mut closed = old.note.clone();
        closed.state = NoteState::Closed;
        closed.replaced_by = Some(by.clone());
        closed.updated_at = now.max(old.note.updated_at);
        closed.device = device.to_owned();
        tx.mem_notes().update(&closed, &old.cues, old.rev + 1)?;
        tx.mem_versions().insert(&version(&closed, old.rev + 1, why, now))?;
        changed.push(id.clone());
    }
    if !changed.is_empty() {
        out.push(MEMORY_CHANGE, &ExperienceChange { ids: changed, action: "changed".into() });
    }
    Ok(())
}

/// The general note with its lessons' hooks, linked to each lesson, which it
/// replaces; nothing when the user forgot that note.
fn insert_general_in(
    tx: &dyn Tx,
    out: &mut eos_core::store::Outbox,
    note: &Note,
    members: &[String],
    device: &str,
) -> Result<(), Error> {
    let now = note.created_at;
    let links = tx.mem_graph().links(members)?;
    let hooks: BTreeSet<String> =
        links.iter().filter(|l| l.rel == "about" && l.b.starts_with("mh-")).map(|l| l.b.clone()).collect();
    let hook_ids: Vec<String> = hooks.iter().cloned().collect();
    if crate::forget::forgotten_again_in(tx, &note.text, &hook_ids, now)? {
        return Ok(());
    }
    let stored_hooks = tx.mem_graph().hooks(&hook_ids)?;
    let cues = stored_hooks.iter().map(|h| h.key.as_str()).collect::<Vec<_>>().join(" ");
    tx.mem_notes().insert(note, &cues)?;
    for hook in &hooks {
        let about = StoredLink {
            a: note.id.clone(),
            b: hook.clone(),
            rel: "about".into(),
            weight: 1.0,
            co_uses: 0,
            updated_at: now,
        };
        tx.mem_graph().put_link(&about)?;
    }
    tx.mem_graph().recount_degrees(&hooks.into_iter().collect::<Vec<_>>())?;
    for member in members {
        let from = StoredLink {
            a: note.id.clone(),
            b: member.clone(),
            rel: "replaces".into(),
            weight: 1.0,
            co_uses: 0,
            updated_at: now,
        };
        tx.mem_graph().put_link(&from)?;
    }
    tx.mem_versions().insert(&version(note, 1, "generalized", now))?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note.id.clone()], action: "learned".into() });
    let pairs: Vec<(String, String)> = members.iter().map(|m| (note.id.clone(), m.clone())).collect();
    close_in(tx, out, &pairs, "generalized", device, now)
}
