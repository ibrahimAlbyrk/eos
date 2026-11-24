//! A routine run's questions in Needs you (03 §4.6, G8, G24). A worker that
//! works for a run asks through a `question` item, written in the job that
//! finds its run, and waits for the user's answer without a limit. Every
//! other worker (a chat, an architect) asks as it always did.
//!
//! An asker that stops waiting (its turn was interrupted) takes its item
//! back, except while the app shuts down: then the item stays open, and an
//! answer given after the restart waits, unconsumed, for the routines to act
//! on, since no asker is left to hear it. An item that ends without an
//! answer some other way (withdrawn with its routine, expired with its
//! subject, replaced) wakes its asker with [`WITHDRAWN`] as the answer to
//! each question ([`QuestionWaiters::closed`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{InboxAnswer, InboxChange, Question, UnknownRecord};
use eos_core::agent::UserQuestions;
use eos_core::os::TimeZone;
use eos_core::routine::RoutineControl;
use eos_core::store::{Store, StoredItem};
use eos_core::{BoxFuture, Clock, Ids};
use eos_domain::inbox::{ItemKind, ItemState};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::control::LateControl;
use crate::{NewItem, Opening, announce, consume_in, open_in};

/// Who acts on a run question's answer once its asker is gone (01 G52).
pub(crate) const QUESTION_PRODUCER: &str = "routines";

/// The answers by question text, or `None` when the user turned the
/// question away.
type Answers = Option<UnknownRecord>;

/// What a parked asker hears.
pub(crate) enum Heard {
    Answered(Answers),
    /// The item ended without an answer.
    Withdrawn,
}

/// What an asker whose question was taken away hears as its answer.
pub const WITHDRAWN: &str =
    "This question was withdrawn before the user answered it. Go on without its answer, or stop if you cannot.";

/// The askers waiting on their items, by item id. The answer and discard of
/// an item wake its asker after their job committed.
#[derive(Default)]
pub struct QuestionWaiters(Mutex<HashMap<String, oneshot::Sender<Heard>>>);

impl std::fmt::Debug for QuestionWaiters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QuestionWaiters").finish_non_exhaustive()
    }
}

impl QuestionWaiters {
    fn locked(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<Heard>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn park(&self, item_id: &str) -> oneshot::Receiver<Heard> {
        let (waiter, heard) = oneshot::channel();
        self.locked().insert(item_id.to_owned(), waiter);
        heard
    }

    /// Whether an asker waits on `item_id`: its answer is heard there, and
    /// the routines need not act on it.
    pub(crate) fn waits(&self, item_id: &str) -> bool {
        self.locked().contains_key(item_id)
    }

    fn forget(&self, item_id: &str) {
        self.locked().remove(item_id);
    }

    /// Hands the asker of `item` what the item's answer says, if it waits.
    pub(crate) fn wake(&self, item: &StoredItem) {
        if item.kind != ItemKind::Question {
            return;
        }
        if let Some(waiter) = self.locked().remove(&item.id) {
            let _ = waiter.send(Heard::Answered(answers_of(item)));
        }
    }

    /// Wakes the asker of a question item that ended without an answer, as
    /// `inbox:change` announced it (`withdrawn`, `expired` or `replaced`).
    /// An asker that took its own item back no longer waits.
    pub fn closed(&self, change: &InboxChange) {
        let ended = matches!(change.state.as_str(), "withdrawn" | "expired" | "replaced");
        if change.kind != ItemKind::Question.as_str() || !ended {
            return;
        }
        if let Some(waiter) = self.locked().remove(&change.id) {
            tracing::info!(item_id = %change.id, state = %change.state, "a waiting asker's question ended unanswered");
            let _ = waiter.send(Heard::Withdrawn);
        }
    }
}

/// What an answered question item says: its answers by question text, or
/// `None` for a discard.
fn answers_of(item: &StoredItem) -> Answers {
    let answer = serde_json::from_str::<InboxAnswer>(item.answer.as_deref()?).ok()?;
    let InboxAnswer::Question { answers } = answer else { return None };
    Some(answers.into_iter().map(|(question, answer)| (question, Value::String(answer))).collect())
}

/// Each question answered with [`WITHDRAWN`].
fn withdrawn(questions: &[Question]) -> UnknownRecord {
    questions.iter().map(|q| (q.question.clone(), Value::String(WITHDRAWN.to_owned()))).collect()
}

/// What a question item carries: `{questions: [{question, options?: [{label}]}]}`.
fn payload(questions: &[Question]) -> Value {
    let questions: Vec<Value> = questions
        .iter()
        .map(|q| {
            let mut shown = json!({ "question": q.question });
            if !q.options.is_empty() {
                shown["options"] = q.options.iter().map(|option| json!({ "label": option.label })).collect();
            }
            shown
        })
        .collect();
    json!({ "questions": questions })
}

/// What a run question is built from.
pub struct RunQuestionParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The user's clock, for the items it opens.
    pub zone: Arc<dyn TimeZone>,
    /// How every other worker asks.
    pub wrapped: Arc<dyn UserQuestions>,
}

