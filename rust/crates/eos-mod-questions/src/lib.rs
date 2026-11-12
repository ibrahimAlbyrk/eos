//! Questions an agent puts to the user (`ask_user`, a focused session's own
//! question tool) and banners for the user (`notify_user`).
//!
//! [`Questions`] holds the open questions. A question shows as a banner in
//! the asker's chat (the `question_pending` row), the user hears "Input
//! needed", and the asker waits — as long as it takes — until the dashboard
//! posts the answers or a dismissal (`question_answered`). An asker whose
//! turn is interrupted takes its question back, so no banner lingers.
//!
//! | Route | |
//! |---|---|
//! | `POST /workers/:id/question` | opens a question for a caller outside the app, which polls |
//! | `GET /workers/:id/question/:questionId` | `pending`, `answered`, `dismissed` or `gone` |
//! | `POST /workers/:id/question-answer` | the user's answers, or a dismissal |
//!
//! Open questions are kept in memory: a question does not outlive the app,
//! as it did not outlive the daemon. Its banner row stays in the chat, and an
//! answer to it then reads `gone`.

mod pending;
mod routes;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::stream::topics::{NOTIFICATION_FIRE, WORKER_CHANGE, WORKER_REMOVED};
use eos_contracts::{Question, QuestionPollResponse, UnknownRecord, WorkerEventType};
use eos_core::agent::{OpenQuestions, UserNotifier, UserQuestions};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_runtime::bus::{Bus, Subscription};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::pending::{Answers, Pending, Waiter};

/// The payload of `notification:fire`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Banner<'a> {
    title: &'a str,
    body: &'a str,
    worker_id: &'a str,
    ts: i64,
}

/// How answering a question went, as the dashboard is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Answered,
    Dismissed,
    /// No open question under that tool call.
    Gone,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Answered => "answered",
            Outcome::Dismissed => "dismissed",
            Outcome::Gone => "gone",
        }
    }
}

/// An opened question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub question_id: String,
    /// The tool call it belongs to; named by the app when the caller named none.
    pub tool_use_id: String,
}

struct Inner {
    store: Arc<dyn Store>,
    bus: Bus,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    pending: Mutex<Pending>,
}

/// The questions waiting for the user, and the way to reach the user.
#[derive(Clone)]
pub struct Questions(Arc<Inner>);

impl std::fmt::Debug for Questions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Questions").finish_non_exhaustive()
    }
}

impl Questions {
    pub fn new(store: Arc<dyn Store>, bus: Bus, clock: Arc<dyn Clock>, ids: Arc<dyn Ids>) -> Self {
        Self(Arc::new(Inner { store, bus, clock, ids, pending: Mutex::default() }))
    }

    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.0.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lists a question as open. Nothing is shown yet.
    fn admit(&self, worker_id: &str, tool_use_id: Option<String>, waiter: Option<Waiter>) -> Opened {
        let tool_use_id = tool_use_id.filter(|id| !id.is_empty()).unwrap_or_else(|| self.0.ids.pending_id());
        let question_id = self.0.ids.pending_id();
        let now = self.0.clock.now_ms();
        self.pending().register(question_id.clone(), worker_id, &tool_use_id, waiter, now);
        Opened { question_id, tool_use_id }
    }

    /// Shows an open question: the banner row in the asker's chat and "Input
    /// needed" for the user, who may be looking elsewhere.
    async fn show(&self, worker_id: &str, tool_use_id: &str, questions: Vec<Question>) -> Result<(), Error> {
        let now = self.0.clock.now_ms();
        let headline = questions.first().map(|q| q.question.clone()).filter(|q| !q.is_empty());
        let row = json!({"toolUseId": tool_use_id, "questions": questions});
        let worker = worker_id.to_owned();
        self.0
            .store
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&worker, now, WorkerEventType::QuestionPending, &row)?;
                out.push(WORKER_CHANGE, &json!({"workerId": worker, "rowId": row_id}));
                let body = headline.as_deref().unwrap_or("A question is waiting in the dashboard.");
                out.push(NOTIFICATION_FIRE, &Banner { title: "Input needed", body, worker_id: &worker, ts: now });
                Ok(())
            })
            .await
    }

    /// Opens a question for a caller that polls for the answer.
    pub async fn register(
        &self,
        worker_id: &str,
        tool_use_id: Option<String>,
        questions: Vec<Question>,
    ) -> Result<Opened, Error> {
        let opened = self.admit(worker_id, tool_use_id, None);
        self.show(worker_id, &opened.tool_use_id, questions).await?;
        Ok(opened)
    }

    pub fn poll(&self, question_id: &str) -> QuestionPollResponse {
        let now = self.0.clock.now_ms();
        self.pending().poll(question_id, now)
    }

    /// The user's answers (`Some`) or dismissal (`None`). The chat's banner
    /// closes either way, also when nobody waits for the answer any more.
    pub async fn answer(&self, worker_id: &str, tool_use_id: &str, answers: Option<Answers>) -> Result<Outcome, Error> {
        let now = self.0.clock.now_ms();
        let dismissed = answers.is_none();
        let shown = answers.clone().unwrap_or_default();
        let settled = self.pending().settle(worker_id, tool_use_id, answers, now);
        let mut row = json!({"toolUseId": tool_use_id, "answers": shown});
        if dismissed && let Some(fields) = row.as_object_mut() {
            fields.insert("dismissed".into(), true.into());
        }
        let worker = worker_id.to_owned();
        self.0
            .store
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&worker, now, WorkerEventType::QuestionAnswered, &row)?;
                out.push(WORKER_CHANGE, &json!({"workerId": worker, "rowId": row_id}));
                Ok(())
            })
            .await?;
        Ok(match (settled, dismissed) {
            (false, _) => Outcome::Gone,
            (true, true) => Outcome::Dismissed,
            (true, false) => Outcome::Answered,
        })
    }

    /// Forgets the questions of a worker that was removed.
    pub fn cancel_worker(&self, worker_id: &str) {
        self.pending().cancel_worker(worker_id);
    }
}

