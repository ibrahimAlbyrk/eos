//! Memory's notes and their graph: `mem_notes` with its search index,
//! `mem_vectors`, `mem_versions`, `mem_evidence`, `mem_hooks`, `mem_links`
//! and `mem_credit`. Note text, cues, hook keys and evidence are the user's
//! data: never logged.

use eos_domain::experience::state::Counters;
use eos_domain::experience::{HookKind, Note, NoteKind, NoteState, ScopeLevel};

use crate::Error;

/// Evidence kept per note, newest first.
pub const MEM_EVIDENCE_PER_NOTE: i64 = 50;
/// Live notes the store holds at most.
pub const MEM_NOTES_MAX: i64 = 50_000;

/// A row of `mem_notes`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredNote {
    /// The table's row number: the search index and the vectors name a note by it.
    pub rowid: i64,
    pub note: Note,
    /// The hooks' keys split into words, searched with the text.
    pub cues: String,
    /// Sums of `mem_credit` over every Mac.
    pub counters: Counters,
    pub activation: f64,
    /// One up per change of text, scope or state.
    pub rev: i64,
    pub forgotten_at: Option<i64>,
}

/// Which notes a list shows, newest change first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NoteQuery {
    pub scope: Option<(ScopeLevel, Option<String>)>,
    pub kind: Option<NoteKind>,
    pub state: Option<NoteState>,
    /// Words to search for.
    pub words: Option<String>,
    /// Only notes changed before this (`updated_at`, then id), for the next page.
    pub before: Option<(i64, String)>,
    pub limit: i64,
    /// Forgotten notes too.
    pub forgotten: bool,
}

/// How many live notes hold in one scope, of one kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCount {
    pub scope: eos_domain::experience::Scope,
    pub kind: NoteKind,
    pub count: i64,
}

/// A match of the search by words: lower `rank` is better (bm25).
#[derive(Debug, Clone, PartialEq)]
pub struct WordHit {
    pub rowid: i64,
    pub rank: f64,
}

/// A row of `mem_vectors`: a note's meaning, int8 with its scale.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredVector {
    pub note_rowid: i64,
    pub model: String,
    pub scale: f32,
    pub vec: Vec<i8>,
}

/// A row of `mem_versions`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredNoteVersion {
    pub note_id: String,
    pub rev: i64,
    pub text: String,
    /// As JSON.
    pub body: String,
    pub scope_level: ScopeLevel,
    pub scope_key: String,
    pub state: NoteState,
    /// `learned`, `corrected`, `edited`, `merged`, `narrowed`, `restored` or `closed`.
    pub why: String,
    pub at: i64,
}

/// A row of `mem_evidence`: what a note was learned or confirmed from.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvidence {
    pub id: String,
    pub note_id: String,
    /// The moment's signal.
    pub kind: String,
    /// At most 200 characters, cleaned.
    pub summary: String,
    pub worker_id: Option<String>,
    pub row_from: Option<i64>,
    pub row_to: Option<i64>,
    pub run_id: Option<String>,
    pub at: i64,
    pub device: String,
}

pub trait MemNoteRepo {
    /// Writes a new note; answers its row number.
    fn insert(&self, note: &Note, cues: &str) -> Result<i64, Error>;
    /// Writes a note's text, body, trust, state, scope, validity, successor,
    /// hooks, change time, device and `rev` in place of the stored ones.
    fn update(&self, note: &Note, cues: &str, rev: i64) -> Result<(), Error>;
    fn find(&self, id: &str) -> Result<Option<StoredNote>, Error>;
    fn find_rows(&self, rowids: &[i64]) -> Result<Vec<StoredNote>, Error>;
    fn list(&self, query: &NoteQuery) -> Result<Vec<StoredNote>, Error>;
    /// The best `limit` matches of `words` (each word searched as a prefix)
    /// among notes not forgotten.
    fn search_words(&self, words: &str, limit: i64) -> Result<Vec<WordHit>, Error>;
    /// Stores the counters summed from `mem_credit`, the activation and the state.
    fn set_standing(&self, id: &str, counters: Counters, activation: f64, state: NoteState) -> Result<(), Error>;
    /// Marks a note forgotten (or not, with `None`).
    fn set_forgotten(&self, id: &str, at: Option<i64>) -> Result<(), Error>;
    /// Deletes a note and everything that belongs to it.
    fn delete(&self, id: &str) -> Result<(), Error>;
    /// Notes changed after `since`, oldest change first.
    fn changed_since(&self, since: i64) -> Result<Vec<StoredNote>, Error>;
    /// Every note's id.
    fn ids(&self) -> Result<Vec<String>, Error>;
    /// Notes neither closed nor forgotten.
    fn live_count(&self) -> Result<i64, Error>;
    /// Notes neither closed nor forgotten, counted by scope and kind.
    fn live_counts(&self) -> Result<Vec<LiveCount>, Error>;
    /// Notes neither closed nor forgotten, of every kind but episode, made at
    /// or after `since`.
    fn learned_since(&self, since: i64) -> Result<i64, Error>;
}

