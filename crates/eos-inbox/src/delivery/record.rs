//! What an attempt comes to, recorded in a write job of its own after the
//! channel answered: sent with its receipt; tried again on the retry
//! ladder; unknown, to be reconciled; frozen in a development run; held
//! again as a draft when its subject moved on; or failed, with a
//! `delivery_problem` item that asks the user. The run hears of a send
//! through [`RunOutcomes`].

use eos_contracts::ResultDoc;
use eos_core::Error;
use eos_core::capability::FailureKind;
use eos_core::delivery::{ChannelTraits, Receipt, SendError, SendErrorKind, Undo};
use eos_core::routine::RunOutcomes;
use eos_core::store::{Outbox, StoredDelivery, Tx};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::RunState;
use serde_json::{Value, json};

use super::{
    AUTO, FAILED, FROZEN, QUEUED, SENT, STOPPED, UNCERTAIN, WAITING_CAPABILITY, announce, target_of, target_value,
};
use crate::gate::DRAFT_PRODUCER;
use crate::items::open_replacing_in;
use crate::outcomes::{Ended, ended_in, replaced_in, sent_outcome};
use crate::{NewItem, Opening, open_in};

/// Why a send went back to the user as a draft.
pub(crate) enum Again {
    /// Its subject moved on since the result was made.
    Stale(String),
    /// An automatic send that did not go out within a day.
    TooOld,
    /// The user stopped an automatic send in its hold.
    Stopped,
}

impl Again {
    /// The kind a row stopped this way keeps: its run's draft replaces it.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Again::Stale(_) => STALE,
            Again::TooOld => AUTO_STALE,
            Again::Stopped => STOPPED_BY_USER,
        }
    }

    fn summary(&self) -> &'static str {
        match self {
            Again::Stale(_) => "What it is about changed since it was made. Look at it again before you send it.",
            Again::TooOld => "It waited over a day to go out. Look at it again before you send it.",
            Again::Stopped => "You stopped it before it went out.",
        }
    }
}

const STALE: &str = "stale";
const AUTO_STALE: &str = "auto_stale";
const STOPPED_BY_USER: &str = "stopped";
/// The kinds of a stopped row whose run's draft goes out in its place.
const HELD_AGAIN: [&str; 3] = [STALE, AUTO_STALE, STOPPED_BY_USER];

/// Waits after the 1st to 5th failed attempt (03 G5); the 6th is the last.
const RETRY_MS: [i64; 5] = [30_000, 120_000, 600_000, 3_600_000, 14_400_000];
pub(crate) const MAX_ATTEMPTS: i64 = 6;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What one attempt came to.
#[derive(Debug)]
pub(crate) enum Attempt {
    Sent {
        receipt: Receipt,
        traits: Option<ChannelTraits>,
    },
    Failed(SendError),
    /// The subject moved on since the result was made.
    Stale(String),
    /// No channel sends it now (its capability is gone or broken).
    NoChannel,
}

/// Why the user is asked about a delivery.
pub(crate) enum Problem {
    Failed(SendError),
    /// A send that may have gone out, through a channel that cannot tell.
    Unknown,
    ApprovedBeforeQuit {
        approved_at: i64,
    },
}

impl Problem {
    /// The `FailureKind` word the dashboard explains it by.
    fn error_kind(&self) -> &'static str {
        let kind = match self {
            Problem::Failed(error) => match (error.kind, error.detail_kind.as_str()) {
                (SendErrorKind::UserDraftInProgress, _) => FailureKind::UserDraftInProgress,
                (_, "own_pull_request") => FailureKind::NotAllowed,
                (SendErrorKind::Auth, _) => FailureKind::Unauthorized,
                (SendErrorKind::NotFound, _) => FailureKind::Gone,
                (SendErrorKind::Permanent, _) => FailureKind::Validation,
                _ => FailureKind::Service,
            },
            Problem::Unknown => FailureKind::Service,
            Problem::ApprovedBeforeQuit { .. } => FailureKind::Internal,
        };
        kind.as_str()
    }

    fn summary(&self, at: &Opening<'_>) -> String {
        match self {
            Problem::Failed(error) => match (error.kind, error.detail_kind.as_str()) {
                (SendErrorKind::UserDraftInProgress, _) => {
                    "You have a review of your own in progress on this pull request".to_owned()
                }
                (_, "own_pull_request") => {
                    "GitHub does not let you approve or ask for changes on your own pull request.".to_owned()
                }
                (SendErrorKind::Auth, _) => "Its sign-in was refused. Sign in again, then send it again.".to_owned(),
                (SendErrorKind::NotFound, _) => "Where it was to go is not there any more.".to_owned(),
                (SendErrorKind::Transient, _) => format!("It could not be sent after {MAX_ATTEMPTS} tries."),
                _ => "It could not be sent.".to_owned(),
            },
            Problem::Unknown => "Eos closed while it was sending. Did it go out?".to_owned(),
            Problem::ApprovedBeforeQuit { approved_at } => {
                let local = approved_at + i64::from(at.zone.offset_minutes_at(*approved_at)) * 60_000;
                let minutes = local.rem_euclid(DAY_MS) / 60_000;
                format!("Approved at {:02}:{:02}, Eos closed before sending. Send now?", minutes / 60, minutes % 60)
            }
        }
    }
}

