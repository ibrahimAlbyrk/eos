//! The user sends a held draft (03 §6, G2, G4, G5): in one write job the
//! draft is answered on the rev the user saw, one delivery per target is
//! queued as approved, what the user changed is kept, and the run hears it
//! is delivering. The delivery engine is poked once the job committed.
//!
//! The targets are the ones the gate checked when it held the result; for a
//! mail, those whose recipient part the user kept.

use eos_contracts::{ActionClass, ResultDoc};
use eos_core::delivery::{ChannelTraits, Idempotency, Target, Undo};
use eos_core::store::{ItemAnswer, StoredDelivery};
use eos_domain::inbox::ItemKind;
use eos_domain::result_doc::{MAIL, recipient_key};
use eos_domain::routine::run::RunState;
use serde_json::Value;

use crate::answer::{Checked, answer_in, waiting_at};
use crate::delivery::{NewDelivery, queue_in, target_from};
use crate::edits::{Sent, capture_in};
use crate::outcomes::held_doc;
use crate::{Error, Items, consume_in};

/// What a sent draft stores as the answer.
const SENT: &str = r#"{"send":true}"#;

/// The traits of an action no channel offers now (its capability is gone):
/// the send waits for it, and is treated as one that cannot be taken back.
const NO_CHANNEL: ChannelTraits = ChannelTraits {
    class: ActionClass::Irreversible,
    idempotency: Idempotency::None,
    undo: Undo::None,
    undo_window_ms: 0,
    max_bytes: usize::MAX,
};

fn invalid(message: &str) -> eos_core::Error {
    eos_core::Error::Validation(message.to_owned())
}

/// The targets the held draft names that `doc` still goes to.
fn targets(payload: &Value, doc: &ResultDoc) -> Vec<Target> {
    let held = payload["targets"].as_array().into_iter().flatten().filter_map(target_from);
    let kept = |target: &Target| {
        let key = recipient_key(&target.recipient_id);
        doc.kind != MAIL || doc.parts.iter().any(|part| part.key == key)
    };
    held.filter(kept).collect()
}

impl Items {
    /// Sends the draft as it was at `rev`: as the user edited it in `doc`,
    /// else as last saved, else as held. `by` is who sent it. Answers one
    /// delivery per target.
    pub async fn send(
        &self,
        id: &str,
        rev: i64,
        doc: Option<ResultDoc>,
        by: &str,
    ) -> Result<Vec<StoredDelivery>, Error> {
        let now = self.clock.now_ms();
        let answer = ItemAnswer { by: by.to_owned(), answer: Some(SENT.to_owned()), at: now };
        let (id, ids, channels, outcomes) =
            (id.to_owned(), self.ids.clone(), self.channels.clone(), self.outcomes.clone());
        let rows = self
            .store
            .write(move |tx, out| -> Result<Result<Vec<StoredDelivery>, Error>, eos_core::Error> {
                let item: Checked = waiting_at(tx, &id, Some(rev))?;
                let item = match item {
                    Ok(item) if item.kind == ItemKind::Draft => item,
                    Ok(_) => return Err(invalid("only a draft is sent")),
                    Err(refused) => return Ok(Err(refused)),
                };
                let (Some(routine_id), Some(run_id)) = (item.routine_id.clone(), item.run_id.clone()) else {
                    return Err(invalid("the draft belongs to no run"));
                };
                let payload: Value = serde_json::from_str(&item.payload).unwrap_or(Value::Null);
                let held = held_doc(&payload).ok_or_else(|| invalid("the draft holds no result"))?;
                let saved = item.working.as_deref().and_then(|text| serde_json::from_str::<ResultDoc>(text).ok());
                let sent = doc.or(saved).unwrap_or_else(|| held.clone());
                if (&sent.kind, &sent.channel, &sent.action) != (&held.kind, &held.channel, &held.action) {
                    return Err(invalid("a draft is sent as what it is, where it was to go"));
                }
                let targets = targets(&payload, &sent);
                if targets.is_empty() {
                    return Err(invalid("the draft goes to nobody"));
                }
                let item = match answer_in(tx, out, &id, rev, &answer)? {
                    Ok(item) => item,
                    Err(refused) => return Ok(Err(refused)),
                };
                consume_in(tx, &item.id, now)?;
                let traits = channels.get(&sent.channel).and_then(|channel| channel.traits(&sent.action));
                let traits = traits.unwrap_or(NO_CHANNEL);
                let mut rows = Vec::new();
                for target in &targets {
                    let new = NewDelivery {
                        run_id: &run_id,
                        routine_id: &routine_id,
                        doc: &sent,
                        target,
                        traits: &traits,
                        item_id: Some(item.id.clone()),
                    };
                    rows.push(queue_in(tx, out, now, ids.as_ref(), new)?);
                }
                capture_in(
                    tx,
                    Sent {
                        item_id: &item.id,
                        delivery_id: rows.first().map(|row| row.id.clone()),
                        routine_id: &routine_id,
                        run_id: &run_id,
                        before: &held,
                        after: &sent,
                        untrusted: payload["untrusted"].as_bool().unwrap_or(true),
                        at: now,
                    },
                )?;
                if tx.runs().find(&run_id)?.is_some_and(|run| run.state == RunState::WaitingForUser) {
                    outcomes.delivering(tx, out, &run_id)?;
                }
                tracing::info!(item_id = %item.id, run_id = %run_id, deliveries = rows.len(), by = %answer.by, "a draft was sent");
                Ok(Ok(rows))
            })
            .await??;
        self.wake.notify_one();
        Ok(rows)
    }
}
