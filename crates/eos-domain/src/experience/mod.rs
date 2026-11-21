//! Experience: small linked notes learned from the user's corrections and
//! the work's outcomes, recalled by situation. The rules over a note's kind,
//! trust, scope, state and strength, how notes rank, what fits a budget and
//! how a block of notes is written for the model. Pure: times come in as
//! arguments, and nothing here logs (note text is user data).

pub mod budget;
pub mod clean;
pub mod cues;
pub mod fingerprint;
pub mod merge;
pub mod moments;
pub mod night;
pub mod note;
pub mod rank;
pub mod reflect;
pub mod render;
pub mod spread;
pub mod state;

pub use note::{HookKind, Note, NoteBody, NoteKind, NoteState, PlaybookLine, Scope, ScopeLevel, Trust, hook_id};
