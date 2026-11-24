//! A routine's returned View in Needs you (03 §4.5, 05 §4). A `question`
//! View is a `question` item that interrupts, and its run waits on it as on
//! any run question: the user's press answers it, and the run hears what was
//! pressed. A `result` View is a card, a `notice` the user can put aside;
//! a newer View of the same surface takes its place. Both name their issue
//! (`{surfaceId, issueId}`), count toward the badge and take their kind's
//! attention.

use eos_contracts::InboxAnswer;
use eos_core::store::{ItemAnswer, Outbox, Tx};
use eos_core::surface::{ViewCard, ViewCards};
use eos_core::{BoxFuture, Error};
use eos_domain::inbox::ItemKind;
use serde_json::json;

use crate::answer::{answer_in, heard_in, waiting_at};
use crate::questions::{Heard, QUESTION_PRODUCER, RunQuestions, WITHDRAWN};
use crate::{NewItem, Opening, open_in};

/// Who makes a View's card.
const CARD_PRODUCER: &str = "surfaces";

fn new_item(card: &ViewCard) -> NewItem {
    let view = json!({"surfaceId": card.surface_id, "issueId": card.issue_id});
    let (kind, producer, subject_key, payload) = if card.question {
        let mut payload = json!({"questions": [{"question": card.title}]});
        payload["view"] = view;
        (ItemKind::Question, QUESTION_PRODUCER, None, payload)
    } else {
        (ItemKind::Notice, CARD_PRODUCER, Some(card.surface_id.clone()), json!({"view": view}))
    };
    NewItem {
        kind,
        producer: producer.to_owned(),
        routine_id: Some(card.routine_id.clone()),
        run_id: Some(card.run_id.clone()),
        subject_key,
        title: card.title.clone(),
        summary: card.summary.clone(),
        payload,
        by_hand: card.by_hand,
    }
}

/// What the run reads of the user's answer.
fn told(heard: Option<Heard>) -> String {
    match heard {
        Some(Heard::Answered(Some(answers))) => {
            let pressed: Vec<String> =
                answers.values().filter_map(|answer| answer.as_str()).map(str::to_owned).collect();
            format!("The user answered: {}", pressed.join("; "))
        }
        Some(Heard::Answered(None)) => "The user turned the question away. Go on without its answer.".to_owned(),
        Some(Heard::Withdrawn) | None => WITHDRAWN.to_owned(),
    }
}

impl ViewCards for RunQuestions {
    fn open_in(&self, tx: &dyn Tx, out: &mut Outbox, now: i64, card: &ViewCard) -> Result<String, Error> {
        let parts = &self.0.parts;
        let control = self.0.control.get()?;
        let at = Opening { now, ids: parts.ids.as_ref(), zone: parts.zone.as_ref(), control: control.as_ref() };
        let item = open_in(tx, out, &at, new_item(card))?;
        tracing::info!(item_id = %item.id, issue = %card.issue_id, question = card.question, "a view waits in Needs you");
        Ok(item.id)
    }

    fn heard<'a>(&'a self, item_id: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async move { told(self.wait(item_id).await) })
    }

    fn answer<'a>(&'a self, item_id: &'a str, pressed: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let (id, now, waiters) = (item_id.to_owned(), self.0.parts.clock.now_ms(), self.0.waiters.clone());
            let pressed = pressed.to_owned();
            let answered = self
                .0
                .parts
                .store
                .write(move |tx, out| {
                    let Ok(item) = waiting_at(tx, &id, None)? else { return Ok(None) };
                    if item.kind != ItemKind::Question {
                        return Ok(None);
                    }
                    let typed =
                        InboxAnswer::Question { answers: [(item.title.clone(), pressed)].into_iter().collect() };
                    let text = serde_json::to_string(&typed).map_err(|e| Error::Validation(e.to_string()))?;
                    let answer = ItemAnswer { by: "dashboard".to_owned(), answer: Some(text), at: now };
                    let Ok(item) = answer_in(tx, out, &id, item.rev, &answer)? else { return Ok(None) };
                    heard_in(tx, &waiters, &item, now)?;
                    Ok(Some(item))
                })
                .await?;
            if let Some(item) = answered {
                self.0.waiters.wake(&item);
            }
            Ok(())
        })
    }
}