pub trait MemVectorRepo {
    fn put(&self, vector: &StoredVector) -> Result<(), Error>;
    /// Every vector made by `model`.
    fn all(&self, model: &str) -> Result<Vec<StoredVector>, Error>;
    /// Up to `limit` notes, not forgotten, with no vector by `model`: row number and text.
    fn missing(&self, model: &str, limit: i64) -> Result<Vec<(i64, String)>, Error>;
    /// Removes every vector made by a model other than `model`; answers how many.
    fn keep_only(&self, model: &str) -> Result<usize, Error>;
    fn clear(&self) -> Result<(), Error>;
}

pub trait MemVersionRepo {
    fn insert(&self, version: &StoredNoteVersion) -> Result<(), Error>;
    /// A note's versions, newest first.
    fn of_note(&self, note_id: &str) -> Result<Vec<StoredNoteVersion>, Error>;
}

pub trait MemEvidenceRepo {
    /// Adds evidence and keeps only the note's newest [`MEM_EVIDENCE_PER_NOTE`].
    fn insert(&self, evidence: &StoredEvidence) -> Result<(), Error>;
    /// A note's evidence, newest first.
    fn of_note(&self, note_id: &str, limit: i64) -> Result<Vec<StoredEvidence>, Error>;
}

/// A row of `mem_hooks`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredHook {
    /// `mh-`, from `hook_id(kind, key)`.
    pub id: String,
    pub kind: HookKind,
    pub key: String,
    pub label: String,
    /// How many notes it is about.
    pub degree: i64,
}

/// A row of `mem_links`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredLink {
    pub a: String,
    pub b: String,
    /// `about`, `because`, `replaces`, `refines`, `same` or `seen_together`.
    pub rel: String,
    pub weight: f64,
    pub co_uses: i64,
    pub updated_at: i64,
}

pub trait MemGraphRepo {
    /// Writes a hook if its id is new; answers whether it was.
    fn add_hook(&self, hook: &StoredHook) -> Result<bool, Error>;
    fn hooks(&self, ids: &[String]) -> Result<Vec<StoredHook>, Error>;
    /// Counts each hook's `about` links again.
    fn recount_degrees(&self, ids: &[String]) -> Result<(), Error>;
    /// Writes a link in place of the same `(a, b, rel)`.
    fn put_link(&self, link: &StoredLink) -> Result<(), Error>;
    fn remove_link(&self, a: &str, b: &str, rel: &str) -> Result<(), Error>;
    /// Every link from or to one of `ids`.
    fn links(&self, ids: &[String]) -> Result<Vec<StoredLink>, Error>;
}

/// A row of `mem_credit`: one Mac's counters for one note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCredit {
    pub note_id: String,
    pub device: String,
    pub counters: Counters,
}

pub trait MemCreditRepo {
    /// Adds to this Mac's counters of a note; `used_at` moves its last use.
    fn add(
        &self,
        note_id: &str,
        device: &str,
        helped: i64,
        hurt: i64,
        used: i64,
        used_at: Option<i64>,
    ) -> Result<(), Error>;
    /// Writes one Mac's counters as synced.
    fn put(&self, credit: &StoredCredit) -> Result<(), Error>;
    /// A note's counters summed over every Mac.
    fn sum(&self, note_id: &str) -> Result<Counters, Error>;
    /// One Mac's counters of every note.
    fn of_device(&self, device: &str) -> Result<Vec<StoredCredit>, Error>;
}
