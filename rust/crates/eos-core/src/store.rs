//! Ports over the data folder: the repositories of `state.db` and the file
//! stores (`core/src/ports/*Repo.ts`, `*Store.ts`).
//!
//! # The database
//!
//! Repositories are synchronous and exist only inside a job handed to the
//! [`Store`]: a [`Tx`] is the set of repositories over one transaction.
//!
//! ```ignore
//! // A read: one consistent snapshot, on a read-only connection.
//! let worker = store.read(move |tx| tx.workers().find(&id)).await?;
//!
//! // A read-modify-write: one job, so nothing can change between its steps.
//! // What it announces goes out after COMMIT, in commit order.
//! store.write(move |tx, out| {
//!     tx.workers().update_name(&id, Some(&name), NameSource::User)?;
//!     out.push("worker:change", &WorkerChange { worker_id: id });
//!     Ok(())
//! }).await?;
//! ```
//!
//! A job that returns `Err` leaves no trace: its changes are undone and its
//! announcements dropped. A job must not block on anything but the database
//! and must not call the store again.
//!
//! A new table gets a repository trait in a file here, an accessor on [`Tx`],
//! and its implementation in `eos-store-sqlite`.
//!
//! # Files
//!
//! A file store is a `Send + Sync` trait a feature holds as `Arc<dyn …>`; it
//! keeps the file's format and guards its own read-modify-write
//! (`eos-store-files`, `eos-config`).
//!
//! A store of many small documents (pages, memories) holds what it loaded
//! and writes each change through; the one service that owns the data's write
//! path orders the changes.

mod counters;
mod definitions;
mod documents;
mod events;
mod files;
mod loops;
mod memories;
mod message_queue;
mod pages;
mod pending;
mod profile;
mod session;
mod templates;
mod unit;
mod workers;

pub use counters::{ContextMarkRepo, MessageIdRepo, WorktreeRemoval, WorktreeRemovalQueue};
pub use definitions::{DefinitionFile, WorkerDefinitionFiles};
pub use documents::{DreamRepo, GenuiViewRepo, StoredViewState, TransferRepo, WorkerDefinitionRepo};
pub use events::{EventOrder, EventQuery, EventRepo};
pub use files::{ConfigSource, ProjectStore, RecentFolders, UserSettingsStore};
pub use loops::{LoopRepo, NewLoop};
pub use memories::UserMemoryStore;
pub use message_queue::{MessageQueueRepo, NewQueuedMessage};
pub use pages::PageStore;
pub use pending::{NewPending, PendingRepo};
pub use profile::{UserAvatar, UserAvatarStore, UserProfileStore};
pub use session::{AgentCaller, agent_caller, session_project, session_root};
pub use templates::TemplateStore;
pub use unit::{Announcement, Announcer, Outbox, ReadJob, Store, Tx, WriteJob};
pub use workers::{NewWorker, WorkerRepo};
