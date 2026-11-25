//! The failure policy (01 §4.8, §4.10, G27): a routine whose runs keep
//! failing, or one run of which spent far more than its runs usually do, is
//! paused with one `routine_alert`; runs that failed for want of a sign-in
//! pause it as `sign_in`. All are decided in the write that ends the run.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::Error;
use eos_core::store::{Outbox, StoredRoutine, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::limits::{FAILURES_TO_PAUSE, abnormal_spend, failure_streak, pauses_for_failures};
use eos_domain::routine::run::{Reason, RunState};
use eos_inbox::{NewItem, Opening, open_in};
use serde_json::json;

use super::Engine;
use super::control::{Control, pause_in};

/// Why a routine paused after its runs failed, and its alert's subject.
pub(crate) const FAILURES: &str = "failures";
/// Why a routine paused after its runs found no credential to start on.
pub(crate) const SIGN_IN: &str = "sign_in";
/// Why a routine paused after a run spent far more than usual.
pub(crate) const SPEND: &str = "spend";
/// Earlier runs read for the routine's usual spend: the newest ten finished
/// ones are among them unless the routine ran many others since.
const RUNS_READ: i64 = 50;

/// After `run_id` ended: its routine's failure streak, and a pause with its
/// alert when the streak or the run's spend calls for one.
pub(crate) fn ended_in(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run_id: &str,
    now: i64,
) -> Result<(), Error> {
    let Some(run) = tx.runs().find(run_id)? else { return Ok(()) };
    if !matches!(run.state, RunState::Done | RunState::Failed) {
        return Ok(());
    }
    let Some(routine) = tx.routines().find(&run.routine_id)? else { return Ok(()) };
    let streak = failure_streak(routine.failure_streak, run.state);
    if streak != routine.failure_streak {
        tx.routines().set_failure_streak(&routine.id, streak)?;
    }
    if routine.state != RoutineState::Active {
        return Ok(());
    }
    if pauses_for_failures(streak) && signed_out(tx, &routine.id)? {
        tracing::info!(routine_id = %routine.id, run_id, "a routine's runs found no sign-in");
        let summary = "Paused: its runs found no Claude sign-in. Sign in under Settings › Accounts, then resume it.";
        return pause_with_alert(engine, tx, out, &run, SIGN_IN, summary, now);
    }
    if pauses_for_failures(streak) {
        tracing::info!(routine_id = %routine.id, run_id, streak, "a routine's runs keep failing");
        return pause_with_alert(engine, tx, out, &run, FAILURES, "Paused after three failed runs in a row.", now);
    }
    let earlier: Vec<f64> = tx
        .runs()
        .by_routine(&routine.id, RUNS_READ)?
        .into_iter()
        .filter(|other| other.id != run.id && matches!(other.state, RunState::Done | RunState::Failed))
        .map(|other| other.cost_usd)
        .collect();
    if abnormal_spend(run.cost_usd, &earlier) {
        tracing::info!(routine_id = %routine.id, run_id, cost_usd = run.cost_usd, "a run spent far more than usual");
        let summary = format!("Paused after a run cost ${:.2}, far more than its runs usually do.", run.cost_usd);
        return pause_with_alert(engine, tx, out, &run, SPEND, &summary, now);
    }
    Ok(())
}

/// A routine that paused because its runs kept failing is resumed: its
/// streak starts over, so one more failure does not pause it again.
pub(crate) fn resumed_in(tx: &dyn Tx, routine: &StoredRoutine) -> Result<(), Error> {
    let for_failures = matches!(routine.paused_reason.as_deref(), Some(FAILURES | SIGN_IN));
    if routine.state == RoutineState::Paused && for_failures && routine.failure_streak != 0 {
        tx.routines().set_failure_streak(&routine.id, 0)?;
    }
    Ok(())
}

/// Whether the routine's newest failed runs in a row all found no credential.
fn signed_out(tx: &dyn Tx, routine_id: &str) -> Result<bool, Error> {
    let ended = tx.runs().by_routine(routine_id, RUNS_READ)?;
    let mut ended = ended.into_iter().filter(|run| matches!(run.state, RunState::Done | RunState::Failed));
    let newest = ended.by_ref().take(FAILURES_TO_PAUSE as usize);
    Ok(newest.filter(|run| run.reason == Some(Reason::NoCredential)).count() == FAILURES_TO_PAUSE as usize)
}

fn pause_with_alert(
    engine: &Arc<Engine>,
    tx: &dyn Tx,
    out: &mut Outbox,
    run: &eos_core::store::StoredRun,
    reason: &str,
    summary: &str,
    now: i64,
) -> Result<(), Error> {
    pause_in(tx, out, &run.routine_id, reason, now, &engine.patterns)?;
    let control = Control(engine.clone());
    let at = Opening { now, ids: engine.ids.as_ref(), zone: engine.zone.as_ref(), control: &control };
    let alert = NewItem {
        kind: ItemKind::RoutineAlert,
        producer: "routines".into(),
        routine_id: Some(run.routine_id.clone()),
        run_id: Some(run.id.clone()),
        subject_key: Some(reason.to_owned()),
        title: "A routine was paused".into(),
        summary: summary.to_owned(),
        payload: json!({ "reason": reason }),
        by_hand: false,
    };
    open_in(tx, out, &at, alert).map(drop)
}
