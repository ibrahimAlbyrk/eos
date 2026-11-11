//! Agents in the app: the engine, the session service, and what joins them
//! to the rest (prompts, the bus, the modules).
//!
//! Stand-ins, each replaced when its owner lands: Eos's own tools
//! ([`NoTools`], until `eos-tools`) and the user's answers to a focused
//! session's questions ([`NoUser`]). Credentials are the accounts feature's;
//! [`FixedCredential`] is for a run that names its own (tests).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};

use eos_contracts::stream::topics::{AGENT_DELTA, PENDING_CREATED};
use eos_contracts::{AgentEvent, DeltaEvent, DeltaEventPhase, SessionFactsRole, UnknownRecord};
use eos_core::BoxFuture;
use eos_core::accounts::{
    PlanFailure, PlanLimits, PlanVerdict, SessionAccountSwitch, SessionCredential, SessionCredentials,
};
use eos_core::agent::{HostTool, LaunchSpec, PromptAssembler, SpawnFacts, ToolInputDelta, ToolSets, UserQuestions};
use eos_core::prompt::ProfileRenderer;
use eos_core::store::Store;
use eos_domain::{ProviderIdentity, Worker};
use eos_engine::{EngineDeps, EngineOptions, LazyEngine};
use eos_policy::ask::parent_nudge;
use eos_prompts::PromptService;
use eos_prompts::spawn::{SpawnPrompt, system_prompt_for};
use eos_runtime::Runtime;
use eos_runtime::bus::{Bus, Scope, Subscription};
use eos_runtime::module::PromptValue;
use eos_sessions::{MessageInput, SessionHooks, Sessions};
use eos_workers::WorkerDefinitions;
use eos_workers::catalog::render_catalog;
use eos_workers::resolve::resolve_by_name;
use serde_json::{Value, json};
use tokio::runtime::Handle;

/// How agents reach the model and Claude Code's files. The defaults are the
/// real ones; tests point every field somewhere of their own.
#[derive(Debug, Clone, Default)]
pub struct AgentOptions {
    /// Where the model API is; the provider's own when `None`.
    pub base_url: Option<String>,
    /// The home Claude Code's files are read under; the user's when `None`.
    pub claude_home: Option<PathBuf>,
    /// Leave the MCP servers configured for a folder unconnected.
    pub no_mcp: bool,
    /// The model of a session that names none the engine knows.
    pub default_model: Option<String>,
    /// The credential every new session runs on instead of the accounts
    /// feature's pick (a scripted run); `None` leaves the choice to it.
    pub credential: Option<SessionCredential>,
}

pub(crate) fn engine(dir: &Path, options: &AgentOptions, deps: EngineDeps) -> Arc<LazyEngine> {
    let engine = EngineOptions {
        default_model: options.default_model.clone(),
        base_url: options.base_url.clone(),
        claude_home: options.claude_home.clone(),
        mcp: !options.no_mcp,
        ..EngineOptions::new(dir)
    };
    Arc::new(LazyEngine::new(engine, deps))
}

/// No tool of Eos's own yet.
pub(crate) struct NoTools;

impl ToolSets for NoTools {
    fn for_session(&self, _spec: &LaunchSpec) -> Vec<Arc<dyn HostTool>> {
        Vec::new()
    }
}

/// No session is live until the engine is attached to the accounts feature:
/// "Resume at" and "Use API key" answer as they do for an agent whose
/// session is gone.
pub(crate) struct NoLiveSessions;

impl SessionAccountSwitch for NoLiveSessions {
    fn move_session<'a>(
        &'a self,
        _worker_id: &'a str,
        _credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("this agent can't change account right now".to_owned()) })
    }
}

/// One credential for every session, never replaced.
pub(crate) struct FixedCredential(pub(crate) Option<SessionCredential>);

impl SessionCredentials for FixedCredential {
    fn for_new_session<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<SessionCredential>> {
        Box::pin(std::future::ready(self.0.clone()))
    }

    fn launched(&self, _worker_id: &str, _credential: Option<&SessionCredential>) {}

    fn observed(&self, _credential: &SessionCredential, _limits: &PlanLimits) {}

    fn failed<'a>(&'a self, _worker_id: &'a str, _failure: &'a PlanFailure) -> BoxFuture<'a, PlanVerdict> {
        Box::pin(std::future::ready(PlanVerdict::Keep))
    }
}

/// Nobody answers yet: the question is turned away and the agent goes on.
pub(crate) struct NoUser;

impl UserQuestions for NoUser {
    fn ask<'a>(
        &'a self,
        _worker_id: &'a str,
        _call_id: Option<&'a str>,
        _questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        Box::pin(std::future::ready(None))
    }
}

