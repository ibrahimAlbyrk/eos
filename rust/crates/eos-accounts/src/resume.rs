//! "Resume at 16:40" on an `accounts_exhausted` row: one timer per agent, in
//! memory (a restart drops it). When it fires and the agent is still idle
//! with nothing sent since the row, the session moves to the sign-in that
//! came back and the turn picks up. The schedule rides the row's payload
//! (`resumeAt`, then `resumed`), so every window shows it
//! (`manager/services/PlanResumeService.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::accounts::SessionCredential;
use eos_core::store::{EventOrder, EventQuery};
use eos_domain::accounts::LoginReadiness;
use eos_domain::time::ms_from_iso;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::plan::{Plan, SwitchedRow, WORKER_CHANGE};

/// The limit's own reset can land a little after the time it named.
const SLACK_MS: i64 = 30_000;
/// What a resume looks back over for a message sent since the row.
const LOOKBACK_ROWS: i64 = 500;

type Payload = Map<String, Value>;

struct Timer {
    row_id: i64,
    task: JoinHandle<()>,
}

/// At most one timer per worker; it goes when it fires, when it is cancelled
/// and when another is scheduled for the same worker.
pub struct PlanResumeService {
    plan: Arc<Plan>,
    timers: Mutex<HashMap<String, Timer>>,
}

impl std::fmt::Debug for PlanResumeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanResumeService").finish_non_exhaustive()
    }
}

fn text<'a>(payload: &'a Payload, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl PlanResumeService {
    pub(crate) fn new(plan: Arc<Plan>) -> Self {
        Self { plan, timers: Mutex::default() }
    }

    fn timers(&self) -> MutexGuard<'_, HashMap<String, Timer>> {
        self.timers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `Err`: why the row cannot be resumed, in the dashboard's words.
    pub async fn schedule(self: &Arc<Self>, worker_id: &str, row_id: i64) -> Result<(), String> {
        let payload = self.exhausted(worker_id, row_id).await.ok_or("not an exhausted-accounts row")?;
        let next =
            text(&payload, "nextResetAt").ok_or("no limit reset to wait for — sign in again instead")?.to_owned();
        self.clear(worker_id);
        let wait = ms_from_iso(&next).map_or(0, |at| (at - self.plan.clock.now_ms()).max(0)) + SLACK_MS;
        let (this, worker) = (self.clone(), worker_id.to_owned());
        let waited = self.plan.sleeper.sleep(wait);
        let task = tokio::spawn(async move {
            waited.await;
            this.fire(&worker, row_id).await;
        });
        self.timers().insert(worker_id.to_owned(), Timer { row_id, task });
        let mut scheduled = payload;
        scheduled.insert("resumeAt".into(), next.into());
        self.patch(worker_id, row_id, scheduled).await.map_err(|e| e.to_string())
    }

    pub async fn cancel(&self, worker_id: &str, row_id: i64) {
        let row = self.exhausted(worker_id, row_id).await;
        if self.timers().get(worker_id).is_some_and(|t| t.row_id == row_id) {
            self.clear(worker_id);
        }
        if let Some(mut payload) = row
            && payload.shift_remove("resumeAt").is_some()
        {
            self.patched(worker_id, row_id, payload).await;
        }
    }

    async fn fire(&self, worker_id: &str, row_id: i64) {
        {
            let mut timers = self.timers();
            if timers.get(worker_id).is_some_and(|t| t.row_id == row_id) {
                timers.remove(worker_id);
            }
        }
        let Some(mut rest) = self.exhausted(worker_id, row_id).await else { return };
        rest.shift_remove("resumeAt");
        let provider = text(&rest, "provider").unwrap_or_default().to_owned();

        let worker = worker_id.to_owned();
        let seen = self
            .plan
            .store
            .read(move |tx| {
                let state = tx.workers().find(&worker)?.map(|w| w.state);
                let since = tx.events().list(&EventQuery {
                    worker_id: worker.clone(),
                    since: 0,
                    limit: LOOKBACK_ROWS,
                    order: EventOrder::Asc,
                    before_id: None,
                    after_id: Some(row_id),
                })?;
                let user_message = serde_json::to_value(WorkerEventType::UserMessage).ok();
                let sent = since.iter().any(|e| user_message.as_ref().and_then(Value::as_str) == Some(e.kind.as_str()));
                Ok((state, sent))
            })
            .await;
        let (state, sent_since) = seen.unwrap_or((None, true));

        let registry = self.plan.logins.registry();
        let reads = self.plan.reads(&registry, &provider).await;
        let login = registry.session_login(&provider, |l| self.plan.readiness(&reads, l) == LoginReadiness::Ready);
        let Some(login) = login.filter(|_| state == Some(WorkerState::Idle) && !sent_since) else {
            tracing::info!(worker_id, ?state, sent_since, ready = login.is_some(), "plan resume skipped");
            return self.patched(worker_id, row_id, rest).await;
        };
        let credential = SessionCredential::Store { provider: provider.clone(), dir: login.store_dir.clone().into() };
        let row = SwitchedRow { provider: &provider, from: None, to: &login.label, reason: "reset", resets_at: None };
        if self.plan.move_session(worker_id, credential, row).await.is_ok() {
            rest.insert("resumed".into(), true.into());
        }
        self.patched(worker_id, row_id, rest).await;
    }

    /// The row's payload, when it is an `accounts_exhausted` row of that worker.
    async fn exhausted(&self, worker_id: &str, row_id: i64) -> Option<Payload> {
        let worker = worker_id.to_owned();
        let row = self.plan.store.read(move |tx| tx.events().find(&worker, row_id)).await.ok()??;
        let kind = serde_json::to_value(WorkerEventType::AccountsExhausted).ok()?;
        if kind.as_str() != Some(row.kind.as_str()) {
            return None;
        }
        match serde_json::from_str(row.payload.as_deref()?) {
            Ok(Value::Object(payload)) => Some(payload),
            _ => None,
        }
    }

    async fn patch(&self, worker_id: &str, row_id: i64, payload: Payload) -> Result<(), Error> {
        let worker = worker_id.to_owned();
        let text = Value::Object(payload).to_string();
        self.plan
            .store
            .write(move |tx, out| {
                tx.events().patch_payload(row_id, &text)?;
                out.push(WORKER_CHANGE, &json!({ "workerId": worker, "rowId": row_id }));
                Ok(())
            })
            .await
    }

    async fn patched(&self, worker_id: &str, row_id: i64, payload: Payload) {
        if let Err(e) = self.patch(worker_id, row_id, payload).await {
            tracing::warn!(worker_id, row_id, error = %e, "the exhausted-accounts row could not be updated");
        }
    }

    fn clear(&self, worker_id: &str) {
        if let Some(timer) = self.timers().remove(worker_id) {
            timer.task.abort();
        }
    }
}
