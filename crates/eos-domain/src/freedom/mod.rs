//! Freedom: how far a run's results go without the user. The rules over the
//! Freedom and Goes-to slots' shapes (`eos_contracts::freedom`). Pure: item
//! facts, flags and ages come in as arguments, and nothing here logs (facts
//! are user data).

pub mod rung;
pub mod streak;

pub use rung::{AUTOMATIC_RUNGS_LOCKED, Caps, Waiting, effective_rung};
