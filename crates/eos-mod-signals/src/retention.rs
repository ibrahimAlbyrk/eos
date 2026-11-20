//! Clearing old signals (02 §3 I.44), once an hour from the scheduler's
//! pass, at most [`SWEEP_ROWS`] rows per write job. A signal a run that
//! still exists took is kept whole. Others lose their facts after
//! [`FACTS_KEPT_MS`] and go, with their decisions, after [`ROWS_KEPT_MS`];
//! past [`ROWS_MAX`] signals the oldest no run took go first. A stopped
//! source's row goes [`ROWS_KEPT_MS`] after it stopped.

use std::sync::Arc;

use eos_core::Error;
use eos_core::store::Store;

use crate::router::error_kind;

const DAY_MS: i64 = 24 * 60 * 60_000;
pub const FACTS_KEPT_MS: i64 = 7 * DAY_MS;
pub const ROWS_KEPT_MS: i64 = 30 * DAY_MS;
pub const ROWS_MAX: i64 = 100_000;
pub const SWEEP_ROWS: i64 = 1_000;
pub const SWEEP_EVERY_MS: i64 = 60 * 60_000;

/// Repeats `job` until a run of it does less than [`SWEEP_ROWS`]; how much
/// it did in all.
async fn repeat<F>(store: &Arc<dyn Store>, job: F) -> Result<usize, Error>
where
    F: Fn(&dyn eos_core::store::Tx) -> Result<usize, Error> + Clone + Send + 'static,
{
    let mut done = 0;
    loop {
        let job = job.clone();
        let did = store.write(move |tx, _| job(tx)).await?;
        done += did;
        if (did as i64) < SWEEP_ROWS {
            return Ok(done);
        }
    }
}

/// One sweep at `now`. A job whose write fails is logged and left for the
/// next sweep; the others go on.
pub(crate) async fn sweep(store: &Arc<dyn Store>, now: i64) {
    let (facts_before, rows_before) = (now - FACTS_KEPT_MS, now - ROWS_KEPT_MS);
    let facts = repeat(store, move |tx| tx.signal_retention().clear_facts(facts_before, SWEEP_ROWS)).await;
    let old = repeat(store, move |tx| {
        let ids = tx.signal_retention().unrun_before(rows_before, SWEEP_ROWS)?;
        tx.signal_retention().delete(&ids)
    })
    .await;
    let over = repeat(store, |tx| {
        let over = (tx.signal_retention().count()? - ROWS_MAX).clamp(0, SWEEP_ROWS);
        let ids = if over > 0 { tx.signal_retention().unrun_before(i64::MAX, over)? } else { Vec::new() };
        tx.signal_retention().delete(&ids)
    })
    .await;
    let sources = repeat(store, move |tx| tx.signal_retention().delete_stopped_sources(rows_before, SWEEP_ROWS)).await;
    let mut cleared = [0; 4];
    for (count, (what, done)) in
        cleared.iter_mut().zip([("facts", facts), ("old", old), ("over", over), ("sources", sources)])
    {
        match done {
            Ok(done) => *count = done,
            Err(error) => tracing::warn!(what, error = error_kind(&error), "old signals could not be cleared"),
        }
    }
    let [facts, old, over, sources] = cleared;
    if facts + old + over + sources > 0 {
        tracing::info!(facts, signals = old + over, sources, "old signals were cleared");
    }
}
