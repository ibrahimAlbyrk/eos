//! The engine, built once, and the sessions it starts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_agent_compat::{ClaudePaths, transcript_path};
use eos_agent_core::{Extensions, TranscriptStore};
use eos_agent_engine::JsonlStore;
use eos_agent_sdk::{
    AgentOptions, ArtifactAuth, ArtifactOpener, CompleteRequest, FrameConfig, OpenRequest, Sdk, SpawnLimits,
    SystemPromptOverride, WatchConfig,
};
use eos_contracts::tool_scope::disallowed_builtin_tools_for;
use eos_contracts::{
    AgentEvent, CommandItem, ProviderModel, ProviderModels, SessionEvent, SessionEventPhase, UiBackendDescriptor,
    UiBackendDescriptorBilling, UiBackendDescriptorCatalog, UiBackendDescriptorSessionStore,
};
use eos_core::accounts::{AfterMove, SessionAccountSwitch, SessionCredential, SessionCredentials};
use eos_core::agent::{
    AgentCapabilities, AgentRuntime, AgentSession, ArtifactViewer, BackendAuth, BackendCatalog, BackendDescriptor,
    CommandCatalog, CompactionWords, LaunchSpec, ModelSource, OneShot, OneShotAnswer, OneShotError, OneShotRequest,
    ProviderKeys, SessionSink, ToolSets, UserQuestions,
};
use eos_core::policy::PolicyDecider;
use eos_core::{BoxFuture, Clock, Error};
use eos_platform::DataPaths;
use tokio::sync::mpsc;

use crate::accounts::{Accounts, ArtifactLogin, Failover, NewSession, NotSignedIn};
use crate::commands::{folder_commands, with_session_commands};
use crate::compaction::{LastSummary, Words};
use crate::endpoints::{self, Endpoints};
use crate::gate::EosGate;
use crate::mapper::request_usage;
use crate::prompter::Prompter;
use crate::registry::Registry;
use crate::session::{self, Launch, Shared};
use crate::tools::{Adapters, EosSession};
use crate::{takeover, transcript};
use eos_domain::provider::ProviderEndpoint;

/// The provider of Claude sign-ins: one-shot answers and the Artifact tools run on it.
pub(crate) const PROVIDER: &str = "anthropic";
/// The provider of ChatGPT sign-ins.
const OPENAI: &str = "openai";
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
    /// Paths no file tool writes, whatever the policy allows (the app's own
    /// state); the engine's folder is always one.
    pub protected: Vec<PathBuf>,
    /// The data folder whose database files no tool opens; `None` guards none.
    pub data: Option<DataPaths>,
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
            protected: Vec::new(),
            data: None,
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
    /// What a session's summary of its conversation is asked for with, and
    /// the message the conversation goes on from.
    pub compaction: Arc<dyn CompactionWords>,
    /// Where an artifact an agent published or asked to show opens.
    pub artifacts: Arc<dyn ArtifactViewer>,
    /// `config.json`: the providers reached with an API key are its backends.
    pub config: Arc<dyn eos_core::store::ConfigSource>,
}

/// The engine's "show this artifact" as Eos's: the agent is the worker (only
/// a session's own agent opens one, never a subagent).
struct Opener(Arc<dyn ArtifactViewer>);

impl ArtifactOpener for Opener {
    fn open<'a>(&'a self, request: &'a OpenRequest) -> eos_agent_core::BoxFuture<'a, bool> {
        let OpenRequest { agent_id, slug, url, title, .. } = request;
        Box::pin(std::future::ready(self.0.open(agent_id, slug, url, title.as_deref())))
    }
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
    config: Arc<dyn eos_core::store::ConfigSource>,
    store: JsonlStore,
    claude: Option<ClaudePaths>,
    options: EngineOptions,
    descriptor: BackendDescriptor,
    tools: Arc<dyn ToolSets>,
    adapters: Adapters,
    shared: Arc<Shared>,
    compaction: Arc<dyn CompactionWords>,
}

/// Agent sessions on `eos-agent-sdk`. Cheap to clone.
#[derive(Clone)]
pub struct Engine(Arc<Inner>);

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").field("live", &self.live()).finish_non_exhaustive()
    }
}

