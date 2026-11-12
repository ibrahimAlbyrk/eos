//! The engine, built once, and the sessions it starts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_agent_compat::ClaudePaths;
use eos_agent_core::{Extensions, TranscriptStore};
use eos_agent_engine::JsonlStore;
use eos_agent_sdk::{AgentOptions, CompleteRequest, Sdk, SystemPromptOverride};
use eos_contracts::tool_scope::disallowed_builtin_tools_for;
use eos_contracts::{
    AgentEvent, CommandItem, SessionEvent, SessionEventPhase, UiBackendDescriptor, UiBackendDescriptorBilling,
    UiBackendDescriptorCatalog, UiBackendDescriptorSessionStore,
};
use eos_core::accounts::{SessionAccountSwitch, SessionCredential, SessionCredentials};
use eos_core::agent::{
    AgentCapabilities, AgentRuntime, AgentSession, BackendAuth, BackendCatalog, BackendDescriptor, CommandCatalog,
    LaunchSpec, ModelSource, OneShot, OneShotAnswer, OneShotError, OneShotRequest, SessionSink, ToolSets,
    UserQuestions,
};
use eos_core::policy::PolicyDecider;
use eos_core::{BoxFuture, Clock, Error};
use tokio::sync::mpsc;

use crate::accounts::{Accounts, Failover, NotSignedIn};
use crate::commands::folder_commands;
use crate::gate::EosGate;
use crate::prompter::Prompter;
use crate::registry::Registry;
use crate::session::{self, Launch, Shared};
use crate::tools::{Adapters, EosSession};
use crate::transcript;

/// The provider every session runs on today.
const PROVIDER: &str = "anthropic";
/// The engine's name for its subagent tool; Eos's tool scope calls it `Task`.
const SUBAGENT_TOOL: &str = "Agent";
/// Waiting subagent and task events per session; a session that falls
/// behind pauses its subagents, as it pauses the agent itself.
const SUBAGENT_EVENTS: usize = 256;
const TASK_EVENTS: usize = 64;

/// Where the engine keeps its files and how it reaches the model.
#[derive(Debug, Clone)]
pub struct EngineOptions {
    /// The engine's folder in the data folder (`~/.eos/engine`): recorded
    /// conversations under `transcripts/` (user data), scratch and task
    /// lists under `data/`, workflow runs under `workflows/` (regenerable).
    pub dir: PathBuf,
    /// The model of a session whose spec names none the engine knows.
    pub default_model: Option<String>,
    /// Where the model API is; the provider's own when `None` (tests point
    /// this at a scripted stand-in).
    pub base_url: Option<String>,
    /// The home Claude Code's files are read under (settings, CLAUDE.md,
    /// MCP servers, old transcripts); the user's own when `None`.
    pub claude_home: Option<PathBuf>,
    /// Connect the MCP servers configured for a session's folder.
    pub mcp: bool,
    /// Plugin folders every session loads (Eos's own skills).
    pub plugin_dirs: Vec<PathBuf>,
}

impl EngineOptions {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            default_model: None,
            base_url: None,
            claude_home: None,
            mcp: true,
            plugin_dirs: Vec::new(),
        }
    }
}

/// What the engine asks of the rest of Eos.
#[derive(Clone)]
pub struct EngineDeps {
    pub policy: Arc<dyn PolicyDecider>,
    pub tools: Arc<dyn ToolSets>,
    pub credentials: Arc<dyn SessionCredentials>,
    pub questions: Arc<dyn UserQuestions>,
    pub clock: Arc<dyn Clock>,
    /// The system's secret store: a Claude sign-in's login is read there.
    pub secrets: Arc<dyn eos_platform::CredentialStore>,
}

impl std::fmt::Debug for EngineDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineDeps").finish_non_exhaustive()
    }
}

/// What a session of the engine can do.
fn capabilities() -> AgentCapabilities {
    AgentCapabilities {
        interrupt: true,
        keystroke: false,
        rewind: true,
        runtime_model_switch: true,
        // Modes are applied per call by the policy, against the worker's
        // mode as it is then: a change holds for the very next tool call.
        runtime_permission_switch: true,
        reports_message_events: None,
        streaming_thinking: Some(true),
        resumable: Some(true),
        account_switch: Some(true),
        context_clear: Some(true),
        context_compaction: Some(true),
        expands_slash_templates: Some(true),
        side_question: Some(true),
    }
}

