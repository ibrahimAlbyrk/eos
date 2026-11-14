//! What moving a session between credentials reads and writes: the sign-ins,
//! which of them can run, the rows that tell the story in the transcript.
//!
//! - switched: auto-switch is on and another sign-in is ready. The session
//!   moves to the one with the most room left, `account_switched` is recorded
//!   and the engine sends the refused request again.
//! - exhausted: no other sign-in is ready. `accounts_exhausted` is recorded
//!   (the row offers to resume at the next reset, or on the API key) and the
//!   user is told.
//! - kept: anything else. The turn ends as it did.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::WorkerEventType;
use eos_core::accounts::{
    PlanFailure, PlanLimits, PlanStores, PlanVerdict, SessionAccountSwitch, SessionCredential, StoreLogin,
};
use eos_core::os::LocalTime;
use eos_core::store::{ConfigSource, Store};
use eos_core::{Clock, Error, Sleeper};
use eos_domain::accounts::{LoginReadiness, PlanLimitReason, PlanLoginRecord, PlanLoginRegistry};
use eos_domain::time::{iso_from_ms, ms_from_iso};
use serde_json::{Map, Value, json};

use crate::ledger::PlanLimitLedger;
use crate::logins::PlanLoginService;
use crate::usage::UsageService;

pub(crate) const WORKER_CHANGE: &str = "worker:change";
pub(crate) const NOTIFICATION_FIRE: &str = "notification:fire";
/// The provider whose sign-ins Eos holds several of.
pub const CLAUDE: &str = "anthropic";
/// The provider of the ChatGPT sign-in.
pub const CHATGPT: &str = "openai";
const NO_API_KEY: &str = "No API key is set — add one in Settings › Accounts.";

/// The live sessions' credentials: one entry per running session, removed
/// when the session ends.
#[derive(Default)]
pub(crate) struct LiveSessions(Mutex<HashMap<String, SessionCredential>>);

impl LiveSessions {
    fn map(&self) -> MutexGuard<'_, HashMap<String, SessionCredential>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn set(&self, worker_id: &str, credential: Option<&SessionCredential>) {
        match credential {
            Some(credential) => self.map().insert(worker_id.to_owned(), credential.clone()),
            None => self.map().remove(worker_id),
        };
    }

    pub(crate) fn get(&self, worker_id: &str) -> Option<SessionCredential> {
        self.map().get(worker_id).cloned()
    }

    /// How many sessions run on the store `dir`.
    pub(crate) fn on_store(&self, dir: &str) -> usize {
        let dir = Path::new(dir);
        self.map().values().filter(|c| matches!(c, SessionCredential::Store { dir: d, .. } if d == dir)).count()
    }
}

/// The `account_switched` row: what the divider says. `from` and `to` are
/// labels at the time.
pub(crate) struct SwitchedRow<'a> {
    pub(crate) provider: &'a str,
    pub(crate) from: Option<&'a str>,
    pub(crate) to: &'a str,
    /// `limit`, `expired`, `reset` (a limit lifted) or `api_key` (the user's call).
    pub(crate) reason: &'a str,
    pub(crate) resets_at: Option<i64>,
}

impl SwitchedRow<'_> {
    fn payload(&self) -> Value {
        let mut row = Map::new();
        row.insert("provider".into(), self.provider.into());
        if let Some(from) = self.from {
            row.insert("from".into(), from.into());
        }
        row.insert("to".into(), self.to.into());
        row.insert("reason".into(), self.reason.into());
        if let Some(at) = self.resets_at {
            row.insert("resetsAt".into(), iso_from_ms(at).into());
        }
        Value::Object(row)
    }
}

pub(crate) struct Plan {
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) logins: Arc<PlanLoginService>,
    pub(crate) ledger: Arc<PlanLimitLedger>,
    pub(crate) stores: Arc<dyn PlanStores>,
    pub(crate) usage: Arc<UsageService>,
    /// The engine's side of a move; replaced once the engine is built (it needs the accounts first).
    pub(crate) sessions: Mutex<Arc<dyn SessionAccountSwitch>>,
    pub(crate) local_time: Arc<dyn LocalTime>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) live: LiveSessions,
    /// The plan-limit state of the latest ChatGPT response.
    pub(crate) chatgpt_limits: Mutex<Option<(PlanLimits, i64)>>,
}