/// A session's system prompt, from the prompt library (`assembleAppendText`
/// in `manager/container.ts`).
pub(crate) struct AppPrompts {
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) profile: Arc<dyn ProfileRenderer>,
    pub(crate) definitions: Arc<WorkerDefinitions>,
    pub(crate) hooks: Arc<AppHooks>,
}

fn role_name(role: SessionFactsRole) -> Option<&'static str> {
    match role {
        SessionFactsRole::Git => Some("git"),
        SessionFactsRole::Focused => Some("focused"),
        SessionFactsRole::Orchestrator | SessionFactsRole::Worker => None,
    }
}

impl PromptAssembler for AppPrompts {
    fn system_prompt(&self, facts: &SpawnFacts) -> Option<String> {
        let folder = facts.worktree_from.as_deref().or(facts.cwd.as_deref());
        // The definitions on disk for the session's folder: its own type's
        // instructions, and for an orchestrator the list it may spawn from.
        let records = self.definitions.on_disk(folder.map(Path::new));
        let definition = facts.worker_definition.as_deref().and_then(|name| resolve_by_name(name, &records));
        let catalog = render_catalog(&records);
        let identity = ProviderIdentity::claude();
        let project = facts.cwd.as_deref().or(facts.worktree_dir.as_deref()).or(facts.worktree_from.as_deref());
        let mut variables = serde_json::Map::new();
        for (name, value) in self.hooks.prompt_variables() {
            let value = match value {
                PromptValue::Text(text) => Value::String(text),
                PromptValue::Flag(on) => Value::Bool(on),
            };
            variables.insert(name.to_owned(), value);
        }
        let spawn = SpawnPrompt {
            id: &facts.worker_id,
            is_orchestrator: facts.role == SessionFactsRole::Orchestrator,
            role: role_name(facts.role),
            parent_id: facts.parent_id.as_deref(),
            name: facts.name.as_deref(),
            model: Some(&facts.model),
            effort: facts.effort.as_deref(),
            permission_mode: facts.permission_mode.as_deref(),
            cwd: facts.cwd.as_deref(),
            worktree_dir: facts.worktree_dir.as_deref(),
            worktree_from: facts.worktree_from.as_deref(),
            branch: facts.branch.as_deref(),
            attached: facts.attached,
            collaborate: facts.collaborate,
            worker_definition: facts.worker_definition.as_deref(),
            worker_definition_body: definition.as_ref().map(|d| d.body.as_str()),
            worker_catalog: &catalog,
            identity: &identity,
            profile: self.profile.render("claude", project, None),
            variables,
            disabled_plugins: &[],
        };
        system_prompt_for(&self.prompts, &spawn)
    }
}

/// Open live blocks whose offsets are remembered, at most.
const MAX_OPEN_BLOCKS: usize = 512;

/// Where each piece of live text starts in its block, so a client that gets
/// merged pieces places text exactly (`manager/shared/delta-offsets.ts`).
/// Offsets count UTF-16 units, as the dashboard's strings do.
#[derive(Default)]
struct DeltaOffsets {
    lengths: HashMap<(String, String), u64>,
    order: VecDeque<(String, String)>,
}

impl DeltaOffsets {
    fn next(&mut self, worker_id: &str, delta: &DeltaEvent) -> u64 {
        let key = (worker_id.to_owned(), delta.block_id.clone());
        let at = if delta.phase == DeltaEventPhase::Start { 0 } else { self.lengths.get(&key).copied().unwrap_or(0) };
        self.lengths.remove(&key);
        self.order.retain(|k| *k != key);
        if delta.phase == DeltaEventPhase::Stop {
            return at;
        }
        self.lengths.insert(key.clone(), at + delta.text.encode_utf16().count() as u64);
        self.order.push_back(key);
        while self.order.len() > MAX_OPEN_BLOCKS {
            if let Some(oldest) = self.order.pop_front() {
                self.lengths.remove(&oldest);
            }
        }
        at
    }
}

/// The running app around sessions. The modules and the idle hooks exist
/// only once the runtime is composed — after the session service, which the
/// modules are built from — so the runtime is attached then.
pub(crate) struct AppHooks {
    bus: Bus,
    offsets: Mutex<DeltaOffsets>,
    runtime: OnceLock<Weak<Runtime>>,
}

impl AppHooks {
    pub(crate) fn new(bus: Bus) -> Self {
        Self { bus, offsets: Mutex::default(), runtime: OnceLock::new() }
    }

    pub(crate) fn attach(&self, runtime: &Arc<Runtime>) {
        let _ = self.runtime.set(Arc::downgrade(runtime));
    }

