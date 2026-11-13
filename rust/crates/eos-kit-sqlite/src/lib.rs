//! `state.db`: one writer thread, a fixed set of read-only connections, the
//! migration runner and maintenance.
//!
//! The file is the one today's TypeScript app created and still opens: same
//! `schema_migrations` table, same migration ids and SQL, WAL. Every
//! read-modify-write is one closure on the writer thread ([`Db::write`]);
//! readers never block it ([`Db::read`]).
//!
//! Taking a snapshot before the first open is the caller's job: [`preflight`]
//! says whether a migration is pending and [`database_files`] lists what to copy.

mod db;
mod error;
mod maintenance;
mod migrate;
mod oneshot;
mod open;

pub use db::{Db, Options, Receipt, Stats};
pub use error::Error;
pub use maintenance::{VACUUM_INTERVAL_MS, VACUUM_SLICE_PAGES, VacuumOutcome};
pub use migrate::{EMBEDDED, Migration, MigrationReport, TYPESCRIPT_MIGRATIONS, VACUUM_MARKER, run as run_migrations};
pub use open::{Preflight, Synchronous, database_files, open_read_only, open_read_write, preflight};
pub use rusqlite;
