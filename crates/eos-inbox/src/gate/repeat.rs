//! A second result to the same place (D55): whether a send of the same
//! routine to the same recipient about the same subject went out or is on
//! its way. The gate decides inside the writer's job, so of two results of
//! one item that reach it one after the other, the second always sees the
//! first one's row.

use std::collections::HashMap;

use eos_core::Error;
use eos_core::store::Tx;

use super::run_subject;
use crate::delivery::{FAILED, STOPPED, UNDONE};

/// Whether the routine already sent `subject` to `recipient_id`, or a send
/// of it there waits, is out or is unknown. A send that failed, was stopped
/// or was taken back never reached the recipient. A result with no subject
/// (a digest of no item) is never a repeat.
pub(crate) fn sent_before_in(
    tx: &dyn Tx,
    routine_id: &str,
    recipient_id: &str,
    subject: Option<&str>,
) -> Result<bool, Error> {
    let Some(subject) = subject else { return Ok(false) };
    let mut subjects: HashMap<String, Option<String>> = HashMap::new();
    for row in tx.inbox_deliveries().to_recipient(routine_id, recipient_id)? {
        if [FAILED, STOPPED, UNDONE].contains(&row.state.as_str()) {
            continue;
        }
        let of_run = match subjects.get(&row.run_id) {
            Some(known) => known.clone(),
            None => {
                let found = tx.runs().find(&row.run_id)?.as_ref().and_then(run_subject);
                subjects.insert(row.run_id.clone(), found.clone());
                found
            }
        };
        if of_run.as_deref() == Some(subject) {
            return Ok(true);
        }
    }
    Ok(false)
}
