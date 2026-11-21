//! Recall by situation: cues seed notes three ways (their hooks, their words,
//! their meaning), activation spreads along links, and the notes that apply
//! to the situation are ranked. One read of the store and one scan of the
//! vectors; nothing waits on a model but the one embedding of a message.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, PoisonError, RwLock};

use eos_core::experience::Embedder;
use eos_core::store::{Store, StoredNote, StoredVector, Tx};
use eos_core::{Clock, Error};
use eos_domain::experience::cues::Cue;
use eos_domain::experience::rank::{Candidate, meaning_match, score};
use eos_domain::experience::spread::{Edge, spread};
use eos_domain::experience::state::strength;
use eos_domain::experience::{HookKind, ScopeLevel, hook_id};

use crate::vectors::{MEANING_SEEDS, VectorIndex, quantize};

/// Matches the search by words offers recall.
const WORD_SEEDS: i64 = 32;
/// Notes embedded in one batch while the index catches up.
pub const EMBED_BATCH: i64 = 256;

/// Where the agent is: what decides which notes apply at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Situation {
    pub routine: Option<String>,
    pub project: Option<String>,
    /// One of the About-you memory domains (`code`, `git`, …), when known.
    pub work_kind: Option<String>,
}

impl Situation {
    /// A note scoped to `level`/`key` applies here. A routine's notes never
    /// apply to another routine or to a chat, and a kind of work's notes
    /// only where that kind is known.
    pub fn admits(&self, level: ScopeLevel, key: &str) -> bool {
        match level {
            ScopeLevel::Routine => self.routine.as_deref() == Some(key),
            ScopeLevel::Project => self.project.as_deref() == Some(key),
            ScopeLevel::Work => self.work_kind.as_deref() == Some(key),
            ScopeLevel::Everywhere => true,
        }
    }
}

/// What a situation offers recall.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cues {
    pub hooks: Vec<Cue>,
    /// Words to search by words and by meaning (a message).
    pub query: Option<String>,
}

/// A note recalled, with its rank.
#[derive(Debug, Clone, PartialEq)]
pub struct Recalled {
    pub note: StoredNote,
    pub score: f64,
}

/// The meaning search, once its model is loaded.
struct Meaning {
    embedder: Arc<dyn Embedder>,
    index: RwLock<VectorIndex>,
}

pub struct Recall {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    meaning: RwLock<Option<Arc<Meaning>>>,
}

impl std::fmt::Debug for Recall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recall").field("meaning", &self.meaning_ready()).finish_non_exhaustive()
    }
}

impl Recall {
    /// Recall by hooks and words only, until [`with_meaning`](Self::with_meaning).
    pub fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> Self {
        Self { store, clock, meaning: RwLock::new(None) }
    }

    pub fn meaning_ready(&self) -> bool {
        self.meaning.read().unwrap_or_else(PoisonError::into_inner).is_some()
    }

    fn meaning(&self) -> Option<Arc<Meaning>> {
        self.meaning.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// How alike two notes' meanings are; `None` while meaning search is off
    /// or either note has no vector.
    pub fn similarity(&self, a: i64, b: i64) -> Option<f64> {
        let meaning = self.meaning()?;
        let index = meaning.index.read().unwrap_or_else(PoisonError::into_inner);
        index.similarity(a, b)
    }

    /// Turns the search by meaning on with a loaded model: the vectors it
    /// made earlier are read into memory.
    pub async fn with_meaning(&self, embedder: Arc<dyn Embedder>) -> Result<(), Error> {
        let model = embedder.model().to_owned();
        let vectors = {
            let model = model.clone();
            self.store.read(move |tx| tx.mem_vectors().all(&model)).await?
        };
        let index = VectorIndex::new(&model, vectors);
        tracing::info!(vectors = index.len(), "memory: meaning search on");
        *self.meaning.write().unwrap_or_else(PoisonError::into_inner) =
            Some(Arc::new(Meaning { embedder, index: RwLock::new(index) }));
        Ok(())
    }

    /// Embeds up to one batch of notes that have no vector yet; answers how
    /// many. Zero once every note has one (or meaning search is off).
    pub async fn embed_missing(&self) -> Result<usize, Error> {
        let Some(meaning) = self.meaning() else { return Ok(0) };
        let model = meaning.embedder.model().to_owned();
        let missing = {
            let model = model.clone();
            self.store.read(move |tx| tx.mem_vectors().missing(&model, EMBED_BATCH)).await?
        };
        if missing.is_empty() {
            return Ok(0);
        }
        let texts: Vec<String> = missing.iter().map(|(_, text)| text.clone()).collect();
        let embedded = meaning.embedder.embed(&texts).await?;
        let vectors: Vec<StoredVector> = missing
            .iter()
            .zip(embedded)
            .map(|((rowid, _), v)| {
                let (scale, vec) = quantize(&v);
                StoredVector { note_rowid: *rowid, model: model.clone(), scale, vec }
            })
            .collect();
        let count = vectors.len();
        let stored = vectors.clone();
        self.store
            .write(move |tx, _| {
                for vector in &stored {
                    tx.mem_vectors().put(vector)?;
                }
                Ok(())
            })
            .await?;
        let mut index = meaning.index.write().unwrap_or_else(PoisonError::into_inner);
        for vector in vectors {
            index.put(vector);
        }
        Ok(count)
    }

    /// The vector of `query`, when meaning search is on.
    async fn query_vector(&self, query: Option<&str>) -> Option<(Arc<Meaning>, Vec<f32>)> {
        let query = query.filter(|q| !q.trim().is_empty())?;
        let meaning = self.meaning()?;
        match meaning.embedder.embed(&[query.to_owned()]).await {
            Ok(mut vectors) if !vectors.is_empty() => Some((meaning, vectors.swap_remove(0))),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(error = %e, "memory: a message was not embedded; recall goes on without meaning");
                None
            }
        }
    }