/// `window()` when `model` is one of a ChatGPT account.
fn openai_window(model: &str, window: impl FnOnce() -> u64) -> Option<i64> {
    (session::provider_of(model) == OPENAI).then(window).and_then(|w| i64::try_from(w).ok())
}

fn engine_error(error: impl std::fmt::Display) -> Error {
    Error::Rule(format!("the agent could not start: {error}"))
}

impl Engine {
    /// Builds what every session shares: one HTTP client, the tools, the
    /// prompts, the MCP hub, the transcript store. Reads no credential.
    pub async fn build(options: EngineOptions, deps: EngineDeps) -> Result<Self, Error> {
        let EngineDeps { policy, tools, credentials, questions, clock, secrets, compaction, artifacts, config } = deps;
        let sessions = Arc::new(Registry::default());
        let accounts = Arc::new(Accounts::new(secrets.clone()));
        let store = JsonlStore::new(options.dir.join("transcripts"));
        let claude = options.claude_home.as_deref().map(ClaudePaths::for_home);
        let failover =
            Failover { credentials: credentials.clone(), accounts: accounts.clone(), sessions: sessions.clone() };
        // What reads the ChatGPT account's models: the sign-in a new session would start on.
        let chatgpt = NewSession { provider: OPENAI, credentials: credentials.clone(), accounts: accounts.clone() };
        let mut builder = Sdk::builder()
            // A session brings its own credential; one without any is told so.
            .auth(Arc::new(NotSignedIn))
            .chatgpt_store(options.dir.join("data").join(OPENAI))
            .openai(Arc::new(chatgpt))
            // Building reads nothing: the account's models are read when a
            // session needs them or the model menu lists them.
            .openai_models_later()
            // Each session publishes on its own Claude sign-in (`ArtifactLogin`).
            .artifacts(true)
            .artifact_opener(Arc::new(Opener(artifacts)))
            .auth_failover(Arc::new(failover))
            .permissions(Arc::new(EosGate { policy, sessions: sessions.clone(), data: options.data.clone() }))
            .prompter(Arc::new(Prompter { questions, sessions: sessions.clone() }))
            .store(Arc::new(store.clone()) as Arc<dyn TranscriptStore>)
            .data_dir(options.dir.join("data"))
            // A subagent may be asked onto any provider's model, by the names the prompt lists.
            .spawn_limits(SpawnLimits { any_model: true, ..SpawnLimits::from_env(|k| std::env::var(k).ok()) })
            .workflow_dir(options.dir.join("workflows"));
        // Transcripts, other agents' scratch and workflow runs: the engine's, never a tool's to write.
        builder = builder.protect_from_writes(options.dir.clone());
        for path in &options.protected {
            builder = builder.protect_from_writes(path.clone());
        }
        if let Some(model) = &options.default_model {
            builder = builder.model(model.clone());
        }
        if let Some(url) = &options.base_url {
            let url = url.trim_end_matches('/');
            builder = builder.base_url(url).openai_base_url(format!("{url}/v1")).artifact_api(
                FrameConfig {
                    base_url: url.to_owned(),
                    content_host: format!("{url}/_host/{{slug}}"),
                    ..FrameConfig::default()
                },
                WatchConfig { live_origin: url.to_owned(), ..WatchConfig::default() },
            );
        }
        if let Some(paths) = &claude {
            builder = builder.claude_paths(paths.clone());
        }
        let sdk = builder.build().await.map_err(engine_error)?;
        let config_kept = config.clone();
        let endpoints = Endpoints::new(config, secrets, clock.clone(), sdk.clone());
        let shared = Arc::new(Shared {
            endpoints,
            sessions,
            accounts,
            credentials,
            clock,
            capabilities: capabilities(),
            store: store.clone(),
        });
        let inner = Inner {
            sdk,
            config: config_kept,
            store,
            claude,
            options,
            descriptor: descriptor(),
            tools,
            adapters: Adapters::default(),
            shared,
            compaction,
        };
        Ok(Self(Arc::new(inner)))
    }

