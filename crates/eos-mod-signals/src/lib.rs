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
//! The scheduler (`scheduler`) fires each schedule's slots once, also
//! after a sleep or a closed app; it passes at least once a minute and at
//! once on `system:wake`, `routine:change` and `run:change`.
//!
//! The routes (`routes`) show what starts each routine's runs, list the
//! signals, replay some through the run intake and preview a schedule or a
//! Which.
//!
//! Changes are announced on `signals:change`. Keys, subjects, scopes and
//! facts are the user's data: logs carry ids, kinds, decisions and counts.

mod batch;
mod limits;
mod router;
mod routes;
mod runner;
mod scheduler;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::SignalChange;
use eos_contracts::stream::topics::SYSTEM_WAKE;
use eos_core::os::{TimeZone, ZoneRules};
use eos_core::routine::{RoutineControl, RoutineDirectory, RunIntake};
use eos_core::signals::{PollPage, Runner, SignalSources};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::router::{Router, ingest_in};
use crate::scheduler::Scheduler;

pub use runner::SoloRunner;
pub use scheduler::SCHEDULER_MAX_SLEEP_MS;

pub const SIGNALS_CHANGE: Topic<SignalChange> = Topic::new("signals:change");

/// Past this many signals waiting to be routed, ingest refuses pages…
pub const BACKED_UP: i64 = 5_000;
/// …until fewer than this many wait.
pub const CAUGHT_UP: i64 = 1_000;

/// What the module is built from.
pub struct SignalsParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// What the scheduler waits on between passes.
    pub sleeper: Arc<dyn Sleeper>,
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
    /// Pauses a routine with too many items waiting, as Needs you's
    /// notices may.
    pub control: Arc<dyn RoutineControl>,
    /// The user's clock: one over-limit notice a local day.
    pub zone: Arc<dyn TimeZone>,
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

/// What starts a pass of the scheduler at once.
const KICKS: [&str; 3] = [SYSTEM_WAKE, "routine:change", "run:change"];

pub struct SignalsModule {
    parts: SignalsParts,
    router: Arc<Router>,
    scheduler: Arc<Scheduler>,
    /// The router's and the scheduler's tasks, and the bus subscriptions
    /// that kick the scheduler, while the module runs.
    running: Mutex<Option<Running>>,
    /// More signals wait to be routed than ingest takes more of.
    backed_up: AtomicBool,
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
            ids: parts.ids.clone(),
            zone: parts.zone.clone(),
            control: parts.control.clone(),
            failed: Mutex::default(),
        });
        let scheduler = Arc::new(Scheduler {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            sleeper: parts.sleeper.clone(),
            ids: parts.ids.clone(),
            zones: parts.zones.clone(),
            runner: parts.runner.clone(),
            router: router.clone(),
            kick: Notify::new(),
        });
        Self { parts, router, scheduler, running: Mutex::new(None), backed_up: AtomicBool::new(false) }
    }

    fn running(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keeps one page a source answered for the source row `source_id`, in
    /// one write with its cursor, and wakes the router. Answers how many of
    /// its signals were new. While more than [`BACKED_UP`] signals wait to
    /// be routed, pages are refused (429) until fewer than [`CAUGHT_UP`]
    /// wait: nothing is dropped, the source polls again from its cursor.
    pub async fn ingest(&self, source_id: &str, page: PollPage) -> Result<usize, Error> {
        let waiting = self.parts.store.read(|tx| tx.signals().received_count()).await?;
        let backed_up = self.backed_up.load(Ordering::SeqCst);
        if waiting > BACKED_UP || (backed_up && waiting >= CAUGHT_UP) {
            if !backed_up {
                tracing::warn!(waiting, "signals back up: sources wait until they are routed");
            }
            self.backed_up.store(true, Ordering::SeqCst);
            self.router.kick.notify_one();
            return Err(Error::LimitExceeded("too many signals wait to be routed".into()));
        }
        self.backed_up.store(false, Ordering::SeqCst);
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

    fn routes(&self) -> Vec<RouteDef> {
        let parts = &self.parts;
        routes::all(routes::Routes {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            zones: parts.zones.clone(),
            zone: parts.zone.clone(),
            runner: parts.runner.clone(),
            intake: parts.intake.clone(),
            directory: parts.directory.clone(),
        })
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let kicks = KICKS.map(|topic| {
            let scheduler = self.scheduler.clone();
            self.parts.bus.on(topic, move |_| scheduler.kick.notify_one())
        });
        let running = Running {
            tasks: [tokio::spawn(self.router.clone().run()), tokio::spawn(self.scheduler.clone().run())],
            _kicks: kicks,
        };
        if let Some(previous) = self.running().replace(running) {
            previous.tasks.iter().for_each(JoinHandle::abort);
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        let running = self.running().take();
        Box::pin(async move {
            if let Some(running) = running {
                for task in running.tasks {
                    task.abort();
                    let _ = task.await;
                }
            }
        })
    }
}

/// What runs between `after_ready` and `stop`.
struct Running {
    tasks: [JoinHandle<()>; 2],
    _kicks: [Subscription; 3],
}
