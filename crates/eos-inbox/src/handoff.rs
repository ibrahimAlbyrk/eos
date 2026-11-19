//! The producer's side of an answer: it acts, then marks the item in the
//! same write job, so an answer is acted on at least once across a crash.

use eos_core::Error;
use eos_core::store::Tx;

/// Marks an answered item as acted on, inside the producer's write job.
/// `false` when it was marked already: a second pass acts on nothing.
pub fn consume_in(tx: &dyn Tx, item_id: &str, now: i64) -> Result<bool, Error> {
    let consumed = tx.inbox_items().consume(item_id, now)?;
    if consumed {
        tracing::info!(item_id, "an answer was acted on");
    }
    Ok(consumed)
}
