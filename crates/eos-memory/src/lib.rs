//! Memory: notes learned from the user's corrections and the work's
//! outcomes, brought back by situation.
//!
//! - [`Recall`] seeds notes from a situation's cues three ways (the hooks
//!   they are about, their words, their meaning), spreads activation along
//!   links and ranks what applies; the vectors live in a [`VectorIndex`] in
//!   memory, loaded once a model is (until then recall uses hooks and words).
//! - [`Capture`] reads a worker's rows after its cursor for the moments
//!   memory learns from.
//! - [`deliver`] builds a reminder and records each note that reached a
//!   model (`mem_uses`, announced on `memory:recalled`).
//! - [`reflect`] turns pending moments into notes (the small model where
//!   the host lets it ask one, the rules elsewhere) and [`merge`] writes
//!   them beside the notes they meet, in one job.
//! - [`night`] tidies once a night: states read again, the same lesson
//!   kept once, forgotten text erased, lessons made general; [`playbook`]
//!   rewrites a routine's playbook and keeps it only after a better replay.
//! - [`credit`] moves notes' counters and states by what followed their
//!   recall: acted on, a good end, a surprise, "Not right".
//! - [`edits`] reads the user's edits of routines' results as moments.
//! - [`feedback`] packs a routine's run and hears how it ended.
//! - [`forget`] forgets a note and brings it back within 30 days.
//! - [`settings`] reads and writes the user's Learning and Reminders
//!   switches.
//! - [`chat_pack`] turns what was recalled into the block a chat's model
//!   reads at the start of each epoch.
//!
//! Note text, cues and hook keys are the user's data: logged by count and
//! kind only, never by content.

pub mod capture;
pub mod credit;
pub mod deliver;
pub mod edits;
pub mod export;
pub mod feedback;
pub mod forget;
pub mod merge;
pub mod night;
pub mod pack;
pub mod playbook;
pub mod recall;
pub mod reflect;
pub mod settings;
pub mod stated;
pub mod sync;
pub mod transcript;
pub mod vectors;

pub use capture::{Capture, Captured};
pub use credit::{ChatOutcome, Credit};
pub use feedback::Feedback;
pub use pack::{Pack, chat_pack, run_pack};
pub use recall::{Cues, Recall, Recalled, Situation};
pub use reflect::{Gate, ModelGate, MomentContext, MomentSource, ReflectParts, ReflectPrompt, Reflector};
pub use vectors::VectorIndex;
