//! The permission gateway: decides every tool call, parks the ones the user must
//! answer, and keeps the trail.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use eos_contracts::stream::topics;
use eos_contracts::{
    AllowVariant, Decision, DenyVariant, ExternalDecision, PolicyBehavior, UnknownRecord, WorkerEventType,
};
use eos_core::policy::{DecisionCounter, DecisionCounts, PolicyDecider, PolicyFile, ToolCall};
use eos_core::store::{NewPending, Store};
use eos_core::{BoxFuture, Clock, Error, Ids};
use serde_json::json;
use tokio::sync::oneshot;

use crate::ask::approval_notification;
use crate::evaluate::{Call, evaluate};
use crate::js;
use crate::load::{behavior_name, load_policy, with_tool_rule};
use crate::mode::worker_permissions;
use crate::rule::Policy;

/// An ask with no `ttlMs` is stamped a day ahead.
const DEFAULT_ASK_LIFETIME_MS: i64 = 86_400_000;

/// What the gateway is built from.
pub struct GatewayOptions {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub file: Arc<dyn PolicyFile>,
    /// Stands in for a policy without `ttlMs`; 0 is "a day".
    pub default_ttl_ms: i64,
    /// The plans folder (`~/.claude/plans`): edits inside it pass in every mode.
    pub plans_dir: Option<String>,
}

impl std::fmt::Debug for GatewayOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayOptions").field("default_ttl_ms", &self.default_ttl_ms).finish_non_exhaustive()
    }
}

/// The user's answer to an ask.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// Run it, with this input when given, else with the input asked about.
    Allow {
        updated_input: Option<UnknownRecord>,
    },
    Deny {
        reason: Option<String>,
    },
}

/// A parked call: who waits, and how to release it.
struct Waiter {
    worker_id: String,
    release: oneshot::Sender<ExternalDecision>,
}

/// The calls waiting for the user, by pending id. One entry per blocked tool
/// call of a live session; an entry goes when the ask is answered, when its
/// worker ends, or when its caller stops waiting.
type Waiters = Arc<Mutex<HashMap<String, Waiter>>>;

fn lock(waiters: &Waiters) -> MutexGuard<'_, HashMap<String, Waiter>> {
    waiters.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Forgets the waiter when the call that parked it goes away.
struct Parked {
    id: String,
    waiters: Waiters,
}

impl Drop for Parked {
    fn drop(&mut self) {
        lock(&self.waiters).remove(&self.id);
    }
}

fn denied(message: impl Into<String>) -> ExternalDecision {
    ExternalDecision::Deny(DenyVariant { message: message.into() })
}

pub struct PolicyGateway {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    file: Arc<dyn PolicyFile>,
    default_ttl_ms: i64,
    plans_dir: Option<String>,
    policy: RwLock<Arc<Policy>>,
    waiters: Waiters,
    /// One writer of the user's policy file at a time.
    saving: Mutex<()>,
    allowed: AtomicU64,
    denied: AtomicU64,
    asked: AtomicU64,
}

impl std::fmt::Debug for PolicyGateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolicyGateway").field("waiting", &lock(&self.waiters).len()).finish_non_exhaustive()
    }
}

impl PolicyGateway {
    /// Reads the policy file once; [`reload`](Self::reload) reads it again.
    pub fn new(options: GatewayOptions) -> Self {
        let policy = load_policy(options.file.load(), options.default_ttl_ms);
        Self {
            store: options.store,
            clock: options.clock,
            ids: options.ids,
            file: options.file,
            default_ttl_ms: options.default_ttl_ms,
            plans_dir: options.plans_dir,
            policy: RwLock::new(Arc::new(policy)),
            waiters: Waiters::default(),
            saving: Mutex::new(()),
            allowed: AtomicU64::new(0),
            denied: AtomicU64::new(0),
            asked: AtomicU64::new(0),
        }
    }

