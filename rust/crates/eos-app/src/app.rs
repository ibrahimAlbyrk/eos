//! Building the app from a data folder, and running it.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_accounts::{Accounts, TokioSleeper};
use eos_auth::{
    AccountDirs, ChatGptSignIn, ClaudeSignIn, ClaudeTokenProbe, ClaudeUsageApi, Endpoints, FilePlanLoginStore,
    FileUsageSnapshots, HostCredentials, Stores,
};
use eos_config::{ConfigFile, SettingsFile, env_from_process};
use eos_core::accounts::{PlanAccess, SessionCredentials};
use eos_core::net::updates::{UpdateApplier, UpdateSignals};
use eos_core::plugin::{PluginPreviewer, Plugins};
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::{Clock, Ids, RandomIds, SystemClock};
use eos_domain::config::Env;
use eos_engine::EngineDeps;
use eos_git::ScratchRepos;
use eos_kit_sqlite::Db;
use eos_mod_plugins::{NoPreviewWindow, PluginHost};
use eos_mod_system::RunInfo;
use eos_platform::DataPaths;
use eos_policy::{GatewayOptions, PolicyGateway};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::lifecycle::ShutdownReport;
use eos_runtime::router::Router;
use eos_runtime::stream::StreamOptions;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::Reconciled;
use eos_sessions::{SessionDeps, Sessions, SlashCommand};
use eos_store_files::policy::YamlPolicyFile;
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::templates::FsTemplateStore;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_store_files::{CachedModelCatalog, JsonProjects, JsonRecents};
use eos_store_sqlite::{SqliteStore, StoreOptions};
use eos_update::legacy::{Launchctl, Launchd};
use eos_workers::WorkerDefinitions;

use crate::Error;
use crate::agent::{
    self, AgentOptions, AppHooks, AppPrompts, FixedCredential, Leftovers, NoLiveSessions, NoTools, NoUser,
};
use crate::announce::BusAnnouncer;
use crate::boot;
use crate::callers::Callers;
use crate::display::StripSenderTags;
use crate::host::{self, HostLocalTime, HostStats, SystemBrowser};
use crate::modules::{self, Context};
use crate::notes::{Notes, ProfilePrompt};
use crate::updates::{Install, Updates};

/// What the app is built from. Tests swap the clock, the id source and the
/// environment.
#[derive(Clone)]
pub struct Options {
    /// The data folder (`~/.eos`).
    pub home: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The `EOS_*` variables that override configuration defaults.
    pub env: Env,
    /// The folder of the bundled PDF viewer (`web/viewer.html` inside it);
    /// without it the raw-content origin serves no `/pdfjs/*`.
    pub pdfjs_root: Option<PathBuf>,
    /// How agents reach the model; the real provider and files by default.
    pub agents: AgentOptions,
    /// The app bundle's resources folder: what ships beside the program
    /// (`esbuild`, `claude-plugin/`). `None` in a development run, which
    /// falls back to the repository it was built in.
    pub resources: Option<PathBuf>,
    /// The window shell, which draws plugin previews. Until it does, a
    /// preview answers that no window is open.
    pub plugin_previewer: Arc<dyn PluginPreviewer>,
    /// Delete, at start-up, the worktrees and scratch folders Eos made that no
    /// chat in the data folder uses any more. Only the installed app turns it
    /// on: the worktrees live in the user's repositories, so an app on a copy
    /// of a data folder (a test, a replay) must never judge them.
    pub sweep_leftovers: bool,
    /// The running executable. A release build — one inside an app bundle
    /// that ships `update.json` — updates itself; anything else never does.
    pub exec_path: Option<PathBuf>,
    /// The window shell's hand-over to the update applier (start it, quit).
    /// Without one, restarting into an update answers that it cannot.
    pub update_applier: Option<Arc<dyn UpdateApplier>>,
    /// The user's launchd session. A release build on the user's own data
    /// folder stops the TypeScript-era daemon through it before it opens the
    /// data; nothing else ever uses it.
    pub launchd: Option<Arc<dyn Launchd + Send + Sync>>,
}