    /// The recorded conversation a session of `spec` continues.
    async fn history(&self, spec: &LaunchSpec) -> Result<Vec<eos_agent_core::StoredMessage>, Error> {
        let Some(session_id) = spec.resume.as_deref().filter(|id| !id.is_empty()) else { return Ok(Vec::new()) };
        let inner = &self.0;
        let own = inner.store.load(&spec.worker_id).await.map_err(Error::storage)?;
        if session_id == spec.worker_id {
            return Ok(own);
        }
        // A chat from before the engine, resumed by the Claude Code session
        // the TypeScript app resumes it by. The engine takes that conversation
        // once and keeps it in its own record, unless the TypeScript app went
        // on with the chat since (a user went back to it, then came back).
        let record = inner.store.path(&spec.worker_id);
        let claude = inner.claude.clone().or_else(ClaudePaths::from_env);
        let transcript = claude.map(|paths| transcript_path(&paths, Path::new(&spec.cwd), session_id));
        let taken = match takeover::read(&record).await {
            Some(origin) => Some(!origin.read_gone_on(session_id.to_owned(), transcript.clone()).await),
            // Taken by a build that kept no note: what Claude Code holds now is what it took.
            None if tokio::fs::try_exists(&record).await.unwrap_or(false) => {
                if let Some(now) = takeover::read_recorded(transcript.clone()).await {
                    takeover::write(&record, &takeover::Origin::of(session_id, &now)).await;
                }
                Some(true)
            }
            None => None,
        };
        if taken == Some(true) {
            return Ok(own);
        }
        let Some(now) = takeover::read_recorded(transcript.clone()).await else {
            // Gone on into a session Claude Code has no transcript of: the record is what is left.
            if taken.is_some() {
                return Ok(own);
            }
            return Err(Error::Rule("this conversation's transcript was not found, so it cannot be continued".into()));
        };
        let origin = takeover::Origin::of(session_id, &now);
        let messages = transcript::claude_messages(now.session, &spec.model);
        inner.store.replace(&spec.worker_id, &messages).await.map_err(Error::storage)?;
        takeover::write(&record, &origin).await;
        Ok(messages)
    }

    fn options(
        &self,
        spec: &LaunchSpec,
        history: Vec<eos_agent_core::StoredMessage>,
        last_summary: Arc<LastSummary>,
    ) -> AgentOptions {
        let inner = &self.0;
        let focused = spec.is_focused();
        let seed = Extensions::default();
        seed.insert(EosSession { worker_id: spec.worker_id.as_str().into() });
        let shared = &inner.shared;
        seed.insert(ArtifactAuth(Arc::new(ArtifactLogin {
            worker_id: spec.worker_id.clone(),
            sessions: shared.sessions.clone(),
            credentials: shared.credentials.clone(),
            accounts: shared.accounts.clone(),
        })));
        let mut options = AgentOptions::new(&spec.cwd)
            .id(&spec.worker_id)
            .model(&spec.model)
            .roots(spec.additional_dirs.iter().map(PathBuf::from).collect())
            .history(history)
            .tools(inner.adapters.engine_tools(inner.tools.for_session(spec)))
            .extensions(seed)
            .mcp(inner.options.mcp && spec.folder_mcp)
            // A focused session is a plain coding session with tool search;
            // orchestrators and workers get every tool in full, as today.
            .tool_search(focused)
            // The conversation is summarized at Eos's threshold, before the
            // request that would pass it, and the turn goes on.
            .compaction_text(Arc::new(Words::new(
                inner.compaction.clone(),
                &inner.store.path(&spec.worker_id),
                last_summary,
            )))
            .auto_compact(spec.compact_at.is_some())
            .plugin_dirs(inner.options.plugin_dirs.clone());
        // Eos's model list knows models newer than the engine's own table.
        if let Some(window) = spec.context_window {
            options = options.context_window(window);
        }
        if let Some(at) = spec.compact_at {
            options = options.compact_at(at);
        }
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
                // A key-based provider's key is the engine's own for it.
                None if session::keyed(&spec.model) => {
                    shared.endpoints.sync();
                    None
                }
                None => shared.credentials.for_new_session(&session::provider_of(&spec.model)).await,
            };
            let history = self.history(&spec).await?;
            let prompts = history.iter().filter(|m| transcript::is_prompt(m)).count();
            let last_summary = Arc::new(LastSummary::default());
            let (subagent_events, subagents) = mpsc::channel(SUBAGENT_EVENTS);
            let (task_events, tasks) = mpsc::channel(TASK_EVENTS);
            let mut options = self
                .options(&spec, history, last_summary.clone())
                .subagent_events(subagent_events)
                .task_events(task_events);
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
                prompts: i64::try_from(prompts).unwrap_or(i64::MAX),
                last_summary,
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
            for note in spec.notes {
                session.note(note).map_err(engine_error)?;
            }
            if let Some(prompt) = spec.prompt.filter(|p| !p.is_empty()) {
                session.send(prompt).await.map_err(engine_error)?;
            }
            Ok(session as Arc<dyn AgentSession>)
        })
    }

    fn session(&self, worker_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.0.shared.sessions.get(worker_id).map(|s| s as Arc<dyn AgentSession>)
    }

    fn other_provider_window(&self, model: &str) -> Option<i64> {
        openai_window(model, || self.0.sdk.context_window(model))
            .or_else(|| endpoints::window_of(self.0.config.as_ref(), model))
    }

    fn live(&self) -> usize {
        self.0.shared.sessions.len()
    }

    fn forget<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let record = self.0.store.path(worker_id);
            for path in [takeover::note_path(&record), record] {
                if let Err(e) = tokio::fs::remove_file(&path).await
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    tracing::warn!(worker_id, error = %e, "a recorded conversation could not be deleted");
                }
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
            Ok(OneShotAnswer {
                text: answered.text,
                structured: data,
                usage: Some(request_usage(&answered.usage)),
                model: Some(answered.model),
            })
        })
    }
}

