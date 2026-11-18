//! What starts a routine's run and which items it takes: the rules over the
//! When and Which slots' shapes (`eos_contracts::signals`), the keys that
//! make one thing one signal, and what becomes of a signal. Pure: times,
//! zone rules and facts come in as arguments, and nothing here logs (facts
//! and keys are user data).

pub mod decision;
pub mod glob;
pub mod key;
pub mod limits;
pub mod schedule;
pub mod when;
pub mod which;