    /// The policy in force.
    pub fn policy(&self) -> Arc<Policy> {
        self.policy.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Reads the policy file again; calls decided from now on see it.
    pub fn reload(&self) {
        let policy = Arc::new(load_policy(self.file.load(), self.default_ttl_ms));
        *self.policy.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = policy;
    }

    /// Decides a call. An allow or a deny answers at once; an ask is stored,
    /// announced (`notification:fire` "Approval needed", then
    /// `pending:created`) and waits until [`resolve`](Self::resolve) answers
    /// it or the worker ends. Every decision is logged on the worker
    /// (`policy`) and announced (`policy:decision`).
    pub async fn decide(&self, call: ToolCall) -> Result<ExternalDecision, Error> {
        let policy = self.policy();
        let worker_id = call.worker_id.clone();
        let permissions = self.store.read(move |tx| worker_permissions(tx.workers(), &worker_id)).await?;
        let decision = evaluate(
            &policy,
            &Call {
                tool_name: &call.tool_name,
                input: &call.input,
                agent_id: call.agent_id.as_deref(),
                full_surface: call.full_surface,
                mode: permissions.mode,
                scope: permissions.scope.as_ref(),
                plans_dir: self.plans_dir.as_deref(),
            },
        );
        let now = self.clock.now_ms();
        let (behavior, counter, parked) = match &decision {
            Decision::Allow(_) => ("allow", &self.allowed, None),
            Decision::Deny(_) => ("deny", &self.denied, None),
            Decision::Ask => {
                let id = self.ids.pending_id();
                let (release, answer) = oneshot::channel();
                // Parked before the row exists, so an answer cannot miss it.
                lock(&self.waiters).insert(id.clone(), Waiter { worker_id: call.worker_id.clone(), release });
                let parked = Parked { id: id.clone(), waiters: self.waiters.clone() };
                let lifetime = if policy.ttl_ms == 0 { DEFAULT_ASK_LIFETIME_MS } else { policy.ttl_ms };
                let pending = NewPending {
                    id,
                    worker_id: call.worker_id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: js::json_stringify_record(&call.input),
                    tool_use_id: call.tool_use_id.clone(),
                    created_at: now,
                    expires_at: now.saturating_add(lifetime),
                };
                ("ask", &self.asked, Some((pending, parked, answer)))
            }
        };
        counter.fetch_add(1, Ordering::Relaxed);

        let (worker_id, tool) = (call.worker_id, call.tool_name);
        let pending = parked.as_ref().map(|(pending, ..)| pending.clone());
        self.store
            .write(move |tx, out| {
                tx.events().append_json(
                    &worker_id,
                    now,
                    WorkerEventType::Policy,
                    &json!({ "tool": tool, "decision": behavior }),
                )?;
                out.push(
                    topics::POLICY_DECISION,
                    &json!({ "workerId": worker_id, "tool": tool, "behavior": behavior }),
                );
                if let Some(pending) = pending {
                    tx.pending().insert(&pending)?;
                    tx.events().append_json(
                        &worker_id,
                        now,
                        WorkerEventType::PermissionPending,
                        &json!({ "id": pending.id, "tool": tool }),
                    )?;
                    // The banner goes out ahead of `pending:created`, as today.
                    let name = tx.workers().find(&worker_id)?.and_then(|worker| worker.name);
                    let banner = approval_notification(&worker_id, &tool, &pending.input, name.as_deref(), now);
                    out.push(topics::NOTIFICATION_FIRE, &banner);
                    out.push(topics::PENDING_CREATED, &json!({ "id": pending.id, "workerId": worker_id }));
                }
                Ok(())
            })
            .await?;

        match (decision, parked) {
            (Decision::Allow(allow), _) => Ok(ExternalDecision::Allow(allow)),
            (Decision::Deny(deny), _) => Ok(ExternalDecision::Deny(deny)),
            (Decision::Ask, Some((_, _parked, answer))) => {
                Ok(answer.await.unwrap_or_else(|_| denied("worker exited before permission was resolved")))
            }
            (Decision::Ask, None) => Err(Error::Storage("an ask was not parked".into())),
        }
    }

    /// Answers an open ask: saves the answer, announces `pending:resolved`
    /// and releases the call that waits. Fails with `NotFound` for an unknown
    /// id and `Conflict` for an ask that was answered already.
    pub async fn resolve(&self, id: &str, answer: Answer) -> Result<(), Error> {
        let pending_id = id.to_owned();
        let decision = self
            .store
            .write(move |tx, out| {
                let id = pending_id;
                let row = tx.pending().find(&id)?.ok_or_else(|| Error::not_found("pending", &id))?;
                if row.resolved {
                    let was = row.decision.as_deref().unwrap_or("null");
                    return Err(Error::Conflict(format!("already resolved: {was}")));
                }
                let (decision, applied) = match answer {
                    Answer::Allow { updated_input } => {
                        let input = match updated_input {
                            Some(input) => input,
                            None => serde_json::from_str::<UnknownRecord>(&row.input)
                                .map_err(|_| Error::Validation("pending permission input is not valid JSON".into()))?,
                        };
                        let text = js::json_stringify_record(&input);
                        let applied = tx.pending().resolve(&id, "allow", None, Some(&text))?;
                        (ExternalDecision::Allow(AllowVariant { updated_input: Some(input), message: None }), applied)
                    }
                    Answer::Deny { reason } => {
                        let message = reason.unwrap_or_else(|| "denied by human".to_owned());
                        let applied = tx.pending().resolve(&id, "deny", Some(&message), None)?;
                        (denied(message), applied)
                    }
                };
                if !applied {
                    return Err(Error::Conflict("expired or already resolved".into()));
                }
                let behavior = match &decision {
                    ExternalDecision::Allow(_) => "allow",
                    ExternalDecision::Deny(_) => "deny",
                };
                out.push(topics::PENDING_RESOLVED, &json!({ "id": id, "behavior": behavior }));
                Ok(decision)
            })
            .await?;
        if let Some(waiter) = lock(&self.waiters).remove(id) {
            // The caller may have stopped waiting; the answer is saved either way.
            let _ = waiter.release.send(decision);
        }
        Ok(())
    }

    /// A worker ended or was removed: its waiting calls are denied, and asks
    /// past their time are closed.
    pub async fn worker_gone(&self, worker_id: &str) -> Result<usize, Error> {
        let released: Vec<Waiter> = {
            let mut waiters = lock(&self.waiters);
            let ids: Vec<String> =
                waiters.iter().filter(|(_, w)| w.worker_id == worker_id).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| waiters.remove(id)).collect()
        };
        for waiter in released {
            let _ = waiter.release.send(denied("worker exited before permission was resolved"));
        }
        self.sweep_expired("expired (swept on worker exit)").await
    }