fn descriptor() -> BackendDescriptor {
    BackendDescriptor {
        kind: "claude".into(),
        label: "Claude".into(),
        billing: UiBackendDescriptorBilling::Subscription,
        model_source: ModelSource::Request,
        capabilities: capabilities(),
        catalog: Some(UiBackendDescriptorCatalog::Claude),
        auth: BackendAuth::Subscription,
        enabled: true,
        session_store: UiBackendDescriptorSessionStore::ClaudeTranscript,
        wire_dialect: None,
    }
}

struct Inner {
    sdk: Sdk,
    store: JsonlStore,
    claude: Option<ClaudePaths>,
    options: EngineOptions,
    descriptor: BackendDescriptor,
    tools: Arc<dyn ToolSets>,
    adapters: Adapters,
    shared: Arc<Shared>,
}

/// Agent sessions on `eos-agent-sdk`. Cheap to clone.
#[derive(Clone)]
pub struct Engine(Arc<Inner>);

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").field("live", &self.live()).finish_non_exhaustive()
    }
}

fn engine_error(error: impl std::fmt::Display) -> Error {
    Error::Rule(format!("the agent could not start: {error}"))
}

impl Engine {
    /// Builds what every session shares: one HTTP client, the tools, the
    /// prompts, the MCP hub, the transcript store. Reads no credential.
    pub async fn build(options: EngineOptions, deps: EngineDeps) -> Result<Self, Error> {
        let EngineDeps { policy, tools, credentials, questions, clock, secrets } = deps;
        let sessions = Arc::new(Registry::default());
        let accounts = Arc::new(Accounts::new(secrets));
        let store = JsonlStore::new(options.dir.join("transcripts"));
        let claude = options.claude_home.as_deref().map(ClaudePaths::for_home);
        let failover =
            Failover { credentials: credentials.clone(), accounts: accounts.clone(), sessions: sessions.clone() };
        let mut builder = Sdk::builder()
            // A session brings its own credential; one without any is told so.
            .auth(Arc::new(NotSignedIn))
            .artifacts(false)
            .auth_failover(Arc::new(failover))
            .permissions(Arc::new(EosGate { policy, sessions: sessions.clone() }))
            .prompter(Arc::new(Prompter { questions, sessions: sessions.clone() }))
            .store(Arc::new(store.clone()) as Arc<dyn TranscriptStore>)
            .data_dir(options.dir.join("data"))
            .workflow_dir(options.dir.join("workflows"));
        if let Some(model) = &options.default_model {
            builder = builder.model(model.clone());
        }
        if let Some(url) = &options.base_url {
            builder = builder.base_url(url.clone());
        }
        if let Some(paths) = &claude {
            builder = builder.claude_paths(paths.clone());
        }
        let sdk = builder.build().await.map_err(engine_error)?;
        let paths = store.clone();
        let shared = Arc::new(Shared {
            sessions,
            accounts,
            credentials,
            clock,
            capabilities: capabilities(),
            transcript_path: Box::new(move |id| paths.path(id).to_string_lossy().into_owned()),
        });
        let inner = Inner {
            sdk,
            store,
            claude,
            options,
            descriptor: descriptor(),
            tools,
            adapters: Adapters::default(),
            shared,
        };
        Ok(Self(Arc::new(inner)))
    }

    /// The recorded conversation a session of `spec` continues.
    async fn history(&self, spec: &LaunchSpec) -> Result<Vec<eos_agent_core::StoredMessage>, Error> {
        let Some(session_id) = spec.resume.as_deref().filter(|id| !id.is_empty()) else { return Ok(Vec::new()) };
        let inner = &self.0;
        let own = inner.store.load(&spec.worker_id).await.map_err(Error::storage)?;
        if !own.is_empty() || session_id == spec.worker_id {
            return Ok(own);
        }
        // A chat from before the engine: Claude Code recorded it. It is read
        // once; from here on the engine's own store holds the conversation.
        let claude = match &inner.claude {
            Some(paths) => Some(paths.clone()),
            None => ClaudePaths::from_env(),
        };
        let old = claude.and_then(|paths| {
            transcript::claude_history(&paths, std::path::Path::new(&spec.cwd), session_id, &spec.model)
        });
        let Some(messages) = old else {
            return Err(Error::Rule("this conversation's transcript was not found, so it cannot be continued".into()));
        };
        inner.store.replace(&spec.worker_id, &messages).await.map_err(Error::storage)?;
        Ok(messages)
    }