impl std::fmt::Debug for RunQuestionParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunQuestionParts").finish_non_exhaustive()
    }
}

pub(crate) struct Inner {
    pub(crate) parts: RunQuestionParts,
    pub(crate) control: LateControl,
    pub(crate) waiters: Arc<QuestionWaiters>,
    closing: AtomicBool,
}

/// The user's questions for every session: a run's in Needs you, the rest
/// as the wrapped questions ask them.
#[derive(Clone)]
pub struct RunQuestions(pub(crate) Arc<Inner>);

impl std::fmt::Debug for RunQuestions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunQuestions").finish_non_exhaustive()
    }
}

impl RunQuestions {
    pub fn new(parts: RunQuestionParts) -> Self {
        Self(Arc::new(Inner {
            parts,
            control: LateControl::default(),
            waiters: Arc::default(),
            closing: AtomicBool::new(false),
        }))
    }

    /// The routines' control, which pauses a routine with too many items
    /// waiting. The caller keeps it alive.
    pub fn attach(&self, control: &Arc<dyn RoutineControl>) {
        self.0.control.attach(control);
    }

    /// The askers waiting, for the [`Items`](crate::Items) that answer them.
    pub fn waiters(&self) -> Arc<QuestionWaiters> {
        self.0.waiters.clone()
    }

    /// The app shuts down: askers stopped from now on leave their items open.
    pub fn close(&self) {
        self.0.closing.store(true, Ordering::SeqCst);
    }

    /// Opens the question item if `worker_id` works for a run; `None` for
    /// any other worker.
    async fn open(&self, worker_id: &str, questions: &[Question]) -> Result<Option<String>, eos_core::Error> {
        // A chat asks also before the routines are attached.
        let control = self.0.control.get();
        let parts = &self.0.parts;
        let (ids, zone, now) = (parts.ids.clone(), parts.zone.clone(), parts.clock.now_ms());
        let (worker, payload) = (worker_id.to_owned(), payload(questions));
        let title = questions.first().map(|q| q.question.clone()).unwrap_or_default();
        parts
            .store
            .write(move |tx, out| {
                let Some(run) = tx.routine_sessions().run_of(&worker)? else { return Ok(None) };
                let control = control?;
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                let new = NewItem {
                    kind: ItemKind::Question,
                    producer: QUESTION_PRODUCER.to_owned(),
                    routine_id: Some(run.routine_id),
                    run_id: Some(run.run_id),
                    subject_key: None,
                    title,
                    summary: "A routine's run waits for your answer.".to_owned(),
                    payload,
                    by_hand: run.origin == "hand",
                };
                let item = open_in(tx, out, &at, new)?;
                tracing::info!(item_id = %item.id, worker_id = %worker, "a run's question waits in Needs you");
                Ok(Some(item.id))
            })
            .await
    }