    /// Closes, as denied with `reason`, every open ask past its `expires_at`
    /// that nobody waits on; answers how many. An ask whose call still waits
    /// stays open: it never times out under its caller.
    pub async fn sweep_expired(&self, reason: &'static str) -> Result<usize, Error> {
        let now = self.clock.now_ms();
        let waiters = self.waiters.clone();
        self.store
            .write(move |tx, _| {
                let waiting = lock(&waiters);
                let stale: Vec<String> = tx
                    .pending()
                    .list_unresolved()?
                    .into_iter()
                    .filter(|ask| ask.expires_at < now && !waiting.contains_key(&ask.id))
                    .map(|ask| ask.id)
                    .collect();
                drop(waiting);
                for id in &stale {
                    tx.pending().resolve(id, "deny", Some(reason), None)?;
                }
                Ok(stale.len())
            })
            .await
    }

    /// Adds a rule for `tool` to the user's policy file and reloads it.
    /// Answers `false` when a rule naming that tool was there already.
    pub fn save_rule(&self, tool: &str, action: PolicyBehavior) -> Result<bool, Error> {
        let _one_writer = self.saving.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let existing = self.file.read_user()?;
        let Some(next) = with_tool_rule(existing.as_ref(), tool, action) else { return Ok(false) };
        self.file.write_user(&next)?;
        self.reload();
        tracing::info!(tool, action = behavior_name(action), "policy rule saved");
        Ok(true)
    }

    /// How many calls wait for the user right now.
    pub fn waiting(&self) -> usize {
        lock(&self.waiters).len()
    }
}

/// A view a subagent presents lands inside its collapsed run, where the user
/// never sees it.
fn is_view_tool(tool_name: &str) -> bool {
    ["mcp__orchestrator__", "mcp__worker__"]
        .iter()
        .filter_map(|server| tool_name.strip_prefix(server))
        .any(|tool| tool == "present" || tool == "present_app")
}

impl PolicyDecider for PolicyGateway {
    fn decide(&self, call: ToolCall) -> BoxFuture<'_, Result<ExternalDecision, Error>> {
        Box::pin(async move {
            if call.agent_id.as_deref().is_some_and(|id| !id.is_empty()) && is_view_tool(&call.tool_name) {
                return Ok(denied(format!(
                    "{} is main-agent only — return your findings; the main agent presents them.",
                    call.tool_name
                )));
            }
            PolicyGateway::decide(self, call).await
        })
    }
}

impl DecisionCounter for PolicyGateway {
    fn decision_counts(&self) -> DecisionCounts {
        DecisionCounts {
            allow: self.allowed.load(Ordering::Relaxed),
            deny: self.denied.load(Ordering::Relaxed),
            ask: self.asked.load(Ordering::Relaxed),
        }
    }
}