    fn runtime(&self) -> Option<Arc<Runtime>> {
        self.runtime.get().and_then(Weak::upgrade)
    }

    fn prompt_variables(&self) -> Vec<(&'static str, PromptValue)> {
        self.runtime().map(|r| r.modules.prompt_variables()).unwrap_or_default()
    }
}

impl SessionHooks for AppHooks {
    fn delta(&self, worker_id: &str, delta: &DeltaEvent) {
        let at = self.offsets.lock().unwrap_or_else(PoisonError::into_inner).next(worker_id, delta);
        let payload = json!({
            "workerId": worker_id,
            "channel": delta.channel,
            "phase": delta.phase,
            "blockId": delta.block_id,
            "text": delta.text,
            "at": at,
        });
        self.bus.publish_raw(AGENT_DELTA, Some(Scope::worker(worker_id)), payload.to_string().into());
    }

    fn agent_event(&self, worker_id: &str, event: &AgentEvent) {
        if let Some(runtime) = self.runtime() {
            runtime.modules.on_agent_event(worker_id, event);
        }
    }

    fn holds_worker(&self, worker_id: &str) -> bool {
        self.runtime().is_some_and(|r| r.modules.holds_worker(worker_id))
    }

    fn idle(&self, worker_id: &str) {
        if let Some(runtime) = self.runtime() {
            runtime.idle.run(worker_id);
        }
    }

    fn follows_tool_input(&self, tool: &str) -> bool {
        self.runtime().is_some_and(|r| r.modules.follows_tool_input(tool))
    }

    fn tool_input(&self, worker_id: &str, delta: ToolInputDelta) {
        if let Some(runtime) = self.runtime() {
            runtime.modules.on_tool_input_delta(worker_id, &delta.name, &delta);
        }
    }

    fn removed(&self, worker: &Worker) {
        // A root's subtree is one session to the features (its browser, …).
        if worker.parent_id.is_none()
            && let Some(runtime) = self.runtime()
        {
            runtime.modules.on_session_ended(&worker.id);
        }
    }

    fn folder_exists(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }
}

/// A worker waiting for a permission tells the session that can act on it:
/// its parent gets a queued note, once per ask (`permission-ask-notify.ts`).
pub(crate) fn nudge_parents(bus: &Bus, store: Arc<dyn Store>, sessions: Sessions, tasks: Handle) -> Subscription {
    bus.on(PENDING_CREATED, move |event| {
        let Ok(created) = event.payload_as::<Value>() else { return };
        let Some(id) = created["id"].as_str().map(str::to_owned) else { return };
        let (store, sessions) = (store.clone(), sessions.clone());
        // Off the lane: the note is a database read and a dispatch.
        tasks.spawn(async move {
            let found = store
                .read(move |tx| {
                    let Some(ask) = tx.pending().find(&id)? else { return Ok(None) };
                    let asker = tx.workers().find(&ask.worker_id)?;
                    Ok(asker.and_then(|asker| parent_nudge(&ask, &asker)))
                })
                .await;
            let Ok(Some(nudge)) = found else { return };
            let note = MessageInput {
                worker_id: nudge.parent_id,
                text: nudge.text,
                envelope: serde_json::from_value(nudge.envelope).ok(),
                client_msg_id: Some(nudge.client_msg_id),
                queue_when_busy: true,
                origin: Some("permission-ask".into()),
                ..MessageInput::default()
            };
            if let Err(e) = sessions.dispatch(note).await {
                tracing::debug!(error = %e, "a permission ask could not be passed to the parent");
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::DeltaEventChannel;

    // manager/shared/__tests__/delta-offsets.test.ts
    #[test]
    fn each_piece_of_live_text_knows_where_it_starts() {
        let mut offsets = DeltaOffsets::default();
        let piece = |phase, text: &str| DeltaEvent {
            channel: DeltaEventChannel::Text,
            phase,
            block_id: "b1".into(),
            text: text.into(),
        };
        assert_eq!(offsets.next("w", &piece(DeltaEventPhase::Start, "He")), 0);
        assert_eq!(offsets.next("w", &piece(DeltaEventPhase::Append, "llo 😀")), 2);
        assert_eq!(offsets.next("w", &piece(DeltaEventPhase::Append, "!")), 8, "an emoji is two units");
        assert_eq!(offsets.next("w", &piece(DeltaEventPhase::Stop, "")), 9);
        assert_eq!(offsets.next("w", &piece(DeltaEventPhase::Append, "x")), 0, "a stopped block is forgotten");
        assert_eq!(offsets.next("other", &piece(DeltaEventPhase::Start, "a")), 0);
    }
}