fn store_credential(provider: &str, dir: &str) -> SessionCredential {
    SessionCredential::Store { provider: provider.to_owned(), dir: dir.into() }
}

impl Plan {
    /// What each of the provider's stores holds right now.
    pub(crate) async fn reads(&self, registry: &PlanLoginRegistry, provider: &str) -> HashMap<String, StoreLogin> {
        let mut reads = HashMap::new();
        for login in registry.logins_of(provider) {
            reads.insert(login.id.clone(), self.stores.read(provider, &login.store_dir).await);
        }
        reads
    }

    pub(crate) fn readiness(&self, reads: &HashMap<String, StoreLogin>, login: &PlanLoginRecord) -> LoginReadiness {
        self.ledger.readiness(&login.id, reads.get(&login.id).is_some_and(|r| r.present))
    }

    /// The provider's API key, when one is set.
    pub(crate) fn api_key(&self, provider: &str) -> Option<String> {
        let config = self.config.current();
        let key = if provider == CLAUDE { config.anthropic.api_key.clone() } else { None };
        key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty())
    }

    /// How much of its five-hour window a sign-in has used (0–100), from the
    /// last snapshot; a window whose reset has passed has rolled over.
    fn used(&self, snapshots: &[eos_contracts::ProviderUsage], login: &PlanLoginRecord) -> Option<f64> {
        let snapshot = snapshots.iter().find(|u| u.login_id.as_deref() == Some(login.id.as_str()))?;
        let window = snapshot.windows.five_hour.clone()??;
        let rolled = window.resets_at.as_deref().and_then(ms_from_iso).is_some_and(|at| at <= self.clock.now_ms());
        Some(if rolled { 0.0 } else { window.utilization.as_f64() })
    }

    /// The credential a new session of `provider` starts on.
    pub(crate) async fn for_new_session(&self, provider: &str) -> Option<SessionCredential> {
        if provider == CHATGPT {
            let dir = self.logins.single_store(CHATGPT);
            return self.stores.read(CHATGPT, &dir).await.present.then(|| store_credential(CHATGPT, &dir));
        }
        let registry = self.logins.registry();
        let reads = self.reads(&registry, provider).await;
        if let Some(login) = registry.runnable_login(provider, |l| self.readiness(&reads, l)) {
            return Some(store_credential(provider, &login.store_dir));
        }
        // Sign-ins that all stopped working block: no silent fallback to the key.
        if registry.logins_of(provider).next().is_some() {
            return None;
        }
        let legacy = (provider == CLAUDE).then(|| self.config.current().anthropic.auth_token.clone()).flatten();
        if let Some(token) = legacy.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
            return Some(SessionCredential::Bearer { provider: provider.to_owned(), token });
        }
        self.api_key(provider).map(|key| SessionCredential::ApiKey { provider: provider.to_owned(), key })
    }

    /// A request of `worker_id` was refused because its credential stopped working.
    pub(crate) async fn failed(&self, worker_id: &str, failure: &PlanFailure) -> PlanVerdict {
        let Some(SessionCredential::Store { provider, dir }) = self.live.get(worker_id) else {
            return PlanVerdict::Keep;
        };
        let registry = self.logins.registry();
        let Some(from) = registry.logins_of(&provider).find(|l| Path::new(&l.store_dir) == dir) else {
            return PlanVerdict::Keep;
        };
        let (reason, resets_at) = match failure {
            PlanFailure::LimitReached(limits) => (PlanLimitReason::Limit, limits.resets_at_ms),
            PlanFailure::Expired(_) => (PlanLimitReason::Expired, None),
        };
        self.ledger.mark(&from.id, reason, resets_at);

        let reads = self.reads(&registry, &provider).await;
        let snapshots = self.usage.peek();
        let target = registry.switch_target(
            &provider,
            |l| l.id != from.id && self.readiness(&reads, l) == LoginReadiness::Ready,
            |l| self.used(&snapshots, l),
        );
        let Some(to) = target else {
            if let Err(e) = self.record_exhausted(worker_id, &provider, &registry, &reads).await {
                tracing::warn!(worker_id, error = %e, "the exhausted-accounts row could not be written");
            }
            return PlanVerdict::Exhausted;
        };
        if !registry.auto_switch(&provider) {
            return PlanVerdict::Keep;
        }
        let credential = store_credential(&provider, &to.store_dir);
        let row = SwitchedRow {
            provider: &provider,
            from: Some(&from.label),
            to: &to.label,
            reason: reason.as_str(),
            resets_at: resets_at.filter(|_| reason == PlanLimitReason::Limit),
        };
        if let Err(e) = self.record_switch(worker_id, &row).await {
            tracing::warn!(worker_id, error = %e, "the account-switched row could not be written");
        }
        self.live.set(worker_id, Some(&credential));
        tracing::info!(worker_id, to = %to.label, reason = reason.as_str(), "session moved to another credential");
        PlanVerdict::Switch(credential)
    }

    async fn record_switch(&self, worker_id: &str, row: &SwitchedRow<'_>) -> Result<(), Error> {
        let (worker, payload, now) = (worker_id.to_owned(), row.payload(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                let row_id = tx.events().append_json(&worker, now, WorkerEventType::AccountSwitched, &payload)?;
                out.push(WORKER_CHANGE, &json!({ "workerId": worker, "rowId": row_id }));
                Ok(())
            })
            .await
    }

    /// The earliest a limited sign-in comes back; none when every one is out.
    fn next_reset(
        &self,
        registry: &PlanLoginRegistry,
        provider: &str,
        reads: &HashMap<String, StoreLogin>,
    ) -> Option<i64> {
        registry
            .logins_of(provider)
            .filter(|l| reads.get(&l.id).is_some_and(|r| r.present))
            .filter_map(|l| self.ledger.blocked(&l.id))
            .filter(|mark| mark.reason == PlanLimitReason::Limit)
            .filter_map(|mark| mark.until)
            .min()
    }

    async fn record_exhausted(
        &self,
        worker_id: &str,
        provider: &str,
        registry: &PlanLoginRegistry,
        reads: &HashMap<String, StoreLogin>,
    ) -> Result<(), Error> {
        let next = self.next_reset(registry, provider, reads);
        let mut payload = Map::new();
        payload.insert("provider".into(), provider.into());
        if let Some(next) = next {
            payload.insert("nextResetAt".into(), iso_from_ms(next).into());
        }
        payload.insert("apiKey".into(), self.api_key(provider).is_some().into());
        let stopped = match next {
            Some(next) => format!("the next limit resets at {}.", self.local_time.hour_minute(next)),
            None => "sign in again to continue.".to_owned(),
        };
        let (worker, now) = (worker_id.to_owned(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                let name = tx.workers().find(&worker)?.and_then(|w| w.name).unwrap_or_else(|| "An agent".to_owned());
                let row_id = tx.events().append_json(&worker, now, WorkerEventType::AccountsExhausted, &payload)?;
                out.push(WORKER_CHANGE, &json!({ "workerId": worker, "rowId": row_id }));
                out.push(
                    NOTIFICATION_FIRE,
                    &json!({
                        "title": "Claude accounts are out",
                        "body": format!("{name} stopped — {stopped}"),
                        "workerId": worker,
                        "ts": now,
                    }),
                );
                Ok(())
            })
            .await
    }

    /// The one way a live session changes credential on the user's or a
    /// timer's call: on the API key, and when a limit lifts.
    pub(crate) async fn move_session(
        &self,
        worker_id: &str,
        credential: SessionCredential,
        row: SwitchedRow<'_>,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Err(reason) = sessions.move_session(worker_id, credential.clone()).await {
            tracing::warn!(worker_id, to = row.to, error = %reason, "account switch failed");
            return Err(reason);
        }
        self.live.set(worker_id, Some(&credential));
        if let Err(e) = self.record_switch(worker_id, &row).await {
            tracing::warn!(worker_id, error = %e, "the account-switched row could not be written");
        }
        tracing::info!(worker_id, to = row.to, reason = row.reason, "session moved to another credential");
        Ok(())
    }

    /// On the `accounts_exhausted` row the user chose to go on billing this
    /// session per token. Never automatic.
    pub(crate) async fn continue_on_api_key(&self, worker_id: &str, provider: &str) -> Result<(), String> {
        let key = self.api_key(provider).ok_or_else(|| NO_API_KEY.to_owned())?;
        let credential = SessionCredential::ApiKey { provider: provider.to_owned(), key };
        let row = SwitchedRow { provider, from: None, to: "API key", reason: "api_key", resets_at: None };
        self.move_session(worker_id, credential, row).await
    }
}
