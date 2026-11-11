//! Ports: object-safe traits for everything outside the process. Adapters and the shell
//! implement them; services and features depend only on the traits.
//!
//! Ports live in the module of their area. A new port goes where its outside
//! system is, takes and returns plain data or `eos-domain` entities, and gets
//! a fake in `eos-testkit`:
//!
//! | Module | Outside system |
//! |---|---|
//! | [`agent`] | the agent engine: sessions, models, usage |
//! | [`git`] | the `git` program: status, branches, worktrees |
//! | [`net`] | other computers: sync vault, updates, artifacts, media |
//! | [`os`] | files, watchers, processes, the system clock's time zone |
//! | [`policy`] | permission decisions and tool scope |
//! | [`prompt`] | prompt sources and rendering |
//! | [`shell`] | the window shell: embedded views, screenshots, the open panel |
//! | [`store`] | the data folder: `state.db` repositories and file stores |
//!
//! [`Clock`] and [`Ids`] are the two every layer above shares, and [`Error`]
//! is the vocabulary a port fails with.

pub mod agent;
pub mod clock;
pub mod error;
pub mod git;
pub mod ids;
pub mod net;
pub mod os;
pub mod policy;
pub mod prompt;
pub mod shell;
pub mod store;

use std::future::Future;
use std::pin::Pin;

pub use clock::{Clock, SystemClock};
pub use error::Error;
pub use ids::{Alphabet, Ids, RandomIds};

/// What an async port method returns.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