    fn options(&self, spec: &LaunchSpec, history: Vec<eos_agent_core::StoredMessage>) -> AgentOptions {
        let inner = &self.0;
        let focused = spec.is_focused();
        let seed = Extensions::default();
        seed.insert(EosSession { worker_id: spec.worker_id.as_str().into() });
        let mut options = AgentOptions::new(&spec.cwd)
            .id(&spec.worker_id)
            .model(&spec.model)
            .roots(spec.additional_dirs.iter().map(PathBuf::from).collect())
            .history(history)
            .tools(inner.adapters.engine_tools(inner.tools.for_session(spec)))
            .extensions(seed)
            .mcp(inner.options.mcp)
            // A focused session is a plain coding session with tool search;
            // orchestrators and workers get every tool in full, as today.
            .tool_search(focused)
            // Eos summarizes a conversation itself, at a worker's idle edge.
            .auto_compact(false)
            .plugin_dirs(inner.options.plugin_dirs.clone());
        if let Some(effort) = &spec.effort {
            options = options.effort(effort);
        }
        if let Some(prompt) = spec.system_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
            options = options.system_prompt(SystemPromptOverride::Append(prompt.to_owned()));
        }
        if !focused {
            let mut denied: Vec<String> =
                disallowed_builtin_tools_for(spec.is_orchestrator()).into_iter().map(str::to_owned).collect();
            if spec.is_orchestrator() {
                denied.push(SUBAGENT_TOOL.to_owned());
            }
            options = options.disallowed_tools(denied);
        }
        options
    }
}

impl AgentRuntime for Engine {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.0.descriptor
    }

    fn start(
        &self,
        spec: LaunchSpec,
        sink: Arc<dyn SessionSink>,
    ) -> BoxFuture<'_, Result<Arc<dyn AgentSession>, Error>> {
        Box::pin(async move {
            let inner = &self.0;
            let shared = &inner.shared;
            if shared.sessions.is_live(&spec.worker_id) {
                return Err(Error::Conflict(format!("worker {} already has a live session", spec.worker_id)));
            }
            let credential = match spec.credential.clone() {
                Some(credential) => Some(credential),
                None => shared.credentials.for_new_session(PROVIDER).await,
            };
            let history = self.history(&spec).await?;
            let (subagent_events, subagents) = mpsc::channel(SUBAGENT_EVENTS);
            let (task_events, tasks) = mpsc::channel(TASK_EVENTS);
            let mut options = self.options(&spec, history).subagent_events(subagent_events).task_events(task_events);
            if let Some(credential) = &credential {
                options = options.auth(shared.accounts.of(credential));
            }
            let (agent, events) = inner.sdk.spawn(options).await.map_err(engine_error)?;
            let worker_id = spec.worker_id.clone();
            let launch = Launch {
                worker_id: worker_id.clone(),
                focused: spec.is_focused(),
                agent,
                events,
                subagents,
                tasks,
                credential: credential.clone(),
                sink: sink.clone(),
                shared: shared.clone(),
            };
            // Before the pump can report anything: the session is up, and the
            // id its conversation is recorded under is the worker's.
            let up = |phase, session_id: Option<&str>| {
                AgentEvent::Session(SessionEvent { phase, outcome: None, session_id: session_id.map(str::to_owned) })
            };
            sink.events(
                &worker_id,
                vec![up(SessionEventPhase::Started, None), up(SessionEventPhase::Ready, Some(&worker_id))],
            )
            .await;
            let Some(session) = session::start(launch) else {
                return Err(Error::Conflict(format!("worker {worker_id} already has a live session")));
            };
            shared.credentials.launched(&worker_id, credential.as_ref());
            if let Some(prompt) = spec.prompt.filter(|p| !p.is_empty()) {
                session.send(prompt).await.map_err(engine_error)?;
            }
            Ok(session as Arc<dyn AgentSession>)
        })
    }

    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.shared.sessions.get(worker_id).map(|s| s as Arc<dyn AgentSession>)
    }

    fn live(&self) -> usize {
        self.0.shared.sessions.len()
    }

    fn forget<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let path = self.0.store.path(worker_id);
            if let Err(e) = tokio::fs::remove_file(&path).await
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(worker_id, error = %e, "a recorded conversation could not be deleted");
            }
        })
    }
}