impl Options {
    /// The system clock, random ids and this process's environment.
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self {
            home: home.into(),
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
            env: env_from_process(),
            pdfjs_root: None,
            agents: AgentOptions::default(),
            resources: None,
            plugin_previewer: Arc::new(NoPreviewWindow),
            sweep_leftovers: false,
            exec_path: std::env::current_exe().ok(),
            update_applier: None,
            launchd: Launchctl::for_this_user().map(|launchctl| Arc::new(launchctl) as Arc<dyn Launchd + Send + Sync>),
        }
    }
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options").field("home", &self.home).finish_non_exhaustive()
    }
}

/// Claude Code's own folder.
fn claude_home() -> PathBuf {
    let claude_home = std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| "~/.claude".to_owned());
    PathBuf::from(eos_platform::expand_path(&claude_home))
}

/// Claude Code's plans folder: an agent may always write its plan there.
fn plans_dir() -> String {
    claude_home().join("plans").to_string_lossy().into_owned()
}

/// The running core: what the shell's bridge and the gateways hold.
pub struct App {
    runtime: Arc<Runtime>,
    raw_router: Arc<Router>,
    store: Arc<SqliteStore>,
    config: Arc<ConfigFile>,
    settings: Arc<SettingsFile>,
    accounts: Arc<Accounts>,
    callers: Callers,
    paths: DataPaths,
    reconciled: Reconciled,
    sessions: Sessions,
    /// Kept for as long as the app runs.
    nudges: std::sync::Mutex<Option<eos_runtime::bus::Subscription>>,
    plugins: Arc<PluginHost>,
    updates: Arc<Updates>,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App").field("home", &self.paths.home()).field("runtime", &self.runtime).finish_non_exhaustive()
    }
}

