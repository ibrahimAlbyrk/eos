//! The lifecycle of agent sessions: the use-cases every feature that touches
//! an agent goes through (`core/src/use-cases` of the session area).
//!
//! [`Sessions`] is the service:
//!
//! - [`spawn`](Sessions::spawn) / [`resume`](Sessions::resume): the spawn
//!   chokepoint — row, worktree, boot prompt, system prompt, session;
//! - [`dispatch`](Sessions::dispatch): a message for a worker, delivered or
//!   queued; a worker that goes idle gets its oldest queued message;
//! - [`interrupt`](Sessions::interrupt), [`suspend`](Sessions::suspend),
//!   [`kill`](Sessions::kill), [`set_model`](Sessions::set_model),
//!   [`set_permission_mode`](Sessions::set_permission_mode);
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
//! [`boot`], [`loops`] and [`transition`] are steps of a database write job: they take
//! the job's [`Tx`](eos_core::store::Tx) and
//! [`Outbox`](eos_core::store::Outbox), so the rows they change and the
//! events they announce are saved, or dropped, together.

pub mod boot;
pub mod cleanup;
mod commands;
mod control;
mod dispatch;
pub mod loops;
mod service;
mod signal;
mod spawn;
pub mod transition;
mod turns;

pub use boot::{Reconciled, reconcile_workers_on_boot};
pub use commands::{SlashCommand, SlashContext};
pub use control::{KILL_GRACE_MS, ModeSet, ModelSet, Recalled, Removed};
pub use dispatch::{Dispatched, MessageInput};
pub use service::{NoHooks, SessionDeps, SessionHooks, Sessions};
pub use spawn::{SpawnRequest, Spawned};
pub use transition::{Transition, transition_state};
