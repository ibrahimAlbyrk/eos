//! The user's answer to a routine's alert, acted on in the answering job:
//! Resume resumes the routine paused for the alert's reason, Keep paused
//! leaves it paused. A routine paused because too many results wait is not
//! resumed while they still wait; one paused because a target was refused
//! is not resumed while its head names a recipient the user has not
//! confirmed, and that refusal is passed on (D53).

use eos_contracts::AlertChoice;
use eos_core::Error;
use eos_core::routine::{ResumeError, RoutineControl};
use eos_core::store::{Outbox, StoredItem, Tx};
use eos_domain::inbox::ItemKind;
use serde_json::Value;

use crate::items::ALERT_PRODUCER;
use crate::{ROUTINE_CAP, TOO_MANY_WAITING, consume_in};

/// Whether this side acts on `item`'s answer: a routine's alert.
pub(crate) fn acted_on(item: &StoredItem) -> bool {
    item.kind == ItemKind::RoutineAlert && item.producer == ALERT_PRODUCER
}

pub(crate) fn answered_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    control: &dyn RoutineControl,
    item: &StoredItem,
    choice: AlertChoice,
    now: i64,
) -> Result<(), ResumeError> {
    consume_in(tx, &item.id, now)?;
    let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
    let (Some(routine_id), Some(reason), AlertChoice::Resume) =
        (item.routine_id.as_deref(), payload["reason"].as_str(), choice)
    else {
        return Ok(());
    };
    if reason == TOO_MANY_WAITING {
        let waiting = tx.inbox_items().waiting_of_routine(routine_id)?;
        let results = waiting.iter().filter(|item| item.kind != ItemKind::RoutineAlert).count();
        if results > ROUTINE_CAP {
            return Err(ResumeError::Store(Error::Conflict(format!(
                "{results} results still wait for you. Go through some of them, then resume the routine."
            ))));
        }
    }
    control.resume_in(tx, out, routine_id, reason)
}
