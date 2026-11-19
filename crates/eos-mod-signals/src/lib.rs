//! Signals: what starts a routine's runs.
//!
//! A signal is one thing a source saw (a pull request opened, a run started
//! by hand). Which computer acts on a routine's signals is the [`Runner`]'s
//! to say; [`SoloRunner`] holds every routine here.
//!
//! A source's page enters through [`SignalsModule::ingest`]: its signals are
//! kept once and the source's cursor moves with them. The router then
//! decides each signal for every routine held here whose When reads that
//! source: its Which rules over the signal's facts, and for a match the run,
//! admitted in the same write that keeps the decision, so a signal starts at
//! most one run of a routine whatever crashes between. A rule that fails
//! keeps its index; a question for the model leaves the signal undecided
//! for now. Outside the installed app a match starts nothing: it is
//! `held-dev`. The router starts once the app is ready, routing what a
//! crash left undecided, and wakes on each ingest.
//!
//! Changes are announced on `signals:change`. Keys, subjects, scopes and
//! facts are the user's data: logs carry ids, kinds, decisions and counts.

mod router;
mod runner;

use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::SignalChange;
use eos_core::os::ZoneRules;
use eos_core::routine::{RoutineDirectory, RunIntake};
use eos_core::signals::{PollPage, Runner, SignalSources};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_runtime::bus::{Bus, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::router::{Router, ingest_in};

pub use runner::SoloRunner;

pub const SIGNALS_CHANGE: Topic<SignalChange> = Topic::new("signals:change");

/// What the module is built from.
pub struct SignalsParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The rules of the time zones schedules name.
    pub zones: Arc<dyn ZoneRules>,
    /// The sources the capabilities declare.
    pub sources: Arc<dyn SignalSources>,
    pub runner: Arc<dyn Runner>,
    /// Admits the runs signals start, inside the routing write.
    pub intake: Arc<dyn RunIntake>,
    /// What starts each routine's runs.
    pub directory: Arc<dyn RoutineDirectory>,
    pub bus: Bus,
    /// Whether a matched signal starts its run by itself: true only in the
    /// installed app.
    pub autostart: bool,
}

impl std::fmt::Debug for SignalsParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalsParts").field("autostart", &self.autostart).finish_non_exhaustive()
    }
}

pub struct SignalsModule {
    parts: SignalsParts,
    router: Arc<Router>,
    routing: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for SignalsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalsModule").field("autostart", &self.parts.autostart).finish_non_exhaustive()
    }
}

impl SignalsModule {
    pub fn new(parts: SignalsParts) -> Self {
        let router = Arc::new(Router {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            runner: parts.runner.clone(),
            intake: parts.intake.clone(),
            directory: parts.directory.clone(),
            autostart: parts.autostart,
            kick: Notify::new(),
        });
        Self { parts, router, routing: Mutex::new(None) }
    }

    fn routing(&self) -> MutexGuard<'_, Option<JoinHandle<()>>> {
        self.routing.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keeps one page a source answered for the source row `source_id`, in
    /// one write with its cursor, and wakes the router. Answers how many of
    /// its signals were new.
    pub async fn ingest(&self, source_id: &str, page: PollPage) -> Result<usize, Error> {
        let (source_id, now) = (source_id.to_owned(), self.parts.clock.now_ms());
        let fresh = self.parts.store.write(move |tx, _| ingest_in(tx, &source_id, &page, now)).await?;
        self.router.kick.notify_one();
        Ok(fresh)
    }
}

impl Module for SignalsModule {
    fn id(&self) -> &'static str {
        "signals"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![SIGNALS_CHANGE.decl()]
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let task = tokio::spawn(self.router.clone().run());
        if let Some(previous) = self.routing().replace(task) {
            previous.abort();
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        let task = self.routing().take();
        Box::pin(async move {
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
        })
    }
}
