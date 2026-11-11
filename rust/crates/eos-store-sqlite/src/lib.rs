//! `state.db` behind the store ports of `eos-core`.
//!
//! [`SqliteStore`] runs each job on the kit's writer thread (a write) or on a
//! read-only connection (a read) and hands it a [`Tx`]: every repository over
//! that one connection. Repositories are plain synchronous SQL with cached
//! statements; rows become `eos-domain` entities here and nowhere else.
//!
//! The schema is the kit's embedded migrations. Tables and migration ids this
//! build does not know (older builds left some) are never touched.

mod counters;
mod documents;
mod events;
mod loops;
mod message_queue;
mod pending;
mod store;
mod tx;
mod workers;

pub use store::{SqliteStore, StoreOptions};