    /// Parks the asker of `item_id` until the item is answered or ends,
    /// without a time limit: the user may answer days later. A heard answer
    /// is marked so the routines need not act on it; an asker that stops
    /// waiting takes its item back.
    pub(crate) async fn wait(&self, item_id: &str) -> Option<Heard> {
        let heard = self.0.waiters.park(item_id);
        let mut guard = Withdraw { questions: self.clone(), item_id: item_id.to_owned(), armed: true };
        let heard = match self.settled(item_id).await {
            Ok(Some(settled)) => {
                self.0.waiters.forget(item_id);
                Some(settled)
            }
            Ok(None) => heard.await.ok(),
            Err(error) => {
                tracing::warn!(item_id, %error, "a run's question could not be read");
                heard.await.ok()
            }
        };
        guard.armed = false;
        if matches!(heard, Some(Heard::Answered(_))) {
            self.consume(item_id).await;
        }
        heard
    }

    /// What the asker hears if the item was answered or ended before its
    /// asker was parked.
    async fn settled(&self, item_id: &str) -> Result<Option<Heard>, eos_core::Error> {
        let id = item_id.to_owned();
        let item = self.0.parts.store.read(move |tx| tx.inbox_items().find(&id)).await?;
        Ok(item.and_then(|item| match item.state {
            ItemState::Answered => Some(Heard::Answered(answers_of(&item))),
            ItemState::Withdrawn | ItemState::Expired | ItemState::Replaced => Some(Heard::Withdrawn),
            _ => None,
        }))
    }

    /// The asker heard the answer: the routines need not act on it.
    async fn consume(&self, item_id: &str) {
        let (id, now) = (item_id.to_owned(), self.0.parts.clock.now_ms());
        if let Err(error) = self.0.parts.store.write(move |tx, _| consume_in(tx, &id, now)).await {
            tracing::warn!(item_id, %error, "a heard answer could not be marked");
        }
    }

    /// Takes back the item of an asker that stopped waiting.
    async fn withdraw(&self, item_id: &str) {
        let (id, now) = (item_id.to_owned(), self.0.parts.clock.now_ms());
        let written = self
            .0
            .parts
            .store
            .write(move |tx, out| {
                let Some(mut item) = tx.inbox_items().find(&id)? else { return Ok(()) };
                if !item.state.is_waiting() {
                    return Ok(());
                }
                let rev = item.rev;
                item.state = ItemState::Withdrawn;
                item.rev += 1;
                item.updated_at = now;
                if tx.inbox_items().update_waiting(&item, rev)? {
                    tracing::info!(item_id = %item.id, "a run's question was taken back");
                    announce(tx, out, &item)?;
                }
                Ok(())
            })
            .await;
        if let Err(error) = written {
            tracing::warn!(item_id, %error, "an abandoned question could not be taken back");
        }
    }
}

/// Takes the asker's item back when the asker stops waiting, unless the app
/// shuts down.
struct Withdraw {
    questions: RunQuestions,
    item_id: String,
    armed: bool,
}

impl Drop for Withdraw {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.questions.0.waiters.forget(&self.item_id);
        if self.questions.0.closing.load(Ordering::SeqCst) {
            tracing::info!(item_id = %self.item_id, "a run's question stays open over the shutdown");
            return;
        }
        let (questions, item_id) = (self.questions.clone(), std::mem::take(&mut self.item_id));
        if let Ok(tasks) = Handle::try_current() {
            tasks.spawn(async move { questions.withdraw(&item_id).await });
        }
    }
}

impl UserQuestions for RunQuestions {
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        Box::pin(async move {
            let parsed = eos_contracts::parse::<Vec<Question>>(&json!(questions)).ok().filter(|q| !q.is_empty());
            let opened = match &parsed {
                Some(parsed) => self.open(worker_id, parsed).await,
                // The wrapped questions say why they cannot be shown.
                None => Ok(None),
            };
            let item_id = match opened {
                Ok(Some(item_id)) => item_id,
                Ok(None) => return self.0.parts.wrapped.ask(worker_id, call_id, questions).await,
                Err(error) => {
                    tracing::warn!(worker_id, %error, "a run's question could not be opened");
                    return None;
                }
            };
            match self.wait(&item_id).await {
                Some(Heard::Answered(answers)) => answers,
                Some(Heard::Withdrawn) => Some(withdrawn(parsed.as_deref().unwrap_or_default())),
                None => None,
            }
        })
    }
}
