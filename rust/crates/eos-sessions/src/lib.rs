//! The lifecycle of agent sessions, over the store ports.
//!
//! Every function here is one step of a database write job: it takes the
//! job's [`Tx`](eos_core::store::Tx) and [`Outbox`](eos_core::store::Outbox),
//! so the rows it changes and the events it announces are saved, or dropped,
//! together.

pub mod boot;
pub mod transition;

pub use boot::{Reconciled, reconcile_workers_on_boot};
pub use transition::{Transition, transition_state};