impl BackendCatalog for Engine {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        vec![self.0.descriptor.to_ui()]
    }
}

impl Engine {
    /// The engine itself, for what Eos runs on it besides sessions.
    pub(crate) fn sdk(&self) -> &Sdk {
        &self.0.sdk
    }

    /// The models the ChatGPT account offers, as its catalog lists them.
    async fn chatgpt_models(&self) -> Vec<ProviderModel> {
        // Where the engine keeps the list between runs.
        let kept = self.0.options.dir.join("data").join(OPENAI);
        if let Err(e) = tokio::fs::create_dir_all(&kept).await {
            tracing::warn!(error = %e, "the folder for the ChatGPT model list could not be made");
        }
        let Some(catalog) = self.0.sdk.openai_models().await else { return Vec::new() };
        if catalog.models.is_empty() {
            tracing::warn!("the ChatGPT account's model list could not be read");
        }
        let listed = catalog.models.iter().filter(|m| m.listed);
        listed
            .map(|m| ProviderModel {
                id: m.slug.clone(),
                display_name: m.display_name.clone().unwrap_or_else(|| m.slug.clone()),
                context_window: m.context_window.and_then(|w| i64::try_from(w).ok()),
                effort_levels: Some(m.efforts.clone()).filter(|levels| !levels.is_empty()),
                default_effort: m.default_effort.clone(),
            })
            .collect()
    }
}

impl SessionAccountSwitch for Engine {
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
        after: AfterMove,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(session) = self.0.shared.sessions.get(worker_id) else {
                return Err("this agent can't change account right now".to_owned());
            };
            session.switch_account(credential, after).await.map_err(|e| e.to_string())
        })
    }
}

/// An [`Engine`] that is built when the first session starts: composing the
/// app costs nothing and reads nothing of the engine's until an agent runs.
pub struct LazyEngine {
    built: tokio::sync::OnceCell<Engine>,
    setup: std::sync::Mutex<Option<(EngineOptions, EngineDeps)>>,
    descriptor: BackendDescriptor,
    /// The providers as last listed.
    listed: std::sync::Mutex<Vec<ProviderModels>>,
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
            listed: std::sync::Mutex::default(),
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

