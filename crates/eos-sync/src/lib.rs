//! The sync engine: one pass over every domain pulls what other computers pushed to the
//! vault, then pushes what changed here.
//!
//! The index remembers, per record, the vault sequence number this computer
//! last matched and the local record's fingerprint at that point. A local
//! fingerprint that differs is a change to push; a record that vanished
//! locally is a delete. Applying a remote change re-indexes the local result,
//! so the change event it fires is not pushed back.
//!
//! Conflicts (the same record changed on two computers before either synced):
//! the newer `changedAt` wins and the loser is kept through
//! [`SyncStateStore::save_conflict`]; nothing local is overwritten unless
//! that succeeded. A local record this computer never synced counts as
//! oldest, so joining adopts the account's copy.
//!
//! [`SyncStateStore::save_conflict`]: eos_core::net::sync::SyncStateStore::save_conflict

mod engine;

pub use engine::{PassResult, SyncEngine, SyncEngineDeps};
