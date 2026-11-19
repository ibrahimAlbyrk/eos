//! A routine's limits inside the routing write (02 §3 C.15): a newer signal
//! of a subject supersedes the subject's run that still waits; past the
//! routine's runs an hour or runs waiting, a signal is decided `over-limit`,
//! kept and replayable, and one notice a local day says how many wait. A
//! signal past the limits supersedes nothing: the run it would replace
//! still runs.

use eos_contracts::When;
use eos_core::Error;
use eos_core::routine::RunIntake;
use eos_core::store::{Outbox, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::run::RunState;
use eos_domain::signals::decision::Decision;
use eos_domain::signals::limits::{Admit, Load, admit_check};
use eos_inbox::{NewItem, Opening, notice_in};
use serde_json::json;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// The subject of a routine's over-limit notice.
const OVER_LIMIT: &str = "over-limit";

/// The queued runs of `routine_id` about `subject`, which a newer signal
/// replaces. A run that already works finishes.
pub(crate) fn stale_in(tx: &dyn Tx, routine_id: &str, subject: &str) -> Result<Vec<String>, Error> {
    let mut stale = Vec::new();
    for run_id in tx.signal_routes().runs_of_subject(routine_id, subject)? {
        if tx.runs().find(&run_id)?.is_some_and(|run| run.state == RunState::Queued) {
            stale.push(run_id);
        }
    }
    Ok(stale)
}

/// Skips the stale runs.
pub(crate) fn supersede_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    intake: &dyn RunIntake,
    stale: &[String],
) -> Result<(), Error> {
    for run_id in stale {
        intake.supersede(tx, out, run_id)?;
    }
    Ok(())
}

/// Whether one more run of the routine fits its limits now, once `freed`
/// of its queued runs are superseded.
pub(crate) fn fits_in(
    tx: &dyn Tx,
    intake: &dyn RunIntake,
    routine_id: &str,
    when: &When,
    now: i64,
    freed: usize,
) -> Result<bool, Error> {
    let load = intake.load(tx, routine_id, now - HOUR_MS)?;
    let freed = i64::try_from(freed).unwrap_or(i64::MAX);
    let load = Load { admitted_last_hour: load.started_since, queued: (load.queued - freed).max(0) };
    Ok(admit_check(load, &when.limits) == Admit::Run)
}

/// The day's one notice that the routine got more than it may run, with
/// the last hour's counts; it opens with the first `over-limit` of the day
/// and later ones bring its count up to date.
pub(crate) fn notice_over_limit_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    routine_id: &str,
) -> Result<(), Error> {
    let since = at.now - HOUR_MS;
    let ran = tx.signal_routes().count_since(routine_id, Decision::Run, since)?;
    let waiting = tx.signal_routes().count_since(routine_id, Decision::OverLimit, since)?;
    let name = tx.routines().find(routine_id)?.map_or_else(|| "A routine".to_owned(), |routine| routine.name);
    let item = NewItem {
        kind: ItemKind::Notice,
        producer: "signals".into(),
        routine_id: Some(routine_id.to_owned()),
        run_id: None,
        subject_key: Some(OVER_LIMIT.into()),
        title: format!("{name} got more items than it may run"),
        summary: format!("{name} got {} items in an hour and ran {ran}. {waiting} are waiting.", ran + waiting),
        payload: json!({"actionLabel": "Run them", "waiting": waiting}),
        by_hand: false,
    };
    notice_in(tx, out, at, item).map(drop)
}