impl OneShot for Engine {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>> {
        Box::pin(async move {
            let shared = &self.0.shared;
            // What a new session would run on: a plan sign-in, else the key.
            let credential = shared.credentials.for_new_session(PROVIDER).await.ok_or(OneShotError::NoCredential)?;
            let OneShotRequest { model, system, prompt, schema, effort, timeout } = request;
            let mut ask = CompleteRequest::new(prompt).auth(shared.accounts.of(&credential));
            ask.model = model;
            ask.system = system;
            ask.effort = effort;
            let structured = schema.is_some();
            ask.schema = schema;
            let answered = match timeout {
                Some(limit) => tokio::time::timeout(limit, self.0.sdk.complete(ask))
                    .await
                    .map_err(|_| OneShotError::TimedOut(limit))?,
                None => self.0.sdk.complete(ask).await,
            };
            let answered = answered.map_err(|e| OneShotError::Failed(e.to_string()))?;
            let data = match answered.structured {
                Some(raw) => Some(serde_json::from_str(raw.get()).map_err(|e| OneShotError::Failed(e.to_string()))?),
                None if structured => {
                    return Err(OneShotError::Failed("the model returned no structured output".into()));
                }
                None => None,
            };
            Ok(OneShotAnswer { text: answered.text, structured: data })
        })
    }
}

impl BackendCatalog for Engine {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        vec![self.0.descriptor.to_ui()]
    }
}

impl SessionAccountSwitch for Engine {
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(session) = self.0.shared.sessions.get(worker_id) else {
                return Err("this agent can't change account right now".to_owned());
            };
            session.switch_account(credential).await.map_err(|e| e.to_string())
        })
    }
}

/// An [`Engine`] that is built when the first session starts: composing the
/// app costs nothing and reads nothing of the engine's until an agent runs.
pub struct LazyEngine {
    built: tokio::sync::OnceCell<Engine>,
    setup: std::sync::Mutex<Option<(EngineOptions, EngineDeps)>>,
    descriptor: BackendDescriptor,
}

impl std::fmt::Debug for LazyEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LazyEngine").field("built", &self.built.initialized()).finish_non_exhaustive()
    }
}

impl LazyEngine {
    pub fn new(options: EngineOptions, deps: EngineDeps) -> Self {
        Self {
            built: tokio::sync::OnceCell::new(),
            setup: std::sync::Mutex::new(Some((options, deps))),
            descriptor: descriptor(),
        }
    }

    async fn engine(&self) -> Result<&Engine, Error> {
        self.built
            .get_or_try_init(|| async {
                let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
                let Some((options, deps)) = setup else { return Err(engine_error("the engine has no configuration")) };
                Engine::build(options, deps).await
            })
            .await
    }
}

impl AgentRuntime for LazyEngine {
    fn descriptor(&self) -> &BackendDescriptor {
        &self.descriptor
    }

    fn start(
        &self,
        spec: LaunchSpec,
        sink: Arc<dyn SessionSink>,
    ) -> BoxFuture<'_, Result<Arc<dyn AgentSession>, Error>> {
        Box::pin(async move { self.engine().await?.start(spec, sink).await })
    }

    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.built.get().and_then(|engine| engine.session(worker_id))
    }

    fn live(&self) -> usize {
        self.built.get().map_or(0, AgentRuntime::live)
    }

    fn forget<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // Deleting a recorded conversation needs the store's folder, not a running engine.
            if let Ok(engine) = self.engine().await {
                engine.forget(worker_id).await;
            }
        })
    }
}

impl OneShot for LazyEngine {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>> {
        Box::pin(async move {
            let engine = self.engine().await.map_err(|e| OneShotError::Failed(e.to_string()))?;
            engine.complete(request).await
        })
    }
}

impl CommandCatalog for LazyEngine {
    fn commands<'a>(&'a self, cwd: Option<&'a Path>) -> BoxFuture<'a, Vec<CommandItem>> {
        Box::pin(async move {
            // Read from the engine's configuration: listing never builds the engine.
            let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            let Some((options, _)) = setup else { return Vec::new() };
            let Some(paths) = options.claude_home.as_deref().map(ClaudePaths::for_home).or_else(ClaudePaths::from_env)
            else {
                return Vec::new();
            };
            let cwd = cwd.map(Path::to_path_buf);
            let listed =
                tokio::task::spawn_blocking(move || folder_commands(&paths, &options.plugin_dirs, cwd.as_deref()))
                    .await;
            listed.unwrap_or_default()
        })
    }
}

impl BackendCatalog for LazyEngine {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        vec![self.descriptor.to_ui()]
    }
}

impl SessionAccountSwitch for LazyEngine {
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match self.built.get() {
                Some(engine) => engine.move_session(worker_id, credential).await,
                None => Err("this agent can't change account right now".to_owned()),
            }
        })
    }
}
