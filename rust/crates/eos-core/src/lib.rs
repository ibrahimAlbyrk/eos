//! Ports: object-safe traits for everything outside the process. Adapters and the shell
//! implement them; services and features depend only on the traits.
//!
//! Ports live in the module of their area. A new port goes where its outside
//! system is, takes and returns plain data or `eos-domain` entities, and gets
//! a fake in `eos-testkit`:
//!
//! | Module | Outside system |
//! |---|---|
//! | [`accounts`] | sign-ins, API keys, plan usage, a session's credential |
//! | [`agent`] | the agent engine: sessions, models, usage |
//! | [`git`] | the `git` program: status, branches, worktrees |
//! | [`net`] | other computers: sync vault, updates, artifacts, media |
//! | [`os`] | files, watchers, processes, the system clock's time zone |
//! | [`policy`] | permission decisions and tool scope |
//! | [`prompt`] | prompt sources and rendering |
//! | [`shell`] | the window shell: embedded views, screenshots, the open panel |
//! | [`store`] | the data folder: `state.db` repositories and file stores |
//!
//! A capability one feature offers the others is a trait here too, in the
//! module of the feature that implements it ([`pages`], [`profile`]).
//!
//! [`Clock`] and [`Ids`] are the two every layer above shares, and [`Error`]
//! is the vocabulary a port fails with.

pub mod accounts;
pub mod agent;
pub mod clock;
pub mod error;
pub mod git;
pub mod ids;
pub mod net;
pub mod os;
pub mod pages;
pub mod policy;
pub mod profile;
pub mod prompt;
pub mod shell;
pub mod store;

use std::future::Future;
use std::pin::Pin;

pub use clock::{Clock, Sleeper, SystemClock};
pub use error::Error;
pub use ids::{Alphabet, Ids, RandomIds};

/// What an async port method returns.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