    fn runs_other_model(&self, model: &str) -> bool {
        // A ChatGPT model runs once the engine is up, which listing the
        // account's models (or any session) brings about; a key-based
        // provider's as soon as config.json names it.
        (session::keyed(model) || self.built.initialized()) && self.other_provider_window(model).is_some()
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

    fn other_provider_window(&self, model: &str) -> Option<i64> {
        match self.built.get() {
            Some(engine) => engine.other_provider_window(model),
            // The account's catalog is read once the engine runs; its default until then.
            None => openai_window(model, || eos_agent_sdk::OPENAI_CONTEXT_WINDOW).or_else(|| {
                let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                setup.as_ref().and_then(|(_, deps)| endpoints::window_of(deps.config.as_ref(), model))
            }),
        }
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

impl LazyEngine {
    /// The folder's commands. Read from the engine's configuration: listing
    /// never builds the engine.
    async fn folder(&self, cwd: Option<&Path>) -> Vec<CommandItem> {
        let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let Some((options, _)) = setup else { return Vec::new() };
        let Some(paths) = options.claude_home.as_deref().map(ClaudePaths::for_home).or_else(ClaudePaths::from_env)
        else {
            return Vec::new();
        };
        let cwd = cwd.map(Path::to_path_buf);
        let listed =
            tokio::task::spawn_blocking(move || folder_commands(&paths, &options.plugin_dirs, cwd.as_deref())).await;
        listed.unwrap_or_default()
    }
}

impl CommandCatalog for LazyEngine {
    fn commands<'a>(&'a self, cwd: Option<&'a Path>, worker_id: Option<&'a str>) -> BoxFuture<'a, Vec<CommandItem>> {
        Box::pin(async move {
            let mut listed = self.folder(cwd).await;
            // What the live session found since (a subfolder's skills, `apps/web:deploy`).
            if let Some(session) = worker_id.and_then(|id| self.session(id)) {
                listed = with_session_commands(listed, session.commands());
            }
            listed
        })
    }
}

impl BackendCatalog for LazyEngine {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        vec![self.descriptor.to_ui()]
    }

    fn providers(&self) -> BoxFuture<'_, Vec<ProviderModels>> {
        Box::pin(async move {
            let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            let Some((_, deps)) = setup else { return Vec::new() };
            let ready = deps.credentials.for_new_session(OPENAI).await.is_some();
            let keyed = eos_domain::provider::endpoints(&deps.config.current());
            let with_key = |e: &ProviderEndpoint| endpoints::key_of(deps.secrets.as_ref(), e).is_some();
            // With no sign-in and no key, nothing is read: the engine is not built for the list.
            let engine = match ready || keyed.iter().any(with_key) {
                true => self.engine().await.ok(),
                false => None,
            };
            let models = match engine.filter(|_| ready) {
                Some(engine) => engine.chatgpt_models().await,
                None => Vec::new(),
            };
            let mut all = vec![ProviderModels { id: OPENAI.into(), label: "ChatGPT".into(), ready, models }];
            match engine {
                Some(engine) => all.extend(engine.0.shared.endpoints.listing().await),
                None => all.extend(keyed.iter().map(|e| endpoints::listed(e, false, &[]))),
            }
            self.listed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone_from(&all);
            all
        })
    }

    fn listed_providers(&self) -> Vec<ProviderModels> {
        self.listed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl ProviderKeys for LazyEngine {
    fn probe<'a>(&'a self, endpoint: &'a ProviderEndpoint, key: &'a str) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            let engine = self.engine().await.map_err(|e| e.to_string())?;
            engine.0.shared.endpoints.probe(endpoint, key.to_owned()).await
        })
    }

    fn save(&self, service: &str, key: &str) -> Result<(), String> {
        let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((_, deps)) = setup.as_ref() else { return Err("the engine has no configuration".into()) };
        deps.secrets.write_secret(service, key).map_err(|e| e.to_string())
    }

    fn forget(&self, service: &str) {
        let setup = self.setup.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, deps)) = setup.as_ref() {
            deps.secrets.delete_secret(service);
        }
    }
}

impl SessionAccountSwitch for LazyEngine {
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
        after: AfterMove,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match self.built.get() {
                Some(engine) => engine.move_session(worker_id, credential, after).await,
                None => Err("this agent can't change account right now".to_owned()),
            }
        })
    }
}
