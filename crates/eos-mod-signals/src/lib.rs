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
//! once on `system:wake`, `routine:change` and `run:change`. Each pass
//! also polls the capability sources the routines read that are due
//! (`polls`), on each source's own clock, with backoff after failures, and
//! keeps the runs that finished of the routines another one waits on
//! (`after`): a run's change starts a pass.
//!
//! The routes (`routes`) show what starts each routine's runs, list the
//! signals, replay some through the run intake and preview a schedule or a
//! Which.
//!
//! While Needs you's stop switch is on (`inbox:halt`) no source polls, no
//! schedule fires and the router decides nothing: signals wait `received`.
//! Switched off, the next pass catches up as after a wake.
//!
//! Changes are announced on `signals:change`; each new version of a
//! subject on `signals:subject`. Keys, subjects, scopes and
//! facts are the user's data: logs carry ids, kinds, decisions and counts.

mod after;
mod batch;
mod ingest;
mod limits;
mod polls;
mod router;
mod routes;
mod runner;
mod scheduler;
mod sources;

use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::stream::topics::SYSTEM_WAKE;
use eos_contracts::{HaltState, SignalChange, SignalSubject};
use eos_core::capability::CapabilityHealth;
use eos_core::os::{TimeZone, ZoneRules};
use eos_core::routine::{RoutineControl, RoutineDirectory, RunIntake};
use eos_core::signals::{PollPage, Runner, SignalSources};
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::polls::Polls;
use crate::router::Router;
use crate::scheduler::Scheduler;

pub use polls::{
    BACKOFF_MS, CATCH_UP_GAP_MS, LONG_SLOTS, PAGES_MAX, POLL_MAX_MS, POLL_MIN_MS, POLL_TIMEOUT_MS, SHORT_SLOTS,
    WAKE_GRACE_MS, WAKE_RETRY_MS,
};
pub use runner::SoloRunner;
pub use scheduler::SCHEDULER_MAX_SLEEP_MS;

pub const SIGNALS_CHANGE: Topic<SignalChange> = Topic::new("signals:change");
/// A new version of a subject came in, or it ended.
pub const SIGNALS_SUBJECT: Topic<SignalSubject> = Topic::new("signals:subject");
/// Needs you's stop switch, heard by name.
const INBOX_HALT: &str = "inbox:halt";

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
    /// Told when a source lost its sign-in or what it reads.
    pub health: Arc<dyn CapabilityHealth>,
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
const KICKS: [&str; 4] = [SYSTEM_WAKE, "routine:change", "run:change", INBOX_HALT];

pub struct SignalsModule {
    parts: SignalsParts,
    router: Arc<Router>,
    scheduler: Arc<Scheduler>,
    /// The router's and the scheduler's tasks, and the bus subscriptions
    /// that kick the scheduler, while the module runs.
    running: Mutex<Option<Running>>,
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
            sources: parts.sources.clone(),
            autostart: parts.autostart,
            kick: Notify::new(),
            ids: parts.ids.clone(),
            zone: parts.zone.clone(),
            control: parts.control.clone(),
            failed: Mutex::default(),
            backed_up: AtomicBool::new(false),
        });
        let kick = Arc::new(Notify::new());
        let polls = Arc::new(Polls {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            sleeper: parts.sleeper.clone(),
            ids: parts.ids.clone(),
            sources: parts.sources.clone(),
            health: parts.health.clone(),
            router: router.clone(),
            kick: kick.clone(),
            short: Arc::new(Semaphore::new(SHORT_SLOTS)),
            long: Arc::new(Semaphore::new(LONG_SLOTS)),
            polling: Mutex::default(),
            tasks: Mutex::default(),
            woke_at: AtomicI64::new(i64::MIN / 2),
        });
        let scheduler = Arc::new(Scheduler {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            sleeper: parts.sleeper.clone(),
            ids: parts.ids.clone(),
            zones: parts.zones.clone(),
            runner: parts.runner.clone(),
            router: router.clone(),
            polls,
            kick,
        });
        Self { parts, router, scheduler, running: Mutex::new(None) }
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
        self.router.ingest(source_id, page).await
    }
}

impl Module for SignalsModule {
    fn id(&self) -> &'static str {
        "signals"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![SIGNALS_CHANGE.decl(), SIGNALS_SUBJECT.decl()]
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
            self.parts.bus.on(topic, move |event| {
                // Resuming catches up as a wake does.
                let resumed = topic == INBOX_HALT && event.payload_as::<HaltState>().is_ok_and(|halt| !halt.on);
                if topic == SYSTEM_WAKE || resumed {
                    scheduler.polls.woke();
                }
                scheduler.kick.notify_one();
            })
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
            self.scheduler.polls.stop().await;
        })
    }
}

/// What runs between `after_ready` and `stop`.
struct Running {
    tasks: [JoinHandle<()>; 2],
    _kicks: [Subscription; 4],
}
