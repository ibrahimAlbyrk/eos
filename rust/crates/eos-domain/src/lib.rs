//! Pure rules and the entities every feature shares. Nothing here reads a
//! clock, a file or the network, and nothing is async: a rule takes what it
//! needs as arguments and returns its verdict, so every one is tested with
//! plain values.
//!
//! An entity is what the app reasons about (`Worker`, `EventRecord`); its wire
//! form is the `eos-contracts` row it converts to. A rule that belongs to one
//! feature only stays in that feature's crate.

pub mod config;
pub mod context;
pub mod display;
pub mod event;
pub mod loops;
pub mod message_queue;
pub mod model;
pub mod pending;
pub mod project;
pub mod transcript;
pub mod worker;

pub use event::EventRecord;
pub use loops::WorkerLoop;
pub use worker::{Usage, Worker, can_transition};