    /// The best `limit` live notes for `cues` that apply to `situation`.
    pub async fn recall(&self, situation: &Situation, cues: &Cues, limit: usize) -> Result<Vec<Recalled>, Error> {
        let meaning_hits = match self.query_vector(cues.query.as_deref()).await {
            Some((meaning, vector)) => {
                meaning.index.read().unwrap_or_else(PoisonError::into_inner).nearest(&vector, MEANING_SEEDS)
            }
            None => Vec::new(),
        };
        let mut hooks: Vec<String> = cues.hooks.iter().map(|c| hook_id(c.kind, &c.key)).collect();
        // A routine's own notes come back on each of its runs, whatever the item says.
        hooks.extend(situation.routine.as_deref().map(|routine| hook_id(HookKind::Routine, routine)));
        let (situation, query, now) = (situation.clone(), cues.query.clone(), self.clock.now_ms());
        self.store.read(move |tx| ranked(tx, &situation, &hooks, query.as_deref(), &meaning_hits, now, limit)).await
    }
}

/// Every link from or to `ids`, both ways, as spreading walks them.
fn edges(tx: &dyn Tx, ids: &[String]) -> Result<Vec<Edge>, Error> {
    let mut out = Vec::new();
    for link in tx.mem_graph().links(ids)? {
        out.push(Edge { from: link.a.clone(), to: link.b.clone(), weight: link.weight, to_strength: 1.0 });
        out.push(Edge { from: link.b, to: link.a, weight: link.weight, to_strength: 1.0 });
    }
    Ok(out)
}

fn ranked(
    tx: &dyn Tx,
    situation: &Situation,
    hooks: &[String],
    query: Option<&str>,
    meaning_hits: &[(i64, f64)],
    now: i64,
    limit: usize,
) -> Result<Vec<Recalled>, Error> {
    // How well each note matched, by its best channel.
    let mut matched: HashMap<String, f64> = HashMap::new();
    let mut bump = |id: String, value: f64| {
        let slot = matched.entry(id).or_insert(0.0);
        *slot = slot.max(value);
    };
    let hook_set: HashSet<&str> = hooks.iter().map(String::as_str).collect();
    for link in tx.mem_graph().links(hooks)? {
        if link.rel == "about" && hook_set.contains(link.b.as_str()) && link.a.starts_with("mn-") {
            bump(link.a, 1.0);
        }
    }
    let mut by_row: Vec<(i64, f64)> = Vec::new();
    if let Some(query) = query {
        let hits = tx.mem_notes().search_words(query, WORD_SEEDS)?;
        let n = hits.len().max(1) as f64;
        by_row.extend(hits.iter().enumerate().map(|(i, h)| (h.rowid, 0.9 - 0.4 * i as f64 / n)));
    }
    by_row.extend(meaning_hits.iter().map(|(rowid, sim)| (*rowid, meaning_match(*sim))));
    let rows: Vec<i64> = by_row.iter().map(|(r, _)| *r).collect();
    let mut notes: HashMap<String, StoredNote> = HashMap::new();
    for note in tx.mem_notes().find_rows(&rows)? {
        for (_, value) in by_row.iter().filter(|(r, _)| *r == note.rowid) {
            bump(note.note.id.clone(), *value);
        }
        notes.insert(note.note.id.clone(), note);
    }

    let mut seeds: Vec<(String, f64)> = matched.iter().map(|(id, v)| (id.clone(), *v)).collect();
    seeds.extend(hooks.iter().map(|h| (h.clone(), 1.0)));
    let mut failed = None;
    let reached = spread(&seeds, |ids| {
        edges(tx, ids).unwrap_or_else(|e| {
            failed = Some(e);
            Vec::new()
        })
    });
    if let Some(e) = failed {
        return Err(e);
    }

    let mut ids: HashSet<String> = matched.keys().cloned().collect();
    ids.extend(reached.keys().filter(|id| id.starts_with("mn-")).cloned());
    let mut out = Vec::new();
    for id in ids {
        let note = match notes.remove(&id) {
            Some(note) => note,
            None => match tx.mem_notes().find(&id)? {
                Some(note) => note,
                None => continue,
            },
        };
        let n = &note.note;
        if note.forgotten_at.is_some() || !n.live(now) || !situation.admits(n.scope.level, &n.scope.key) {
            continue;
        }
        let candidate = Candidate {
            matched: matched.get(&id).copied().unwrap_or(0.0),
            spread: reached.get(&id).copied().unwrap_or(0.0),
            activation: note.activation,
            strength: strength(n.trust, note.counters.helped, note.counters.hurt),
            scope: &n.scope,
            trust: n.trust,
            state: n.state,
        };
        let score = score(&candidate);
        out.push(Recalled { note, score });
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.note.note.id.cmp(&b.note.note.id)));
    out.truncate(limit);
    Ok(out)
}
