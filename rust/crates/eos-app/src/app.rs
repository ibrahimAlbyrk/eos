//! Building the app from a data folder, and running it.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_core::store::Store;
use eos_core::{Clock, Ids, RandomIds, SystemClock};
use eos_kit_sqlite::Db;
use eos_platform::DataPaths;
use eos_runtime::lifecycle::ShutdownReport;
use eos_runtime::router::{AllPluginsOn, Router};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_sqlite::{SqliteStore, StoreOptions};

use crate::Error;
use crate::announce::BusAnnouncer;
use crate::callers::Callers;
use crate::modules::{self, Context};

/// What the app is built from. Tests swap the clock and the id source.
#[derive(Clone)]
pub struct Options {
    /// The data folder (`~/.eos`).
    pub home: PathBuf,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
}

impl Options {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), clock: Arc::new(SystemClock), ids: Arc::new(RandomIds) }
    }
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options").field("home", &self.home).finish_non_exhaustive()
    }
}

/// The running core: what the shell's bridge and the gateways hold.
pub struct App {
    runtime: Runtime,
    store: Arc<SqliteStore>,
    callers: Callers,
    paths: DataPaths,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App").field("home", &self.paths.home()).field("runtime", &self.runtime).finish_non_exhaustive()
    }
}

impl App {
    /// Opens the data folder and composes the app. Nothing runs yet: call
    /// [`start`](Self::start). Blocks on file and database work.
    pub fn build(options: Options) -> Result<Self, Error> {
        let paths = DataPaths::new(&options.home);
        fs::create_dir_all(paths.home()).map_err(|source| Error::Home { path: paths.home().to_owned(), source })?;
        let callers = Callers::load(paths.home(), options.ids.as_ref());

        let (db, migrations) = Db::open(paths.state_db(), eos_kit_sqlite::Options::default(), options.clock.now_ms())?;
        if !migrations.unknown.is_empty() {
            tracing::info!(ids = ?migrations.unknown, "the database records migrations this build does not know; left alone");
        }

        let kernel = Kernel::new(KernelOptions {
            clock: options.clock.clone(),
            ids: options.ids.clone(),
            ..KernelOptions::default()
        });
        let announcer = Arc::new(BusAnnouncer(kernel.bus.clone()));
        let store = Arc::new(SqliteStore::new(db, announcer, StoreOptions::default()));

        let context = Context {
            kernel: kernel.clone(),
            paths: paths.clone(),
            clock: options.clock,
            ids: options.ids,
            store: store.clone(),
        };
        let runtime = Runtime::build(kernel, modules::all(&context), Arc::new(AllPluginsOn))?;
        Ok(Self { runtime, store, callers, paths })
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
