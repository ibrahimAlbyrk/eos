//! Picking runs up again after Eos stopped (01 §4.6, G4, G39), after the
//! sessions' boot reconcile and once the run sessions' launches are read
//! again. A queued run waits, unless its time is more than a day past
//! (`skipped: too_late`, with one notice). A running run is picked up once: its lead is
//! told Eos restarted (its session comes back on the message); the second
//! time the run fails as `interrupted`. A checking run's lead is held again
//! and its check starts over with a new checker. Waiting, delivering and
//! paused runs stay as they are. Each run's cost and working time are
//! recounted from its sessions and timeline. Off the network (a dev run)
//! nothing is touched.

use std::sync::Arc;

use eos_core::Error;
use eos_core::store::{Outbox, RunMove, StoredRun, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_inbox::{NewItem, Opening, notice_in};
use serde_json::json;

use super::control::Control;
use super::{Engine, brief, budget, check, fail, move_run, note};

/// A queued run more than this late is skipped.
const TOO_LATE_MS: i64 = 24 * 60 * 60 * 1000;
/// The subject of the notice that runs were skipped as too late.
const TOO_LATE: &str = "too_late";
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
    let at = engine.clone();
    let picks = engine.store.write(move |tx, out| recount_and_pick(tx, out, &at, now)).await?;
    for (run, pick) in picks {
        let id = run.id.as_str();
        tracing::info!(run_id = id, state = run.state.as_str(), "a run was found working after a restart");
        match pick {
            Pick::Fail => fail(engine, id, Reason::Interrupted, None).await?,
            Pick::Resume(None) => brief::start_lead(engine, id).await,
            Pick::Resume(Some(lead)) => {
                note(engine, &lead, id, RESTARTED).await?;
                // A system step that was under way starts again.
                super::system::begin(engine, id);
            }
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
fn recount_and_pick(
    tx: &dyn Tx,
    out: &mut Outbox,
    engine: &Arc<Engine>,
    now: i64,
) -> Result<Vec<(StoredRun, Pick)>, Error> {
    let mut late = 0;
    for run in tx.runs().queued()? {
        if run.not_before.is_some_and(|at| now - at > TOO_LATE_MS) {
            let skip = RunMove { state: RunState::Skipped, station: None, reason: Some(Reason::TooLate), at: now };
            move_run(tx, out, &run, skip)?;
            late += 1;
        }
    }
    if late > 0 {
        too_late_notice_in(tx, out, engine, late, now)?;
    }
    let mut picks = Vec::new();
    for run in tx.runs().at_work()? {
        let sessions = tx.routine_sessions().by_run(&run.id)?;
        budget::recount_in(tx, &run.id)?;
        let events = tx.runs().events(&run.id)?;
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

/// One notice for the runs a launch skipped as more than a day late.
fn too_late_notice_in(tx: &dyn Tx, out: &mut Outbox, engine: &Arc<Engine>, late: usize, now: i64) -> Result<(), Error> {
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let title = match late {
        1 => "A run set for later was skipped".to_owned(),
        n => format!("{n} runs set for later were skipped"),
    };
    let item = NewItem {
        kind: ItemKind::Notice,
        producer: "routines".into(),
        routine_id: None,
        run_id: None,
        subject_key: Some(TOO_LATE.into()),
        title,
        summary: "Eos was closed for more than a day after they were due.".into(),
        payload: json!({}),
        by_hand: false,
    };
    tracing::info!(runs = late, "queued runs were skipped as too late");
    notice_in(tx, out, &at, item).map(drop)
}
