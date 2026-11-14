//! What start-up does to worker rows whose process is gone.
//!
//! No agent can be alive when the app starts, so every row that is not
//! `DONE` or `SUSPENDED` is stale:
//!
//! - on its way out (`ENDING`, `KILLING`) → `DONE`;
//! - resumable (a session id, and its folder still on disk) → `SUSPENDED`,
//!   so the conversation can be picked up again;
//! - anything else → `DONE`.

use eos_contracts::stream::topics::WORKER_EXIT;
use eos_contracts::{WorkerEventType, WorkerState};
use eos_core::store::{Outbox, Tx};
use eos_core::{Clock, Error};
use serde::Serialize;

use crate::transition::transition_state;

const REASON: &str = "boot_reconcile";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub suspended: usize,
    pub closed: usize,
}

#[derive(Serialize)]
struct ExitEvent {
    code: Option<i64>,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerExit<'a> {
    worker_id: &'a str,
    row_id: i64,
}

/// One write job. `path_exists` says whether a worker's folder is still there.
pub fn reconcile_workers_on_boot(
    tx: &dyn Tx,
    out: &mut Outbox,
    clock: &dyn Clock,
    path_exists: &dyn Fn(&str) -> bool,
) -> Result<Reconciled, Error> {
    let mut done = Reconciled::default();
    for worker in tx.workers().list_all()? {
        if matches!(worker.state, WorkerState::Done | WorkerState::Suspended) {
            continue;
        }
        let was_ending = matches!(worker.state, WorkerState::Ending | WorkerState::Killing);
        let folder = worker.worktree_dir.as_deref().or(worker.cwd.as_deref()).filter(|dir| !dir.is_empty());
        let has_session = worker.session_id.as_deref().is_some_and(|s| !s.is_empty());
        if !was_ending && has_session && folder.is_some_and(path_exists) {
            transition_state(tx, out, clock.now_ms(), &worker.id, WorkerState::Suspended, REASON)?;
            // The process is gone: a pid that the system reuses must never be signalled later.
            tx.workers().clear_runtime(&worker.id)?;
            done.suspended += 1;
        } else {
            let now = clock.now_ms();
            tx.workers().mark_done(&worker.id, now, None)?;
            let payload = ExitEvent { code: None, reason: REASON };
            let row_id = tx.events().append_json(&worker.id, now, WorkerEventType::Exit, &payload)?;
            out.push(WORKER_EXIT, &WorkerExit { worker_id: &worker.id, row_id });
            done.closed += 1;
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_core::store::{EventOrder, EventQuery};
    use eos_testkit::{FakeClock, TempStore, fixtures};

    fn log(temp: &TempStore, worker: &str) -> Vec<serde_json::Value> {
        let query = EventQuery {
            worker_id: worker.into(),
            since: 0,
            limit: 5000,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = temp.store.read_blocking(move |tx| tx.events().list(&query)).expect("reads");
        rows.into_iter().map(|r| serde_json::to_value(r.into_row()).expect("serializes")).collect()
    }

    // The seed leaves w-BUSY WORKING, as a crash would. Its log after
    // start-up is the recorded one (fixtures/wire/recordings/12-transcript.json).
    #[test]
    fn a_chat_that_was_working_is_parked_as_the_daemon_parked_it() {
        let temp = TempStore::seeded("{sandbox}");
        let clock = FakeClock::new();
        let reconciled = temp
            .store
            .write_blocking(move |tx, out| reconcile_workers_on_boot(tx, out, &clock, &|_| true))
            .expect("reconciles");
        assert_eq!(reconciled, Reconciled { suspended: 1, closed: 0 });

        let recorded = fixtures::recorded_response("12-transcript", "interrupted-chat")["json"].clone();
        let recorded = recorded.as_array().expect("rows");
        let rows = log(&temp, "w-BUSY");
        assert_eq!(rows.len(), recorded.len());
        let (last, want) = (rows.last().expect("a row"), recorded.last().expect("a row"));
        assert_eq!(last["type"], want["type"]);
        assert_eq!(last["payload"], want["payload"], "the same state row, key for key");
        assert_eq!(last["ts"], FakeClock::START_MS);

        let worker = temp.store.read_blocking(|tx| tx.workers().find("w-BUSY")).expect("reads").expect("the row");
        assert_eq!((worker.state, worker.pid, worker.port), (WorkerState::Suspended, None, None));
        assert_eq!(worker.turn_started_at, Some(1_790_000_401_000), "parking does not restart the turn clock");
        let change = &temp.announced.list()[0];
        assert_eq!(change.0, "worker:change");
        assert!(change.1.ends_with(r#""from":"WORKING","state":"SUSPENDED"}"#), "{}", change.1);

        let again =
            temp.store.write_blocking(|tx, out| reconcile_workers_on_boot(tx, out, &FakeClock::new(), &|_| true));
        assert_eq!(again.expect("reconciles"), Reconciled::default(), "a second start finds nothing to do");
    }

    #[test]
    fn rows_that_cannot_be_resumed_are_closed() {
        let temp = TempStore::seeded("/sandbox");
        temp.exec(
            "UPDATE workers SET state = 'IDLE' WHERE id = 'w-CHAT';
             UPDATE workers SET state = 'KILLING' WHERE id = 'w-LONG';
             UPDATE workers SET state = 'SPAWNING', session_id = NULL WHERE id = 'w-KID2';",
        );
        // w-CHAT's folder is gone; w-BUSY's is there.
        let reconciled = temp
            .store
            .write_blocking(|tx, out| {
                reconcile_workers_on_boot(tx, out, &FakeClock::new(), &|dir| dir.ends_with("/beta"))
            })
            .expect("reconciles");
        assert_eq!(reconciled, Reconciled { suspended: 1, closed: 3 });

        for id in ["w-CHAT", "w-LONG", "w-KID2"] {
            let worker = temp.store.read_blocking(move |tx| tx.workers().find(id)).expect("reads").expect("the row");
            assert_eq!(
                (worker.state, worker.ended_at, worker.exit_code),
                (WorkerState::Done, Some(FakeClock::START_MS), None),
                "{id}"
            );
            let last = log(&temp, id).pop().expect("a row");
            assert_eq!(
                (last["type"].as_str(), last["payload"].as_str()),
                (Some("exit"), Some(r#"{"code":null,"reason":"boot_reconcile"}"#))
            );
        }
        let topics = temp.announced.topics();
        assert_eq!(topics.iter().filter(|t| **t == "worker:exit").count(), 3);
        assert_eq!(topics.iter().filter(|t| **t == "worker:change").count(), 1);
    }
}
