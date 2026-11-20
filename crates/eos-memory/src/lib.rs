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
//! - [`settings`] reads and writes the user's Learning and Reminders
//!   switches.
//! - [`chat_pack`] turns what was recalled into the block a chat's model
//!   reads at the start of each epoch.
//!
//! Note text, cues and hook keys are the user's data: logged by count and
//! kind only, never by content.

pub mod capture;
pub mod deliver;
pub mod pack;
pub mod recall;
pub mod settings;
pub mod vectors;

pub use capture::{Capture, Captured};
pub use pack::{Pack, chat_pack};
pub use recall::{Cues, Recall, Recalled, Situation};
pub use vectors::VectorIndex;
