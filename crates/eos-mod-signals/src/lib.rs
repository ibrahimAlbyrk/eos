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
//! until the model's stage (`ask`) settles it. Outside the installed app a match starts nothing: it is
//! `held-dev`. The router starts once the app is ready, routing what a
//! crash left undecided, and wakes on each ingest.
//!
//! The scheduler (`scheduler`) fires each schedule's slots once, also
//! after a sleep or a closed app; it passes at least once a minute and at
//! once on `system:wake`, `routine:change` and `run:change`. Each pass
//! also polls the capability sources the routines read that are due
//! (`polls`), on each source's own clock, with backoff after failures, and
//! keeps the runs that finished of the routines another one waits on
//! (`after`): a run's change starts a pass. It also reads the folders and
//! branches on this computer the routines watch (`local`), at once when
//! their watcher reports a change.
//!
//! The routes (`routes`) show what starts each routine's runs, list the
//! signals, replay some through the run intake and preview a schedule or a
//! Which.
//!
//! The app keeps working while routines run or wait for a slot, and with
//! the user's setting the computer stays awake on mains power for schedules
//! (`awake`); taking the notice that offers it turns the setting on.
//!
//! While Needs you's stop switch is on (`inbox:halt`) no source polls, no
//! schedule fires and the router decides nothing: signals wait `received`.
//! Switched off, the next pass catches up as after a wake.
//!
//! Outside services that push (a repository's webhook) reach a source
//! through a hook of this computer's relay inbox (`push`): an event is only
//! a hint to poll, or a push-only source's signal, once the source checked
//! its signature.
//!
//! Changes are announced on `signals:change`; each new version of a
//! subject on `signals:subject`. Keys, subjects, scopes and
//! facts are the user's data: logs carry ids, kinds, decisions and counts.

mod after;
mod ask;
mod awake;
mod batch;
mod holding;
mod ingest;
mod limits;
mod local;
mod moves;
mod polls;
mod push;
mod retention;
mod router;
mod routes;
mod runner;
mod scheduler;
mod sources;
mod summary;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::stream::topics::{FS_CHANGE, GIT_CHANGE, SYSTEM_WAKE};
use eos_contracts::{
    FsChangeEvent, GitChangeEvent, GitChangeKind, HaltState, InboxChange, SignalChange, SignalSubject,
};
use eos_core::agent::OneShot;
use eos_core::capability::CapabilityHealth;
use eos_core::git::{GitInfo, GitWatcher};
use eos_core::net::hooks::HookInbox;
use eos_core::os::{FileSystem, FileWatcher, Power, TimeZone, WorkHold, ZoneRules};
use eos_core::routine::{RoutineControl, RoutineDirectory, RunIntake};
use eos_core::signals::{PollPage, Runner, SignalSources};
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError, ProtectedSettings};
use eos_runtime::router::RouteDef;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::awake::{Awake, AwakeParts, KEEP_AWAKE};
use crate::local::Local;
use crate::polls::Polls;
use crate::push::Push;
use crate::router::Router;
use crate::scheduler::Scheduler;

