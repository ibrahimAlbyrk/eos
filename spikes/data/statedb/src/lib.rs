//! Spike 1: `state.db` opened in place with rusqlite (bundled SQLite).
//!
//! `migrate` is the TypeScript runner's contract in Rust; `db` is the write
//! path from the plan: one writer thread with group commit plus read-only
//! connections.

pub mod db;
pub mod migrate;
