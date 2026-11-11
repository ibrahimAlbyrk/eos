//! Building the app from a data folder, and running it.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_config::{ConfigFile, SettingsFile, env_from_process};
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::{Clock, Ids, RandomIds, SystemClock};
use eos_domain::config::Env;
use eos_kit_sqlite::Db;
use eos_mod_system::RunInfo;
use eos_platform::DataPaths;
use eos_policy::{GatewayOptions, PolicyGateway};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::lifecycle::ShutdownReport;
use eos_runtime::router::{AllPluginsOn, Router};
use eos_runtime::stream::StreamOptions;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::Reconciled;
use eos_store_files::policy::YamlPolicyFile;
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::templates::FsTemplateStore;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_store_files::{CachedModelCatalog, JsonProjects, JsonRecents};
use eos_store_sqlite::{SqliteStore, StoreOptions};
use eos_workers::WorkerDefinitions;

use crate::Error;
use crate::agent::NoBackends;
use crate::announce::BusAnnouncer;
use crate::boot;
use crate::callers::Callers;
use crate::display::StripSenderTags;
use crate::host::{self, HostStats};
use crate::modules::{self, Context};
use crate::notes::{Notes, ProfilePrompt};

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
}

impl Options {
    /// The system clock, random ids and this process's environment.
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), clock: Arc::new(SystemClock), ids: Arc::new(RandomIds), env: env_from_process() }
    }
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options").field("home", &self.home).finish_non_exhaustive()
    }
}

/// Claude Code's plans folder: an agent may always write its plan there.
fn plans_dir() -> String {
    let claude_home = std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| "~/.claude".to_owned());
    PathBuf::from(eos_platform::expand_path(&claude_home)).join("plans").to_string_lossy().into_owned()
}

/// The running core: what the shell's bridge and the gateways hold.
pub struct App {
    runtime: Runtime,
    store: Arc<SqliteStore>,
    config: Arc<ConfigFile>,
    settings: Arc<SettingsFile>,
    callers: Callers,
    paths: DataPaths,
    reconciled: Reconciled,
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
        let Options { home, clock, ids, env } = options;
        let paths = DataPaths::new(&home);
        fs::create_dir_all(paths.home()).map_err(|source| Error::Home { path: paths.home().to_owned(), source })?;
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
        let store = Arc::new(SqliteStore::new(db, announcer, store_options));
        let reconciled = boot::settle(&store, clock.clone(), current.events.max_per_worker)?;

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

        let notes = Notes::open(&paths, &clock, store.clone(), config.clone());
        let profile_prompt = Arc::new(ProfilePrompt::new(notes.preview.clone()));

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
            models: Arc::new(CachedModelCatalog::open(&paths.join("models.json"))),
            backends: Arc::new(NoBackends),
            projects: Arc::new(JsonProjects::open(paths.join("projects.json"), ids)),
            recents: Arc::new(JsonRecents::open(paths.join("recents.json"))),
            policy,
            profile_prompt,
            prompts,
            templates,
            worker_definitions,
        };
        let runtime = Runtime::build(kernel, modules::all(&context), Arc::new(AllPluginsOn))?;
        if let Some((backup, dir)) = snapshot {
            // Thousands of small files: after the app is up, off the start-up path.
            runtime.lifecycle.defer("backup", move || async move {
                tokio::task::spawn_blocking(move || boot::finish_snapshot(&backup, &dir)).await??;
                Ok(())
            })?;
        }
        let settings = Arc::new(SettingsFile::new(paths.join("settings.json")));
        Ok(Self { runtime, store, config, settings, callers, paths, reconciled })
    }

    /// Starts every module, then tells them the app is ready.
    pub async fn start(&self) -> Result<(), Error> {
        self.runtime.lifecycle.start().await?;
        self.runtime.lifecycle.ready().await?;
        Ok(())
    }

    /// What answers requests. The caller of each request is set by whoever
    /// hands it over ([`callers`](Self::callers) for this computer's window).
    pub fn router(&self) -> Arc<Router> {
        self.runtime.router.clone()
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

    /// What start-up did to the worker rows the last run left behind.
    pub fn reconciled(&self) -> Reconciled {
        self.reconciled
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
