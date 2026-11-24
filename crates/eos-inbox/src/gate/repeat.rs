//! A second result to the same place (D55): whether a send of the same
//! routine to the same recipient about the same subject went out or is on
//! its way. The gate decides inside the writer's job, so of two results of
//! one item that reach it one after the other, the second always sees the
//! first one's row.

use std::collections::HashMap;

use eos_core::Error;
use eos_core::os::TimeZone;
use eos_core::store::{StoredRun, Tx};

use super::run_subject;
use crate::delivery::{FAILED, SENT, STOPPED, UNDONE};
use crate::items::local_day;

/// What a result is about, for D55: its item without the version and the
/// version it was made on; none for a run with no item, whose subject is
/// the routine itself (D64).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct About {
    pub(crate) subject: Option<String>,
    pub(crate) version: Option<String>,
}

impl About {
    pub(crate) fn of(run: &StoredRun) -> Self {
        let input: serde_json::Value = serde_json::from_str(&run.input).unwrap_or_default();
        Self { subject: run_subject(run), version: input["item"]["version"].as_str().map(str::to_owned) }
    }
}

/// Whether the routine already sent what `about` is about to `recipient_id`,
/// or a send of it there is still on its way. A send that went out repeats
/// only on the same version of the item (D65), or for a routine with no
/// item, on the same local day (D64). A send that failed, was stopped or
/// was taken back never reached the recipient.
pub(crate) fn sent_before_in(
    tx: &dyn Tx,
    zone: &dyn TimeZone,
    now: i64,
    routine_id: &str,
    recipient_id: &str,
    about: &About,
) -> Result<bool, Error> {
    let mut runs: HashMap<String, About> = HashMap::new();
    for row in tx.inbox_deliveries().to_recipient(routine_id, recipient_id)? {
        if [FAILED, STOPPED, UNDONE].contains(&row.state.as_str()) {
            continue;
        }
        let of_run = match runs.get(&row.run_id) {
            Some(known) => known.clone(),
            None => {
                let found = tx.runs().find(&row.run_id)?.as_ref().map(About::of);
                let found = found.unwrap_or(About { subject: None, version: None });
                runs.insert(row.run_id.clone(), found.clone());
                found
            }
        };
        if of_run.subject != about.subject {
            continue;
        }
        let on_its_way = row.state != SENT;
        let same = match &about.subject {
            Some(_) => of_run.version == about.version,
            None => local_day(zone, row.created_at) == local_day(zone, now),
        };
        if on_its_way || same {
            return Ok(true);
        }
    }
    Ok(false)
}
