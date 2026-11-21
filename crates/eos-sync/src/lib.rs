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
//! A merging domain ([`SyncDomain::merge`]) takes both sides of a record
//! two computers changed and pushes the merge; a domain with a read of
//! what changed ([`SyncDomain::changed_since`]) is listed whole only in the
//! first pass of a run.
//!
//! A domain with a vault budget ([`vault_budgets`]) pushes no new record
//! once its sealed bytes reached it; [`SyncEngine::usage`] tells which.
//!
//! [`SyncStateStore::save_conflict`]: eos_core::net::sync::SyncStateStore::save_conflict
//! [`SyncDomain::merge`]: eos_core::net::sync::SyncDomain::merge
//! [`SyncDomain::changed_since`]: eos_core::net::sync::SyncDomain::changed_since

mod budget;
mod engine;

pub use budget::{DomainUsage, EXPERIENCE_BUDGET, vault_budgets};
pub use engine::{PassResult, SyncEngine, SyncEngineDeps};
