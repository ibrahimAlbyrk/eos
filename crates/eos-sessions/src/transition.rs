//! The one way a worker changes state.

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::store::{Outbox, Tx};
use eos_domain::worker::{can_transition, is_busy, state_name};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// The row moved; a `state` event was logged and announced.
    Applied,
    /// The move is not allowed from the row's state; a `state_reject` event was logged.
    Rejected,
    /// No such worker, or it is already in that state.
    Noop,
}

/// The `state` row's payload, keys in today's order.
#[derive(Serialize)]
struct StateEvent<'a> {
    state: &'a str,
    from: &'a str,
    reason: &'a str,
}

#[derive(Serialize)]
struct RejectEvent<'a> {
    from: &'a str,
    to: &'a str,
    reason: &'a str,
}

/// `worker:change`. `from` / `state` are present when the state moved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerChange<'a> {
    worker_id: &'a str,
    row_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<&'a str>,
}

/// Moves `worker_id` to `next` if the state machine allows it, logging and
/// announcing either outcome. `now` stamps the event, and the turn clock when
/// the worker enters a turn from outside one.
pub fn transition_state(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    worker_id: &str,
    next: WorkerState,
    reason: &str,
) -> Result<Transition, Error> {
    let Some(current) = tx.workers().find(worker_id)? else { return Ok(Transition::Noop) };
    let from = current.state;
    if from == next {
        return Ok(Transition::Noop);
    }
    let (from_name, next_name) = (state_name(from), state_name(next));
    if !can_transition(from, next) {
        let payload = RejectEvent { from: from_name, to: next_name, reason };
        let row_id = tx.events().append_json(worker_id, now, WorkerEventType::StateReject, &payload)?;
        out.push(WORKER_CHANGE, &WorkerChange { worker_id, row_id, from: None, state: None });
        return Ok(Transition::Rejected);
    }
    tx.workers().update_state(worker_id, next)?;
    // A move inside a turn (starting → working) keeps the first stamp, so the
    // elapsed time covers the whole turn.
    if !is_busy(from) && is_busy(next) {
        tx.workers().set_turn_started_at(worker_id, now)?;
    }
    let payload = StateEvent { state: next_name, from: from_name, reason };
    let row_id = tx.events().append_json(worker_id, now, WorkerEventType::State, &payload)?;
    out.push(WORKER_CHANGE, &WorkerChange { worker_id, row_id, from: Some(from_name), state: Some(next_name) });
    Ok(Transition::Applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::TempStore;

    #[test]
    fn a_move_is_applied_rejected_or_nothing() {
        let temp = TempStore::seeded("/sandbox");
        let outcome = temp
            .store
            .write_blocking(|tx, out| {
                Ok((
                    transition_state(tx, out, 50, "w-CHAT", WorkerState::Spawning, "resume")?,
                    transition_state(tx, out, 60, "w-CHAT", WorkerState::Working, "turn")?,
                    transition_state(tx, out, 70, "w-CHAT", WorkerState::Working, "turn")?,
                    transition_state(tx, out, 80, "w-KID1", WorkerState::Idle, "nope")?,
                    transition_state(tx, out, 90, "w-missing", WorkerState::Idle, "nope")?,
                    tx.workers().find("w-CHAT")?,
                ))
            })
            .expect("writes");
        let (resumed, working, same, refused, missing, worker) = outcome;
        assert_eq!(
            (resumed, working, same, refused, missing),
            (Transition::Applied, Transition::Applied, Transition::Noop, Transition::Rejected, Transition::Noop)
        );
        let worker = worker.expect("the row");
        assert_eq!(worker.state, WorkerState::Working);
        assert_eq!(worker.turn_started_at, Some(50), "stamped on entering the turn, kept inside it");

        let announced = temp.announced.list();
        assert_eq!(announced.len(), 3);
        assert!(announced[0].1.ends_with(r#""from":"SUSPENDED","state":"SPAWNING"}"#), "{}", announced[0].1);
        assert!(
            announced[2].1.starts_with(r#"{"workerId":"w-KID1","rowId":"#) && !announced[2].1.contains("state"),
            "{}",
            announced[2].1
        );
    }
}
