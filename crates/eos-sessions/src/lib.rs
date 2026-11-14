//! The lifecycle of agent sessions: the use-cases every feature that touches
//! an agent goes through.
//!
//! [`Sessions`] is the service:
//!
//! - [`spawn`](Sessions::spawn) / [`resume`](Sessions::resume): the spawn
//!   chokepoint — row, worktree, boot prompt, system prompt, session;
//! - [`wake`](Sessions::wake) / [`revive`](Sessions::revive): a chat at rest
//!   continued by whatever reaches it; whoever needs a session that is
//!   coming up waits for it, in the order they came;
//! - [`dispatch`](Sessions::dispatch): a message for a worker, delivered or
//!   queued; a worker that goes idle gets its oldest queued message;
//! - [`interrupt`](Sessions::interrupt), [`suspend`](Sessions::suspend),
//!   [`kill`](Sessions::kill), [`set_model`](Sessions::set_model),
//!   [`set_permission_mode`](Sessions::set_permission_mode);
//! - [`archive`](Sessions::archive), [`restore`](Sessions::restore),
//!   [`purge`](Sessions::purge) and the retention sweep;
//! - [`report`](Sessions::report): a worker's report to its parent;
//! - [`ask_peer`](Sessions::ask_peer), [`respond_to_peer`](Sessions::respond_to_peer):
//!   workers of one orchestrator consulting each other, one question per turn;
//! - it is the sink of every session it starts: each agent event is recorded
//!   and applied to its worker in one write (`signal`), in the order the
//!   session reported it, and announced in commit order.
//!
//! [`cleanup`] deletes the worktrees and scratch folders nobody uses any more.
//!
//! State lives in the database; what is kept in memory is per worker and
//! small (the settle window, whether the turn produced output) and is
//! dropped when the worker's session ends or the worker is removed.
//!
//! [`boot`] and [`transition`] are steps of a database write job: they take
//! the job's [`Tx`](eos_core::store::Tx) and
//! [`Outbox`](eos_core::store::Outbox), so the rows they change and the
//! events they announce are saved, or dropped, together.

mod archive;
pub mod boot;
pub mod cleanup;
mod commands;
mod control;
mod dispatch;
mod features;
mod peers;
mod report;
mod revive;
mod service;
mod signal;
mod spawn;
mod starts;
pub mod transition;
mod turns;

pub use archive::{Archived, Restored};
pub use boot::{Reconciled, reconcile_workers_on_boot};
pub use commands::{CommandAnswer, SlashCommand, SlashContext};
pub use control::{KILL_GRACE_MS, ModeSet, ModelSet, Recalled, Removed};
pub use dispatch::{Dispatched, MessageInput};
pub use peers::{PeerAnswer, PeerAnswered, PeerAsk};
pub use report::Reported;
pub use service::{NoHooks, SessionDeps, SessionHooks, Sessions};
pub use spawn::{SpawnRequest, Spawned};
pub use transition::{Transition, transition_state};
