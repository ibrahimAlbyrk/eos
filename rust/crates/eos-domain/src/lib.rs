//! Pure rules and the entities every feature shares. Nothing here reads a
//! clock, a file or the network, and nothing is async: a rule takes what it
//! needs as arguments and returns its verdict, so every one is tested with
//! plain values.
//!
//! An entity is what the app reasons about (`Worker`, `EventRecord`); its wire
//! form is the `eos-contracts` row it converts to. A rule that belongs to one
//! feature only stays in that feature's crate.

pub mod accounts;
pub mod claude_transcript;
pub mod config;
pub mod context;
pub mod cost;
pub mod display;
pub mod effort;
pub mod envelope;
pub mod event;
pub mod fs_ignore;
pub mod git;
pub mod loops;
pub mod memory_sources;
pub mod message_id;
pub mod message_queue;
pub mod model;
pub mod model_tier;
pub mod page;
pub mod pending;
pub mod project;
pub mod sync;
pub mod tasks;
pub mod text;
pub mod time;
pub mod transcript;
pub mod transfer;
pub mod update;
pub mod user_memory;
pub mod user_profile;
pub mod view_action;
pub mod worker;
pub mod workflow_run;
pub mod worktree_policy;

pub use event::EventRecord;
pub use loops::WorkerLoop;
pub use model_tier::{ProviderIdentity, TierSpec};
pub use pending::PendingPermission;
pub use worker::{Usage, Worker, can_transition};