pub use ask::{ASK_CACHE_MS, ASK_TIMEOUT_MS, ASKS_AT_ONCE, ASKS_PER_DAY, FACTS_TEXT_MAX, UNSORTED_AFTER_MS};
pub use awake::OFFER_LATE_MS;
pub use holding::FIRST_READ_WAIT_MS;
pub use local::{FOLDER_ENTRIES_MAX, FOLDER_LISTING_MS, FOLDER_SETTLE_MS, FOLDERS_MAX, GIT_PATHS_MAX};
pub use moves::AWAY_MS;
pub use polls::{
    BACKOFF_MS, CATCH_UP_GAP_MS, LONG_SLOTS, PAGES_MAX, POLL_MAX_MS, POLL_MIN_MS, POLL_TIMEOUT_MS, SHORT_SLOTS,
    WAKE_GRACE_MS, WAKE_RETRY_MS,
};
pub use push::{PUSH_BACKOFF_MS, PUSH_IDLE_MS, PUSH_WAIT_MS};
pub use retention::{FACTS_KEPT_MS, ROWS_KEPT_MS, ROWS_MAX, SWEEP_EVERY_MS, SWEEP_ROWS};
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
    /// This computer's hook inbox on the relay; none where nothing may
    /// reach it.
    pub hooks: Option<Arc<dyn HookInbox>>,
    /// Told when a source lost its sign-in.
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
    /// Keeps the app working while routines run or wait.
    pub hold: Arc<dyn WorkHold>,
    /// Whether the computer draws mains power, for keeping it awake.
    pub power: Arc<dyn Power>,
    /// The user's settings: keeping the computer awake for schedules.
    pub settings: Arc<dyn UserSettingsStore>,
    /// The model the stage of Which asks whether an item fits a routine.
    pub one_shot: Arc<dyn OneShot>,
    pub prompts: Arc<eos_prompts::PromptService>,
    /// The model prices, for what an ask cost.
    pub config: Arc<dyn ConfigSource>,
    /// Watches the folders routines read.
    pub files: Arc<dyn FileWatcher>,
    /// Watches the repositories routines read.
    pub git: Arc<dyn GitWatcher>,
    /// Reads a watched branch's commits.
    pub git_info: Arc<dyn GitInfo>,
    /// Lists a watched folder.
    pub disk: Arc<dyn FileSystem>,
    /// Eos's own data folder, which no routine may watch.
    pub data_dir: std::path::PathBuf,
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
/// `sync:change` follows each pass of sync, which reads the leases.
const KICKS: [&str; 5] = [SYSTEM_WAKE, "routine:change", "run:change", INBOX_HALT, "sync:change"];

pub struct SignalsModule {
    parts: SignalsParts,
    router: Arc<Router>,
    scheduler: Arc<Scheduler>,
    push: Option<Arc<Push>>,
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
            holding: Arc::new(holding::Holding::new(parts.runner.clone(), parts.clock.clone())),
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
            asks: ask::Asks::new(parts.one_shot.clone(), parts.prompts.clone(), parts.config.clone()),
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
        let awake = Arc::new(Awake::new(AwakeParts {
            hold: parts.hold.clone(),
            power: parts.power.clone(),
            settings: parts.settings.clone(),
            store: parts.store.clone(),
            runner: parts.runner.clone(),
            directory: parts.directory.clone(),
        }));
        let local = Arc::new(Local {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            ids: parts.ids.clone(),
            router: router.clone(),
            files: parts.files.clone(),
            git: parts.git.clone(),
            git_info: parts.git_info.clone(),
            disk: parts.disk.clone(),
            data_dir: parts.data_dir.clone(),
            leases: Mutex::default(),
            changed: Mutex::default(),
            settling: Mutex::default(),
        });
        let scheduler = Arc::new(Scheduler {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            sleeper: parts.sleeper.clone(),
            ids: parts.ids.clone(),
            zones: parts.zones.clone(),
            router: router.clone(),
            polls: polls.clone(),
            local,
            awake,
            swept_at: AtomicI64::new(i64::MIN / 2),
            reported_at: AtomicI64::new(i64::MIN / 2),
            kick,
        });
        let push = parts.hooks.clone().map(|inbox| {
            Arc::new(Push {
                store: parts.store.clone(),
                clock: parts.clock.clone(),
                sleeper: parts.sleeper.clone(),
                ids: parts.ids.clone(),
                sources: parts.sources.clone(),
                inbox,
                router: router.clone(),
                polls,
                kick: Notify::new(),
            })
        });
        Self { parts, router, scheduler, push, running: Mutex::new(None) }
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

    /// Has the service of the source row `source_id` push its events to
    /// this computer (see `POST /api/signals/sources/:sourceId/push`).
    pub async fn add_push(&self, source_id: &str) -> Result<(), Error> {
        let push = self.push.as_ref().ok_or_else(|| Error::Unreachable("no hook inbox in this run of Eos".into()))?;
        push.add(source_id).await.map(drop)
    }
}