/// Opens the `delivery_problem` item that asks the user about `row`.
pub(crate) fn problem_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    row: &StoredDelivery,
    problem: Problem,
) -> Result<(), Error> {
    let error_kind = problem.error_kind();
    let doc: Value = serde_json::from_str(&row.body).unwrap_or(Value::Null);
    tracing::info!(delivery_id = %row.id, run_id = %row.run_id, error_kind, "a delivery needs the user");
    let item = NewItem {
        kind: ItemKind::DeliveryProblem,
        producer: DRAFT_PRODUCER.to_owned(),
        routine_id: Some(row.routine_id.clone()),
        run_id: Some(row.run_id.clone()),
        subject_key: Some(row.id.clone()),
        title: "A result was not sent".to_owned(),
        summary: problem.summary(at),
        // What a retry would send, for the user to edit first (Edit and retry).
        payload: json!({ "errorKind": error_kind, "deliveryId": row.id, "doc": doc }),
        by_hand: false,
    };
    open_in(tx, out, at, item).map(drop)
}

pub(crate) fn delivering(tx: &dyn Tx, run_id: &str) -> Result<bool, Error> {
    Ok(tx.runs().find(run_id)?.is_some_and(|run| run.state == RunState::Delivering))
}

/// Writes `row` as `attempt` leaves it, if it is still the send in flight.
pub(crate) fn record_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    outcomes: &dyn RunOutcomes,
    id: &str,
    attempt: Attempt,
) -> Result<(), Error> {
    let Some(mut row) = tx.inbox_deliveries().find(id)? else { return Ok(()) };
    if row.state != super::SENDING && row.state != UNCERTAIN {
        return Ok(());
    }
    row.updated_at = at.now;
    row.next_attempt_at = None;
    let (mut problem, mut stale) = (None, None);
    match attempt {
        Attempt::Sent { receipt, traits } => {
            row.state = SENT.to_owned();
            row.receipt = Some(json!({"id": receipt.id, "url": receipt.url}).to_string());
            row.sent_at = Some(at.now);
            row.undo_until = traits.filter(|t| t.undo != Undo::None).map(|t| at.now + t.undo_window_ms);
            row.last_error_kind = None;
        }
        Attempt::Failed(error) => {
            row.last_error_kind = Some(error.detail_kind.clone());
            match error.kind {
                SendErrorKind::DevRun => row.state = FROZEN.to_owned(),
                SendErrorKind::Uncertain => {
                    row.state = UNCERTAIN.to_owned();
                    row.next_attempt_at = Some(at.now);
                }
                SendErrorKind::Transient if row.attempts < MAX_ATTEMPTS => {
                    row.state = QUEUED.to_owned();
                    let wait = RETRY_MS[usize::try_from(row.attempts - 1).unwrap_or_default().min(RETRY_MS.len() - 1)];
                    row.next_attempt_at = Some(at.now + wait);
                }
                _ => {
                    row.state = FAILED.to_owned();
                    problem = Some(Problem::Failed(error));
                }
            }
        }
        Attempt::Stale(reason) => {
            let again = Again::Stale(reason);
            row.state = STOPPED.to_owned();
            row.last_error_kind = Some(again.kind().to_owned());
            stale = Some(again);
        }
        Attempt::NoChannel => {
            row.state = WAITING_CAPABILITY.to_owned();
            row.last_error_kind = Some("no_channel".to_owned());
        }
    }
    tx.inbox_deliveries().update(&row)?;
    announce(out, &row);
    tracing::info!(delivery_id = %row.id, state = %row.state, attempts = row.attempts, error_kind = ?row.last_error_kind, "a delivery moved");
    if let Some(problem) = problem {
        // The run keeps delivering while the user decides: a retry or "I sent
        // it myself" still finishes it, and only "Don't send" fails it.
        problem_in(tx, out, at, &row, problem)?;
    } else if let Some(again) = stale {
        hold_again_in(tx, out, at, outcomes, &row, &again)?;
    } else if row.state == SENT && delivering(tx, &row.run_id)? && all_sent(tx, &row)? {
        sent_in(tx, out, at.now, outcomes, &row)?;
    }
    Ok(())
}

