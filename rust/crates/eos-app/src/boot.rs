//! What happens to the data folder before the app answers anything
//! (`manager/container.ts`, in today's order where it still applies).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use eos_core::{Clock, Error};
use eos_platform::{DataPaths, StartupBackup};
use eos_sessions::{Reconciled, reconcile_workers_on_boot};
use eos_store_sqlite::SqliteStore;

/// Copies the user's data aside before the database is opened: a pending
/// migration must not run ahead of the copy. Only the fast part (clone
/// copies); the returned snapshot is completed after start-up by
/// [`finish_snapshot`]. A snapshot that cannot be taken is logged and
/// start-up goes on, as today.
pub(crate) fn snapshot(paths: &DataPaths, clock: &dyn Clock) -> Option<(StartupBackup, PathBuf)> {
    let backup = StartupBackup::new(paths.home(), paths.backups_dir());
    let now = UNIX_EPOCH + Duration::from_millis(u64::try_from(clock.now_ms()).unwrap_or(0));
    match backup.run(now) {
        Ok(taken) => taken.map(|dir| (backup, dir)),
        Err(e) => {
            tracing::warn!(error = %e, "the start-up snapshot was skipped");
            None
        }
    }
}

/// The slow part of the snapshot (browser profiles) and the pruning of old ones.
pub(crate) fn finish_snapshot(backup: &StartupBackup, snapshot: &std::path::Path) -> std::io::Result<()> {
    backup.finish(snapshot)
}

/// Delivered messages are kept this long: they only make a repeated send harmless.
const DELIVERED_MESSAGES_KEPT_MS: i64 = 24 * 60 * 60 * 1000;

/// The data work of start-up, before anything can read or announce
/// (`container.ts`, in its order): delivered messages older than a day are
/// forgotten, each worker's event log is cut to its bound, permission asks
/// that expired while the app was down are denied, and rows whose process
/// died with the last run are parked or closed (no agent is alive yet).
pub(crate) fn settle(
    store: &SqliteStore,
    clock: Arc<dyn Clock>,
    events_max_per_worker: i64,
) -> Result<Reconciled, Error> {
    let now = clock.now_ms();
    let (pruned, swept) = store.write_blocking(move |tx, _| {
        tx.message_queue().prune(now - DELIVERED_MESSAGES_KEPT_MS)?;
        let pruned = tx.events().prune_all(events_max_per_worker)?;
        Ok((pruned, tx.pending().sweep_expired(now, "daemon restart sweep")?))
    })?;
    if pruned > 0 {
        tracing::info!(rows = pruned, keep_per_worker = events_max_per_worker, "pruned events at start-up");
    }
    if swept > 0 {
        tracing::info!(count = swept, "denied permission asks that expired while the app was down");
    }
    let reconciled = store.write_blocking(move |tx, out| {
        reconcile_workers_on_boot(tx, out, clock.as_ref(), &|dir| std::path::Path::new(dir).exists())
    })?;
    if reconciled != Reconciled::default() {
        tracing::info!(suspended = reconciled.suspended, closed = reconciled.closed, "reconciled stale workers");
    }
    Ok(reconciled)
}