impl SignalsModule {
    /// From now on, the answers to the signals' notices are acted on as
    /// `inbox:change` announces them; and once now, for those given while
    /// Eos was not listening. A setting turned on is applied by the next
    /// scheduler pass.
    fn hear_answers(&self) -> Subscription {
        let (awake, kick, clock) =
            (self.scheduler.awake.clone(), self.scheduler.kick.clone(), self.parts.clock.clone());
        let act = move || {
            let (awake, kick, now) = (awake.clone(), kick.clone(), clock.now_ms());
            async move {
                match awake.answered(now).await {
                    Ok(true) => kick.notify_one(),
                    Ok(false) => {}
                    Err(error) => tracing::warn!(%error, "the answers to the signals' notices could not be read"),
                }
            }
        };
        tokio::spawn(act());
        let tasks = tokio::runtime::Handle::current();
        self.parts.bus.on(eos_inbox::INBOX_CHANGE, move |event| {
            let answered = event.payload_as::<InboxChange>().is_ok_and(|change| change.state == "answered");
            if answered {
                tasks.spawn(act());
            }
        })
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
            settings: parts.settings.clone(),
            kick: self.scheduler.kick.clone(),
            push: self.push.clone(),
            sources: parts.sources.clone(),
            router: self.router.clone(),
            ids: parts.ids.clone(),
        })
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(ProtectedSettings { keys: vec![KEEP_AWAKE], via: "PUT /api/signals/settings" })
    }

    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let kicks = KICKS.map(|topic| {
            let scheduler = self.scheduler.clone();
            self.parts.bus.on(topic, move |event| {
                // Resuming catches up as a wake does.
                let resumed = topic == INBOX_HALT && event.payload_as::<HaltState>().is_ok_and(|halt| !halt.on);
                if topic == SYSTEM_WAKE || resumed {
                    scheduler.polls.woke();
                    scheduler.router.holding.woke();
                    scheduler.awake.woke.store(true, Ordering::SeqCst);
                }
                scheduler.kick.notify_one();
            })
        });
        let local = self.scheduler.local.clone();
        let scheduler = self.scheduler.clone();
        let files = self.parts.bus.on(FS_CHANGE, move |event| {
            let Ok(batch) = event.payload_as::<FsChangeEvent>() else { return };
            let mut dirs: Vec<&str> = batch.changes.iter().map(|change| change.dir.as_str()).collect();
            dirs.dedup();
            if dirs.into_iter().filter(|dir| local.changed(std::path::Path::new(dir))).count() > 0 {
                scheduler.kick.notify_one();
            }
        });
        let (local, scheduler) = (self.scheduler.local.clone(), self.scheduler.clone());
        let git = self.parts.bus.on(GIT_CHANGE, move |event| {
            let Ok(change) = event.payload_as::<GitChangeEvent>() else { return };
            let moved = change.kinds.iter().any(|kind| matches!(kind, GitChangeKind::Head | GitChangeKind::Refs));
            if moved && local.changed(std::path::Path::new(&change.dir)) {
                scheduler.kick.notify_one();
            }
        });
        let answers = self.hear_answers();
        let mut tasks = vec![tokio::spawn(self.router.clone().run()), tokio::spawn(self.scheduler.clone().run())];
        tasks.extend(self.push.clone().map(|push| tokio::spawn(push.run())));
        let running = Running { tasks, _kicks: kicks, _local: [files, git], _answers: answers };
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
            // The last heartbeat says how far this computer got before it quit.
            self.scheduler.report().await;
            self.scheduler.polls.stop().await;
            self.scheduler.local.release();
            self.scheduler.awake.release();
        })
    }
}

/// What runs between `after_ready` and `stop`.
struct Running {
    tasks: Vec<JoinHandle<()>>,
    _kicks: [Subscription; 5],
    /// The watchers' changes to the folders and branches read here.
    _local: [Subscription; 2],
    /// The user's answers to the signals' notices.
    _answers: Subscription,
}