/// Takes an asker's question back when the asker stops waiting (its turn was
/// interrupted), so its banner does not linger.
struct Withdraw {
    questions: Questions,
    worker_id: String,
    tool_use_id: String,
    tasks: Handle,
    armed: bool,
}

impl Drop for Withdraw {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (questions, worker_id, tool_use_id) =
            (self.questions.clone(), std::mem::take(&mut self.worker_id), std::mem::take(&mut self.tool_use_id));
        self.tasks.spawn(async move {
            if let Err(e) = questions.answer(&worker_id, &tool_use_id, None).await {
                tracing::warn!(worker = %worker_id, error = %e, "an abandoned question could not be closed");
            }
        });
    }
}

impl UserQuestions for Questions {
    fn ask<'a>(
        &'a self,
        worker_id: &'a str,
        call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        Box::pin(async move {
            // The questions as the banner shows them: the fields it knows, checked.
            let questions = match eos_contracts::parse::<Vec<Question>>(&json!(questions)) {
                Ok(questions) if !questions.is_empty() => questions,
                Ok(_) => return None,
                Err(e) => {
                    tracing::warn!(worker = worker_id, error = %e.message(), "a question for the user was not understood");
                    return None;
                }
            };
            let (waiter, heard) = oneshot::channel();
            let opened = self.admit(worker_id, call_id.map(str::to_owned), Some(waiter));
            // From here on the question is the asker's to take back, whenever it stops waiting.
            let mut guard = Withdraw {
                questions: self.clone(),
                worker_id: worker_id.to_owned(),
                tool_use_id: opened.tool_use_id.clone(),
                tasks: Handle::current(),
                armed: true,
            };
            if let Err(e) = self.show(worker_id, &opened.tool_use_id, questions).await {
                tracing::warn!(worker = worker_id, error = %e, "a question for the user could not be shown");
                return None;
            }
            // No time limit: the user may answer days later.
            let answer = heard.await;
            guard.armed = false;
            let answers = answer.ok().flatten()?;
            Some(answers.into_iter().map(|(question, answer)| (question, Value::String(answer))).collect())
        })
    }
}

impl UserNotifier for Questions {
    fn notify(&self, worker_id: &str, title: &str, body: &str) {
        let banner = Banner { title, body, worker_id, ts: self.0.clock.now_ms() };
        match serde_json::to_vec(&banner) {
            Ok(json) => self.0.bus.publish_raw(NOTIFICATION_FIRE, None, json.into()),
            Err(e) => tracing::error!(error = %e, "a notification could not be written"),
        }
    }
}

impl OpenQuestions for Questions {
    fn has_open(&self, worker_id: &str) -> bool {
        self.pending().has_open(worker_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRemoved {
    worker_id: String,
}

pub struct QuestionsModule {
    questions: Questions,
    listening: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for QuestionsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QuestionsModule").finish_non_exhaustive()
    }
}

impl QuestionsModule {
    pub fn new(questions: Questions) -> Self {
        Self { questions, listening: Mutex::new(None) }
    }
}

impl Module for QuestionsModule {
    fn id(&self) -> &'static str {
        "questions"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.questions)
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let questions = self.questions.clone();
            let subscription = self.questions.0.bus.on(WORKER_REMOVED, move |event| {
                if let Ok(removed) = event.payload_as::<WorkerRemoved>() {
                    questions.cancel_worker(&removed.worker_id);
                }
            });
            *self.listening.lock().unwrap_or_else(PoisonError::into_inner) = Some(subscription);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.listening.lock().unwrap_or_else(PoisonError::into_inner).take();
        })
    }
}
