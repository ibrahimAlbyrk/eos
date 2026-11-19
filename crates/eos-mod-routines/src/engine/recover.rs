//! Picking runs up again after Eos stopped (01 §4.6, G4, G39), after the
//! sessions' boot reconcile and once the run sessions' launches are read
//! again. A queued run waits, unless its time is more than a day past
//! (`skipped: too_late`). A running run is picked up once: its lead is
//! told Eos restarted (its session comes back on the message); the second
//! time the run fails as `interrupted`. A checking run's lead is held again
//! and its check starts over with a new checker. Waiting, delivering and
//! paused runs stay as they are. Each run's cost and working time are
//! recounted from its sessions and timeline. Off the network (a dev run)
//! nothing is touched.

use std::sync::Arc;

use eos_core::Error;
use eos_core::store::{RUN_STATE_EVENT, RunMove, StoredRun, Tx};
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::json;

use super::{Engine, brief, check, fail, move_run, note};

/// A queued run more than this late is skipped.
const TOO_LATE_MS: i64 = 24 * 60 * 60 * 1000;
pub(crate) const INTERRUPTED: &str = "interrupted";
pub(crate) const RESUMED: &str = "resumed";
const RESTARTED: &str = "Eos restarted while this run was working. Carry on where you left off, then call \
     submit_result or report_failure.";

/// What a restart does with one run.
enum Pick {
    /// The lead is told; `None` when it never started (the brief starts it).
    Resume(Option<String>),
    Fail,
    /// The check starts over; its lead is held already (`launch::rebuild`).
    Recheck {
        checkers: Vec<String>,
    },
}

pub(crate) async fn recover(engine: &Arc<Engine>) -> Result<(), Error> {
    if !engine.autostart {
        return Ok(());
    }
    let now = engine.clock.now_ms();
    let picks = engine.store.write(move |tx, out| recount_and_pick(tx, out, now)).await?;
    for (run, pick) in picks {
        let id = run.id.as_str();
        tracing::info!(run_id = id, state = run.state.as_str(), "a run was found working after a restart");
        match pick {
            Pick::Fail => fail(engine, id, Reason::Interrupted, None).await?,
            Pick::Resume(None) => brief::start_lead(engine, id).await,
            Pick::Resume(Some(lead)) => note(engine, &lead, id, RESTARTED).await?,
            Pick::Recheck { checkers } => {
                for checker in checkers {
                    if let Err(error) = engine.sessions.suspend(&checker, "routine_run").await {
                        tracing::debug!(run_id = id, worker_id = %checker, %error, "a checker was not suspended");
                    }
                }
                check::begin(engine, id);
            }
        }
    }
    Ok(())
}

/// One write: late queued runs skipped, every working run's spend recounted,
/// each interruption put on its timeline, and what to do with each run.
fn recount_and_pick(tx: &dyn Tx, out: &mut eos_core::store::Outbox, now: i64) -> Result<Vec<(StoredRun, Pick)>, Error> {
    for run in tx.runs().queued()? {
        if run.not_before.is_some_and(|at| now - at > TOO_LATE_MS) {
            let late = RunMove { state: RunState::Skipped, station: None, reason: Some(Reason::TooLate), at: now };
            move_run(tx, out, &run, late)?;
        }
    }
    let mut picks = Vec::new();
    for run in tx.runs().at_work()? {
        let sessions = tx.routine_sessions().by_run(&run.id)?;
        let mut cost = 0.0;
        for session in &sessions {
            cost += tx.workers().find(&session.worker_id)?.map_or(0.0, |worker| worker.usage.cost_usd);
        }
        let events = tx.runs().events(&run.id)?;
        tx.runs().set_spent(&run.id, cost, work_ms(&events))?;
        let stopped = events.last().map_or(run.updated_at, |event| event.at);
        tx.runs().append_event(&run.id, now, INTERRUPTED, Some(&json!({"at": stopped}).to_string()))?;
        let pick = match run.state {
            RunState::Running if run.resumed > 0 => Pick::Fail,
            RunState::Running => {
                tx.runs().set_resumed(&run.id, run.resumed + 1)?;
                tx.runs().append_event(&run.id, now, RESUMED, Some(&json!({"at": now}).to_string()))?;
                let at_brief = run.station == Some(Station::Brief);
                Pick::Resume(run.lead_id.clone().filter(|_| !at_brief))
            }
            _ => {
                tx.runs().append_event(&run.id, now, RESUMED, Some(&json!({"at": now}).to_string()))?;
                let checkers = sessions.iter().filter(|s| s.role == "checker").map(|s| s.worker_id.clone()).collect();
                Pick::Recheck { checkers }
            }
        };
        picks.push((run, pick));
    }
    Ok(picks)
}

/// The time the run spent running or checking, from its timeline: each
/// such stretch up to the next move. The stretch Eos stopped in counts up
/// to its last event.
fn work_ms(events: &[eos_core::store::StoredRunEvent]) -> i64 {
    let mut total = 0;
    let mut since: Option<i64> = None;
    for event in events {
        if let Some(start) = since {
            total += event.at - start;
            since = Some(event.at);
        }
        if event.kind == RUN_STATE_EVENT {
            let state = event.data.as_deref().and_then(|data| serde_json::from_str::<serde_json::Value>(data).ok());
            let state = state.as_ref().and_then(|data| data["state"].as_str().map(str::to_owned));
            since = matches!(state.as_deref(), Some("running" | "checking")).then_some(event.at);
        }
    }
    total
}