impl App {
    /// Opens the data folder and composes the app, in today's start-up order
    /// where it still applies: configuration, a snapshot of the user's data,
    /// the database and its migrations, the data's own start-up work, then
    /// the kernel and the modules. Nothing runs yet: call
    /// [`start`](Self::start). Blocks on file and database work.
    pub fn build(options: Options) -> Result<Self, Error> {
        let Options {
            home,
            clock,
            ids,
            env,
            pdfjs_root,
            agents,
            resources,
            plugin_previewer,
            exec_path,
            update_applier,
            launchd,
            sweep_leftovers,
        } = options;
        let paths = DataPaths::new(&home);
        fs::create_dir_all(paths.home()).map_err(|source| Error::Home { path: paths.home().to_owned(), source })?;
        // Before anything in the data folder is read: the previous Eos's
        // daemon must not be working on it too.
        let install = Install::resolve(exec_path.as_deref(), &paths);
        install.retire_legacy_daemon(launchd.as_deref());
        let config = Arc::new(ConfigFile::load(paths.home(), env, eos_platform::host().features().remote));
        let current = config.current();
        let callers = Callers::load(paths.home(), ids.as_ref());

        // Before the database opens: a migration must not run ahead of the copy.
        let snapshot = boot::snapshot(&paths, clock.as_ref());
        let (db, migrations) = Db::open(paths.state_db(), eos_kit_sqlite::Options::default(), clock.now_ms())?;
        if !migrations.unknown.is_empty() {
            tracing::info!(ids = ?migrations.unknown, "the database records migrations this build does not know; left alone");
        }

        let kernel = Kernel::new(KernelOptions {
            clock: clock.clone(),
            ids: ids.clone(),
            stream: StreamOptions {
                keepalive: Duration::from_millis(u64::try_from(current.daemon.sse_keepalive_ms).unwrap_or(25_000)),
                display_filter: Some(Arc::new(StripSenderTags)),
                ..StreamOptions::default()
            },
            ..KernelOptions::default()
        });
        let announcer = Arc::new(BusAnnouncer(kernel.bus.clone()));
        let store_options = StoreOptions { events_max_per_worker: current.events.max_per_worker };
        let store = Arc::new(SqliteStore::new(db, announcer.clone(), store_options));
        let reconciled = boot::settle(&store, clock.clone(), current.events.max_per_worker)?;

        let plugins = crate::plugins::host(crate::plugins::Parts {
            paths: &paths,
            bus: kernel.bus.clone(),
            clock: clock.clone(),
            ids: ids.clone(),
            resources: resources.as_deref(),
            previewer: plugin_previewer,
        })?;
        let accounts_dir = paths.join("accounts");
        let stores = Arc::new(Stores::new(Arc::new(HostCredentials), Endpoints::default()));
        let accounts = Accounts::new(eos_accounts::Deps {
            clock: clock.clone(),
            ids: ids.clone(),
            config: config.clone(),
            store: store.clone(),
            announcer,
            login_store: Arc::new(FilePlanLoginStore::new(accounts_dir.join("logins.json"))),
            dirs: Arc::new(AccountDirs::new(&accounts_dir)),
            stores: stores.clone(),
            providers: vec![Arc::new(ClaudeSignIn::new(stores.clone())), Arc::new(ChatGptSignIn::new(stores))],
            // The shell takes this over once it routes sign-in pages itself.
            browser: Arc::new(SystemBrowser),
            probe: Arc::new(ClaudeTokenProbe::default()),
            usage_api: Arc::new(ClaudeUsageApi::new(clock.clone())),
            usage_cache: Arc::new(FileUsageSnapshots::new(paths.join("usage-cache.json"))),
            local_time: Arc::new(HostLocalTime),
            sleeper: Arc::new(TokioSleeper),
            sessions: Arc::new(NoLiveSessions),
        });
        let policy = Arc::new(PolicyGateway::new(GatewayOptions {
            store: store.clone(),
            clock: clock.clone(),
            ids: ids.clone(),
            file: Arc::new(YamlPolicyFile::new(paths.join("policy.yaml"))),
            default_ttl_ms: current.permissions.default_ttl_ms,
            plans_dir: Some(plans_dir()),
        }));
        // The shipped prompts, with the user's `prompts` folder over them.
        let library = Arc::new(LibraryPromptSource::with_overrides(vec![paths.join("prompts")]));
        let prompts = Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars()));
        let templates = Arc::new(FsTemplateStore::new(paths.join("templates"), clock.clone()));
        let worker_definitions = Arc::new(WorkerDefinitions::new(
            Arc::new(FsWorkerDefinitionFiles::new(paths.join("workers"))),
            store.clone(),
            clock.clone(),
        ));

        let settings = Arc::new(SettingsFile::new(paths.join("settings.json")));
        // Asked of the helper the app ships; a run without a bundle has none.
        let location = resources.as_deref().and_then(|resources| host::helper_location(resources, clock.clone()));
        let media = eos_genui_media::build(
            &paths.join(eos_genui_media::MEDIA_CACHE_DIR),
            clock.clone(),
            eos_genui_media::Options::new()?,
        )?;

        let notes = Notes::open(&paths, &clock, store.clone(), config.clone());
        let profile_prompt = Arc::new(ProfilePrompt::new(notes.preview.clone()));
        let updates = crate::updates::build(crate::updates::Parts {
            install,
            paths: &paths,
            config: config.clone(),
            store: store.clone(),
            kernel: &kernel,
            clock: clock.clone(),
            applier: update_applier,
        })?;

        // Agents: the engine (built when the first session starts), and the
        // session service every feature that touches an agent goes through.
        let models = Arc::new(CachedModelCatalog::open(&paths.join("models.json")));
        let recents = Arc::new(JsonRecents::open(paths.join("recents.json")));
        let git = Arc::new(crate::files::git(&clock));
        // Chats without a folder work in a scratch folder of their own, deleted with them.
        let claude_projects = agents.claude_home.clone().unwrap_or_else(claude_home).join("projects");
        let scratch = Arc::new(ScratchRepos::new(git.as_ref().clone(), paths.join("scratch"), claude_projects));
        let leftovers = Arc::new(Leftovers {
            store: store.clone(),
            worktrees: git.clone(),
            scratch: scratch.clone(),
            clock: clock.clone(),
        });
        let hooks = Arc::new(AppHooks::new(kernel.bus.clone(), leftovers.clone()));
        // The accounts feature picks each session's credential, unless the run names its own.
        let credentials: Arc<dyn SessionCredentials> = match &agents.credential {
            Some(fixed) => Arc::new(FixedCredential(Some(fixed.clone()))),
            None => accounts.clone(),
        };
        let engine = agent::engine(
            &paths.join("engine"),
            &agents,
            EngineDeps {
                policy: policy.clone(),
                tools: Arc::new(NoTools),
                credentials: credentials.clone(),
                questions: Arc::new(NoUser),
                clock: clock.clone(),
            },
        );
        // "Resume at" and "Use API key" reach the live session through the engine.
        accounts.attach_sessions(engine.clone());
        let sessions = Sessions::new(SessionDeps {
            store: store.clone(),
            runtime: engine.clone(),
            clock: clock.clone(),
            ids: ids.clone(),
            config: config.clone(),
            models: models.clone(),
            prompts: Arc::new(AppPrompts {
                prompts: prompts.clone(),
                profile: profile_prompt.clone(),
                definitions: worker_definitions.clone(),
                hooks: hooks.clone(),
            }),
            worktrees: git,
            recents: recents.clone(),
            hooks: hooks.clone(),
        });

        let context = Context {
            bus: kernel.bus.clone(),
            clock: clock.clone(),
            ids: ids.clone(),
            notes,
            run: RunInfo {
                pid: std::process::id(),
                started_at: clock.now_ms(),
                source_stamp: concat!("rust-", env!("CARGO_PKG_VERSION")).to_owned(),
            },
            features: host::features(),
            stats: Arc::new(HostStats::read()),
            store: store.clone(),
            config: config.clone(),
            models,
            backends: engine,
            sessions: sessions.clone(),
            projects: Arc::new(JsonProjects::open(paths.join("projects.json"), ids)),
            recents,
            accounts: accounts.clone(),
            plugins: plugins.clone(),
            kernel: kernel.clone(),
            paths: paths.clone(),
            raw_routes: Default::default(),
            pdfjs_root,
            settings: settings.clone(),
            media,
            location,
            policy,
            profile_prompt,
            prompts,
            templates,
            updates: updates.clone(),
            worker_definitions,
            scratch,
            terminals: crate::terminals::terminal(credentials, accounts_dir.join("claude")),
        };
        let runtime = Arc::new(Runtime::build(kernel, modules::all(&context), plugins.switch())?);
        hooks.attach(&runtime);
        // The commands features run themselves (`/compact`, …), beside the session service's own.
        for declared in &runtime.slash_commands {
            match declared.command.downcast_ref::<Arc<dyn SlashCommand>>() {
                Some(command) => sessions.register_command(command.clone()),
                None => tracing::error!(name = declared.name, "a module's slash command is not a session command"),
            }
        }
        let raw_router = Arc::new(Router::builder().routes(context.raw_routes.take()).build()?);
        if let Some((backup, dir)) = snapshot {
            // Thousands of small files: after the app is up, off the start-up path.
            runtime.lifecycle.defer("backup", move || async move {
                tokio::task::spawn_blocking(move || boot::finish_snapshot(&backup, &dir)).await??;
                Ok(())
            })?;
        }
        // Scanning and building every plugin must not hold up the window.
        let starting = plugins.clone();
        runtime.lifecycle.defer("plugins", move || async move {
            starting.start().await;
            Ok(())
        })?;
        if sweep_leftovers {
            runtime.lifecycle.defer("leftovers", move || async move {
                leftovers.sweep().await;
                Ok(())
            })?;
        }
        let nudges = std::sync::Mutex::new(None);
        Ok(Self {
            runtime,
            raw_router,
            store,
            config,
            settings,
            accounts,
            callers,
            paths,
            reconciled,
            sessions,
            nudges,
            plugins,
            updates,
        })
    }

    /// Starts every module, then tells them the app is ready.
    pub async fn start(&self) -> Result<(), Error> {
        let nudges = agent::nudge_parents(
            &self.runtime.kernel.bus,
            self.store.clone(),
            self.sessions.clone(),
            tokio::runtime::Handle::current(),
        );
        *self.nudges.lock().unwrap_or_else(|p| p.into_inner()) = Some(nudges);
        self.runtime.lifecycle.start().await?;
        self.runtime.lifecycle.ready().await?;
        Ok(())
    }

    /// What the window shell tells the updater: its window showed, the
    /// computer woke. Each may start a check for a new release.
    pub fn update_signals(&self) -> Arc<dyn UpdateSignals> {
        self.updates.signals()
    }

    /// Call once the core is ready and the window is up. When this start
    /// follows an update, the applier that swapped the app in is waiting for
    /// this mark and puts the previous version back without it
    /// (`eos_update::handover::BOOT_TIMEOUT` after it opened the app). Does
    /// nothing in a build that does not update itself.
    pub fn mark_update_booted(&self) {
        self.updates.mark_booted();
    }

    /// What answers requests. The caller of each request is set by whoever
    /// hands it over ([`callers`](Self::callers) for this computer's window).
    pub fn router(&self) -> Arc<Router> {
        self.runtime.router.clone()
    }

    /// What answers the raw-content origin (files for the viewers, the PDF
    /// viewer). A separate router on purpose: content served there must never
    /// share an origin with the dashboard. Its callers are never the user.
    pub fn raw_router(&self) -> Arc<Router> {
        self.raw_router.clone()
    }

    pub fn callers(&self) -> &Callers {
        &self.callers
    }

    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    pub fn paths(&self) -> &DataPaths {
        &self.paths
    }

    pub fn config(&self) -> Arc<dyn ConfigSource> {
        self.config.clone()
    }

    pub fn settings(&self) -> Arc<dyn UserSettingsStore> {
        self.settings.clone()
    }

    /// What the agent engine asks about a session's credential.
    pub fn session_credentials(&self) -> Arc<dyn SessionCredentials> {
        self.accounts.clone()
    }

    /// The user's plan sign-ins, for the features that act on their behalf.
    pub fn plan_access(&self) -> Arc<dyn PlanAccess> {
        self.accounts.clone()
    }

    /// The session service: starting agents, talking to them, ending them.
    pub fn sessions(&self) -> Sessions {
        self.sessions.clone()
    }

    /// What start-up did to the worker rows the last run left behind.
    pub fn reconciled(&self) -> Reconciled {
        self.reconciled
    }

    /// The plugin system, as the agent tools and session start ask it.
    pub fn plugins(&self) -> Arc<dyn Plugins> {
        self.plugins.clone()
    }

    /// Stops the modules (last first) and the streams inside `deadline`, then
    /// waits for every write already queued and folds the WAL into the file.
    pub async fn shutdown(&self, deadline: Duration) -> ShutdownReport {
        let report = self.runtime.shutdown(deadline).await;
        let store = self.store.clone();
        match tokio::task::spawn_blocking(move || store.drain()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::error!(error = %e, "the database did not drain"),
            Err(e) => tracing::error!(error = %e, "draining the database panicked"),
        }
        report
    }
}
