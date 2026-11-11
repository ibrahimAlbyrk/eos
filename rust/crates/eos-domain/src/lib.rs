//! Pure rules and the entities every feature shares. Nothing here reads a
//! clock, a file or the network, and nothing is async: a rule takes what it
//! needs as arguments and returns its verdict, so every one is tested with
//! plain values.
//!
//! An entity is what the app reasons about (`Worker`, `EventRecord`); its wire
//! form is the `eos-contracts` row it converts to. A rule that belongs to one
//! feature only stays in that feature's crate.

pub mod accounts;
pub mod config;
pub mod context;
pub mod display;
pub mod event;
pub mod loops;
pub mod memory_sources;
pub mod message_queue;
pub mod model;
pub mod model_tier;
pub mod page;
pub mod pending;
pub mod project;
pub mod text;
pub mod time;
pub mod transcript;
pub mod user_memory;
pub mod user_profile;
pub mod worker;

pub use event::EventRecord;
pub use loops::WorkerLoop;
pub use model_tier::{ProviderIdentity, TierSpec};
pub use pending::PendingPermission;
pub use worker::{Usage, Worker, can_transition};
