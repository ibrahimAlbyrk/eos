//! Batching (02 §3 C.16): a routine whose When has `batch` collects its
//! matched signals as `batched`; the batch closes when it is full or
//! `waitMinutes` after its first signal, and one run takes all of it as its
//! items. A batch past the routine's limits stays open until it fits.

use eos_contracts::{ItemRef, ResultMode, RunInput, RunTrigger, SignalChange, SignalChangeWhat};
use eos_core::Error;
use eos_core::routine::{Admission, AdmitOutcome, RoutineTriggers, RunIntake};
use eos_core::store::{Outbox, Tx};

use crate::SIGNALS_CHANGE;
use crate::limits::fits_in;

const MINUTE_MS: i64 = 60 * 1000;

/// Closes the routine's open batch when it is full or due: one run of its
/// first `max` signals. True when a run took them.
pub(crate) fn close_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    intake: &dyn RunIntake,
    routine: &RoutineTriggers,
    now: i64,
) -> Result<bool, Error> {
    let Some(batch) = &routine.when.batch else { return Ok(false) };
    let open = tx.signal_routes().open_batch(&routine.id)?;
    let Some(first) = open.first() else { return Ok(false) };
    let max = usize::try_from(batch.max.max(1)).unwrap_or(1);
    let due = now - first.decided_at >= batch.wait_minutes * MINUTE_MS;
    if open.len() < max && !due {
        return Ok(false);
    }
    if !fits_in(tx, intake, &routine.id, &routine.when, now, 0)? {
        return Ok(false);
    }
    let taken = &open[..open.len().min(max)];
    let items: Vec<ItemRef> =
        taken.iter().filter_map(|signal| serde_json::from_str::<ItemRef>(&signal.item_json).ok()).collect();
    let input = RunInput {
        item: None,
        items: Some(items),
        trigger: Some(RunTrigger { signal_id: first.signal_id.to_string(), slot_at: None, late_by_ms: None }),
        options: Default::default(),
        note: None,
        result: ResultMode::Usual,
        at: None,
        surface: None,
    };
    let admission = Admission { routine_id: routine.id.clone(), signal_id: first.signal_id, input };
    let AdmitOutcome::Queued { run_id } = intake.admit(tx, out, &admission)? else { return Ok(false) };
    let ids: Vec<i64> = taken.iter().map(|signal| signal.signal_id).collect();
    tx.signal_routes().set_run(&routine.id, &ids, &run_id)?;
    tracing::info!(routine_id = %routine.id, run_id, signals = ids.len(), "a batch closed");
    let change = SignalChange { routine_id: Some(routine.id.clone()), source_id: None, what: SignalChangeWhat::Routed };
    out.push(SIGNALS_CHANGE.name(), &change);
    Ok(true)
}
