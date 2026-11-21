//! Ports of memory: what turns a note's text into its meaning, how an agent
//! searches what was learned, and what routines ask of memory and tell it
//! (packs for runs, how runs ended). Note text is the user's data: an
//! implementation never logs it and never sends it off the Mac.

use eos_domain::experience::{NoteState, Scope, Trust};

use crate::{BoxFuture, Error};

/// Turns texts into meaning vectors, the same text always into the same
/// vector. Vectors from different models never mix: each stored vector
/// records [`model`](Embedder::model).
pub trait Embedder: Send + Sync {
    /// The model's name, stored with each vector.
    fn model(&self) -> &str;
    /// The length of every vector.
    fn dims(&self) -> usize;
    /// One vector per text, in order.
    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, Error>>;
}

/// A note as an agent's own search finds it.
#[derive(Debug, Clone, PartialEq)]
pub struct FoundNote {
    pub id: String,
    pub text: String,
    pub scope: Scope,
    pub state: NoteState,
    pub trust: Trust,
}

/// `recall_experience` for one agent: notes that match `query` where it
/// works, best first, at most `limit`. [`Error::PermissionDenied`] when the
/// user withholds their profile from the agent's backend kind.
pub trait ExperienceSearch: Send + Sync {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<FoundNote>, Error>>;
}

/// What a routine's run asks memory for before its lead starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPackRequest {
    pub run_id: String,
    pub routine_id: String,
    /// The project key the run works in, when it has one.
    pub project: Option<String>,
    /// The item's own things (its paths, its repository, its sender).
    pub item_cues: Vec<eos_domain::experience::cues::Cue>,
    /// The item's text, for the search by words and meaning.
    pub item_text: String,
    /// A trial or a replay: notes come, but nothing is recorded for credit.
    pub trial: bool,
}

/// The notes a run's lead reads with its brief.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunPack {
    /// The block for the lead's `LaunchSpec.notes`; empty when nothing applies.
    pub text: String,
    pub note_ids: Vec<String>,
    /// Which of `note_ids` are good examples.
    pub example_ids: Vec<String>,
    pub tokens: i64,
}

/// Packs for routines' runs: the routine's playbook, the notes recalled for
/// the item and good examples, within the run's budget (04 G3).
pub trait ExperiencePacks: Send + Sync {
    fn for_run(&self, request: RunPackRequest) -> BoxFuture<'_, Result<RunPack, Error>>;
}

/// How a run ended, once per run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    pub run_id: String,
    pub routine_id: String,
    /// The note the user wrote on the run, if any.
    pub note: Option<String>,
    /// The run's outcome (`sent_unedited`, `sent_edited`, `discarded`,
    /// `auto_sent`, `expired`, `replaced`, `undone`, `shown`, `nothing`) or
    /// `failed`.
    pub kind: String,
}

/// A run's checker did not pass its result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckVerdict {
    pub run_id: String,
    pub routine_id: String,
    /// The run's lead: the moment is read in its conversation.
    pub worker_id: String,
}

/// What routines tell memory about their runs.
pub trait ExperienceFeedback: Send + Sync {
    fn run_ended(&self, outcome: RunOutcome) -> BoxFuture<'_, Result<(), Error>>;
    fn check_failed(&self, verdict: CheckVerdict) -> BoxFuture<'_, Result<(), Error>>;
    /// The routine left the trash for good: its notes close.
    fn routine_removed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}

/// Memory's notes and counters as the sync feature reads and writes them
/// (04 G8): its `experience` domain is built over this.
pub trait ExperienceSync: Send + Sync {
    /// Every record.
    fn list(&self) -> BoxFuture<'_, Result<Vec<eos_domain::sync::SyncItem>, Error>>;
    /// The records changed since `since_ms`, and every record's id.
    fn changed_since(&self, since_ms: i64) -> BoxFuture<'_, Result<crate::net::sync::Changed, Error>>;
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<eos_domain::sync::SyncItem>, Error>>;
    fn apply<'a>(&'a self, id: &'a str, data: &'a serde_json::Value) -> BoxFuture<'a, Result<(), Error>>;
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// One record from both sides when two Macs changed it.
    fn merge(&self, local: &serde_json::Value, remote: &serde_json::Value) -> Option<serde_json::Value>;
}