/// Whether every send of `row`'s run went out. A send stopped as stale, too
/// old or by the user was held again as a draft: the draft's own send replaces it, so the run is
/// not done while that draft waits.
pub(crate) fn all_sent(tx: &dyn Tx, row: &StoredDelivery) -> Result<bool, Error> {
    let superseded = |other: &StoredDelivery| {
        other.state == STOPPED && other.last_error_kind.as_deref().is_some_and(|kind| HELD_AGAIN.contains(&kind))
    };
    let rows = tx.inbox_deliveries().of_run(&row.run_id)?;
    if !rows.iter().all(|other| other.state == SENT || superseded(other)) {
        return Ok(false);
    }
    let waiting = tx.inbox_items().waiting_of_routine(&row.routine_id)?;
    Ok(!waiting.iter().any(|item| item.kind == ItemKind::Draft && item.run_id.as_deref() == Some(row.run_id.as_str())))
}

/// The run's last delivery went out: one Freedom sent ends `auto_sent`; a
/// draft the user sent ends `sent_unedited` or `sent_edited`, recorded.
pub(crate) fn sent_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    outcomes: &dyn RunOutcomes,
    row: &StoredDelivery,
) -> Result<(), Error> {
    let item = match &row.item_id {
        Some(item_id) if row.mode != AUTO => tx.inbox_items().find(item_id)?,
        _ => None,
    };
    let Some(item) = item else { return outcomes.finished(tx, out, &row.run_id, Outcome::AutoSent) };
    let sent: ResultDoc = serde_json::from_str(&row.body).map_err(|e| Error::storage(e.to_string()))?;
    let outcome = sent_outcome(&item, &sent);
    let ended = Ended { item: &item, delivery_id: Some(row.id.clone()), outcome, at: now };
    ended_in(tx, out, outcomes, ended)
}

/// A send goes back to the user as a draft: its subject moved on (03 G1),
/// never a stale send in silence; it is automatic and a day old (G5); or
/// the user stopped it. Its subject is the run's item, as the
/// gate's drafts are, so a later run's draft on that item replaces it. A
/// draft this run already holds again on that item is replaced by one that
/// also goes to its targets: every send of one run carries the same result.
/// Another run's draft it replaces ends that run as `replaced`; its own run
/// waits for the user again, on the new draft.
pub(crate) fn hold_again_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    outcomes: &dyn RunOutcomes,
    row: &StoredDelivery,
    again: &Again,
) -> Result<(), Error> {
    let doc: Value = serde_json::from_str(&row.body).unwrap_or(Value::Null);
    let run = tx.runs().find(&row.run_id)?;
    let subject_key = run.as_ref().and_then(|run| run.item_key.clone());
    let mut targets = Vec::new();
    if let Some(subject) = &subject_key {
        let held = tx.inbox_items().waiting_with_subject(subject)?;
        let held = held
            .into_iter()
            .filter(|item| item.kind == ItemKind::Draft && item.run_id.as_deref() == Some(row.run_id.as_str()));
        for item in held {
            let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
            targets.extend(payload["targets"].as_array().into_iter().flatten().cloned());
        }
    }
    targets.extend(target_of(&row.target).map(|target| target_value(&target)));
    let draft = NewItem {
        kind: ItemKind::Draft,
        producer: DRAFT_PRODUCER.to_owned(),
        routine_id: Some(row.routine_id.clone()),
        run_id: Some(row.run_id.clone()),
        subject_key,
        title: run.and_then(|run| run.headline).unwrap_or_else(|| "A result to send".to_owned()),
        summary: again.summary().to_owned(),
        payload: match again {
            Again::Stale(reason) => json!({ "doc": doc, "staleReason": reason, "targets": targets }),
            Again::TooOld | Again::Stopped => json!({ "doc": doc, "targets": targets }),
        },
        by_hand: false,
    };
    let (item, replaced) = open_replacing_in(tx, out, at, draft)?;
    replaced_in(tx, out, outcomes, &replaced, &item)?;
    // The run waits for the user again, on this draft.
    let held = tx.runs().find(&row.run_id)?;
    if held.is_some_and(|run| matches!(run.state, RunState::Delivering | RunState::WaitingForUser)) {
        outcomes.held(tx, out, &row.run_id, &item.id)?;
    }
    Ok(())
}
