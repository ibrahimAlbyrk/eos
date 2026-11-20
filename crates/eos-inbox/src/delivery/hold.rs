//! Stopping a send in its hold (03 G6): a row that has not gone out
//! (`holding` or `queued`) is stopped. A send the user approved stops with
//! every send of its draft that waits too, the draft opens again for the
//! user one rev up, and the run waits for the user again; an automatic one
//! goes back to the user as a new draft.

use eos_core::Error;
use eos_core::store::StoredDelivery;
use eos_domain::routine::run::RunState;

use super::record::{Again, hold_again_in};
use super::{HOLDING, QUEUED, STOPPED, announce};
use crate::{Items, Opening, announce as announce_item};

fn not_out(row: &StoredDelivery) -> bool {
    row.state == HOLDING || row.state == QUEUED
}

impl Items {
    /// Stops the send `id` before it goes out; the row as it is then. A send
    /// on its way or out already is refused.
    pub async fn stop_delivery(&self, id: &str) -> Result<StoredDelivery, crate::Error> {
        let (id, now) = (id.to_owned(), self.clock.now_ms());
        let (ids, zone, control, outcomes) =
            (self.ids.clone(), self.zone.clone(), self.control.clone(), self.outcomes.clone());
        let row = self
            .store
            .write(move |tx, out| {
                let row = tx.inbox_deliveries().find(&id)?.ok_or_else(|| Error::not_found("delivery", &id))?;
                if !not_out(&row) {
                    return Err(Error::Conflict("It is on its way already and cannot be stopped.".into()));
                }
                let again = Again::Stopped;
                let mut stopped = Vec::new();
                for mut sibling in tx.inbox_deliveries().of_run(&row.run_id)? {
                    let same_send = sibling.id == row.id || (row.item_id.is_some() && sibling.item_id == row.item_id);
                    if !same_send || !not_out(&sibling) {
                        continue;
                    }
                    sibling.state = STOPPED.to_owned();
                    sibling.last_error_kind = Some(again.kind().to_owned());
                    sibling.next_attempt_at = None;
                    sibling.updated_at = now;
                    tx.inbox_deliveries().update(&sibling)?;
                    announce(out, &sibling);
                    stopped.push(sibling);
                }
                tracing::info!(delivery_id = %row.id, stopped = stopped.len(), "a send was stopped in its hold");
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                match &row.item_id {
                    Some(item_id) if tx.inbox_items().reopen(item_id, now)? => {
                        let item = tx.inbox_items().find(item_id)?.ok_or_else(|| Error::not_found("item", item_id))?;
                        announce_item(tx, out, &item)?;
                        let run = tx.runs().find(&row.run_id)?;
                        if run.is_some_and(|run| run.state == RunState::Delivering) {
                            outcomes.held(tx, out, &row.run_id, item_id)?;
                        }
                    }
                    Some(_) => {}
                    None => hold_again_in(tx, out, &at, outcomes.as_ref(), &row, &again)?,
                }
                let stopped = stopped.into_iter().find(|sibling| sibling.id == row.id);
                stopped.ok_or_else(|| Error::not_found("delivery", &row.id))
            })
            .await?;
        Ok(row)
    }
}
