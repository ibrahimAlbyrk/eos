//! The micro-task runner: small model requests with a fixed prompt, triggered
//! off the event bus.
//!
//! Each enabled task's trigger topic is followed; a run per (task, entity) is
//! armed once, waits the task's delay, then goes through gate → extract →
//! render → one model request → apply. Everything fails closed: a failing
//! step is logged, never repeated, and an entity is handled at most once.
//!
//! A run can be paused while a competing intent is in flight (the user is
//! renaming the same chat); a pause whose resume is lost ends by itself after
//! `microTasks.pauseMaxMs`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::stream::topics::WORKER_EXIT;
use eos_core::agent::{OneShot, OneShotRequest};
use eos_core::store::ConfigSource;
use eos_core::{BoxFuture, Clock, Error, Sleeper};
use eos_domain::config::MicroTask as TaskConfig;
use eos_prompts::PromptService;
use eos_prompts::templates::micro_task;
use eos_runtime::bus::{Bus, Subscription};
use eos_runtime::router::PluginSwitch;
use serde_json::Value;
use tokio::runtime::Handle;

/// One request may take this long.
const REQUEST_TIMEOUT_MS: i64 = 120_000;
/// Handled (task, entity) pairs remembered, at most; the oldest are forgotten
/// first, and a forgotten one is judged by its gate again.
const MAX_SEEN: usize = 4096;

/// The values a task's prompt is rendered with, by the names it declares.
pub type PromptValues = Vec<(&'static str, String)>;

/// One micro-task: trigger → gate → extract → apply.
pub trait MicroTask: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    /// The library prompt its request is rendered from.
    fn prompt_id(&self) -> &'static str;
    /// The built-in plugin that switches it off, if any.
    fn plugin(&self) -> Option<&'static str> {
        None
    }
    /// The bus topic that may trigger it.
    fn topic(&self) -> &'static str;
    /// The entity an event of that topic is about, or `None` to ignore it.
    fn matches(&self, payload: &Value) -> Option<String>;
    /// A cheap precondition, checked when the run is armed and again before it fires.
    fn gate<'a>(&'a self, entity: &'a str) -> BoxFuture<'a, Result<bool, Error>>;
    /// The values the prompt is rendered with, or `None` to give up.
    fn extract<'a>(&'a self, entity: &'a str) -> BoxFuture<'a, Result<Option<PromptValues>, Error>>;
    /// Takes the model's answer.
    fn apply<'a>(&'a self, entity: &'a str, output: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}

/// What the runner is built from.
#[derive(Clone)]
pub struct RunnerParts {
    pub bus: Bus,
    pub one_shot: Arc<dyn OneShot>,
    pub prompts: Arc<PromptService>,
    pub config: Arc<dyn ConfigSource>,
    pub plugins: Arc<dyn PluginSwitch>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
}

impl std::fmt::Debug for RunnerParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunnerParts").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Scheduled,
    Paused,
}

struct Run {
    phase: Phase,
    remaining_ms: i64,
    deadline: i64,
    /// Which timer speaks for this run: an older one finds a newer number and does nothing.
    timer: u64,
}

/// `(task, entity)`.
type Key = (&'static str, String);

#[derive(Default)]
struct State {
    runs: HashMap<Key, Run>,
    /// Fired, refused by its gate, or cancelled: never acted on again.
    seen: HashSet<Key>,
    seen_order: VecDeque<Key>,
    /// A pause that arrived before the trigger.
    paused: HashSet<Key>,
    timers: u64,
    subscriptions: Vec<Subscription>,
}

impl State {
    fn mark_seen(&mut self, key: &Key) {
        if self.seen.insert(key.clone()) {
            self.seen_order.push_back(key.clone());
            while self.seen_order.len() > MAX_SEEN {
                if let Some(oldest) = self.seen_order.pop_front() {
                    self.seen.remove(&oldest);
                }
            }
        }
    }

    fn next_timer(&mut self) -> u64 {
        self.timers += 1;
        self.timers
    }
}

struct Inner {
    parts: RunnerParts,
    tasks: Vec<Arc<dyn MicroTask>>,
    state: Mutex<State>,
}

/// Cheap to clone.
#[derive(Clone)]
pub struct MicroTasks(Arc<Inner>);

impl std::fmt::Debug for MicroTasks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MicroTasks").field("tasks", &self.0.tasks.len()).finish_non_exhaustive()
    }
}

impl MicroTasks {
    pub fn new(parts: RunnerParts, tasks: Vec<Arc<dyn MicroTask>>) -> Self {
        Self(Arc::new(Inner { parts, tasks, state: Mutex::default() }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn task(&self, id: &str) -> Option<&Arc<dyn MicroTask>> {
        self.0.tasks.iter().find(|task| task.id() == id)
    }

    fn config_for(&self, task: &str) -> Option<TaskConfig> {
        self.0.parts.config.current().micro_tasks.tasks.get(task).cloned()
    }

    fn enabled(&self, task: &str) -> bool {
        self.0.parts.config.current().micro_tasks.enabled && self.config_for(task).is_some_and(|c| c.enabled)
    }

    /// Follows every enabled task's trigger topic. Call inside the app's runtime.
    pub fn start(&self) {
        let Ok(tasks) = Handle::try_current() else { return };
        let mut subscriptions = Vec::new();
        for task in &self.0.tasks {
            if !self.config_for(task.id()).is_some_and(|c| c.enabled) {
                continue;
            }
            let (runner, task, spawner) = (self.clone(), task.clone(), tasks.clone());
            subscriptions.push(self.0.parts.bus.on(task.topic(), move |event| {
                let Ok(payload) = event.payload_as::<Value>() else { return };
                let Some(entity) = task.matches(&payload) else { return };
                let (runner, task) = (runner.clone(), task.clone());
                // Off the lane: arming reads the database.
                spawner.spawn(async move { runner.on_trigger(task, entity).await });
            }));
        }
        let runner = self.clone();
        subscriptions.push(self.0.parts.bus.on(WORKER_EXIT, move |event| {
            let Ok(payload) = event.payload_as::<Value>() else { return };
            if let Some(entity) = payload["workerId"].as_str() {
                runner.forget_entity(entity);
            }
        }));
        let mut state = self.state();
        if state.subscriptions.is_empty() {
            state.subscriptions = subscriptions;
        }
    }

    /// Stops following the bus and drops every pending run.
    pub fn stop(&self) {
        let mut state = self.state();
        state.subscriptions.clear();
        state.runs.clear();
    }

    async fn passes(&self, task: &Arc<dyn MicroTask>, entity: &str) -> Result<bool, Error> {
        if task.plugin().is_some_and(|plugin| !self.0.parts.plugins.is_on(plugin)) {
            return Ok(false);
        }
        task.gate(entity).await
    }

    async fn on_trigger(&self, task: Arc<dyn MicroTask>, entity: String) {
        let key: Key = (task.id(), entity);
        let known = |state: &State| state.seen.contains(&key) || state.runs.contains_key(&key);
        if known(&self.state()) || !self.enabled(task.id()) {
            return;
        }
        let pass = match self.passes(&task, &key.1).await {
            Ok(pass) => pass,
            Err(error) => {
                // A precondition that fails to answer is final: the entity is not tried again.
                tracing::warn!(task = task.id(), entity = %key.1, %error, "a micro-task's gate failed");
                false
            }
        };
        let mut state = self.state();
        if !pass {
            state.mark_seen(&key);
            return;
        }
        // An exit or a cancel may have come while the gate was asked.
        if known(&state) {
            return;
        }
        let delay = self.config_for(task.id()).map_or(0, |c| c.delay_ms);
        if state.paused.contains(&key) {
            // Paused before it was ever armed: the whole delay starts at its resume.
            let timer = state.next_timer();
            state.runs.insert(key.clone(), Run { phase: Phase::Paused, remaining_ms: delay, deadline: 0, timer });
            drop(state);
            self.arm_pause(key, timer);
        } else {
            self.schedule(&mut state, key, delay);
        }
    }

    fn schedule(&self, state: &mut State, key: Key, ms: i64) {
        let timer = state.next_timer();
        let deadline = self.0.parts.clock.now_ms() + ms;
        state.runs.insert(key.clone(), Run { phase: Phase::Scheduled, remaining_ms: ms, deadline, timer });
        let (runner, sleeping) = (self.clone(), self.0.parts.sleeper.sleep(ms));
        if let Ok(tasks) = Handle::try_current() {
            tasks.spawn(async move {
                sleeping.await;
                runner.fire(key, timer).await;
            });
        }
    }

    /// A pause ends by itself: a lost resume cannot hold a run forever.
    fn arm_pause(&self, key: Key, timer: u64) {
        let max = self.0.parts.config.current().micro_tasks.pause_max_ms;
        let (runner, sleeping) = (self.clone(), self.0.parts.sleeper.sleep(max));
        if let Ok(tasks) = Handle::try_current() {
            tasks.spawn(async move {
                sleeping.await;
                let still = runner.state().runs.get(&key).is_some_and(|run| run.timer == timer);
                if still {
                    runner.resume(key.0, &key.1);
                }
            });
        }
    }

    /// Holds the entity's run of `task`; one that is not armed yet starts paused.
    pub fn pause(&self, task: &str, entity: &str) {
        let Some(task) = self.task(task).map(|t| t.id()) else { return };
        let key: Key = (task, entity.to_owned());
        let mut state = self.state();
        let now = self.0.parts.clock.now_ms();
        let timer = state.next_timer();
        match state.runs.get_mut(&key) {
            None => {
                state.paused.insert(key);
            }
            Some(run) if run.phase == Phase::Paused => {}
            Some(run) => {
                run.remaining_ms = (run.deadline - now).max(0);
                run.phase = Phase::Paused;
                run.timer = timer;
                drop(state);
                self.arm_pause(key, timer);
            }
        }
    }

    /// Lets a paused run wait out what was left of its delay.
    pub fn resume(&self, task: &str, entity: &str) {
        let Some(task) = self.task(task).map(|t| t.id()) else { return };
        let key: Key = (task, entity.to_owned());
        let mut state = self.state();
        state.paused.remove(&key);
        let remaining = state.runs.get(&key).filter(|run| run.phase == Phase::Paused).map(|run| run.remaining_ms);
        if let Some(remaining) = remaining {
            self.schedule(&mut state, key, remaining);
        }
    }

    /// Drops the entity's run of `task` for good.
    pub fn cancel(&self, task: &str, entity: &str, reason: &str) {
        let Some(task) = self.task(task).map(|t| t.id()) else { return };
        let key: Key = (task, entity.to_owned());
        let mut state = self.state();
        state.runs.remove(&key);
        state.paused.remove(&key);
        state.mark_seen(&key);
        tracing::debug!(task, entity, reason, "micro-task cancelled");
    }

    /// The entity is gone: its pending runs go with it.
    fn forget_entity(&self, entity: &str) {
        let mut state = self.state();
        state.runs.retain(|key, _| key.1 != entity);
        state.paused.retain(|key| key.1 != entity);
    }

    async fn fire(&self, key: Key, timer: u64) {
        {
            let mut state = self.state();
            let due = state.runs.get(&key).is_some_and(|run| run.timer == timer && run.phase == Phase::Scheduled);
            if !due {
                return;
            }
            state.runs.remove(&key);
            // At most one run per (task, entity), however it ends.
            state.mark_seen(&key);
        }
        let Some(task) = self.task(key.0).cloned() else { return };
        if let Err(error) = self.run(&task, &key.1).await {
            tracing::warn!(task = key.0, entity = %key.1, %error, "a micro-task failed");
        }
    }

    async fn run(&self, task: &Arc<dyn MicroTask>, entity: &str) -> Result<(), Error> {
        if !self.passes(task, entity).await? {
            return Ok(());
        }
        let Some(values) = task.extract(entity).await? else { return Ok(()) };
        let Some(config) = self.config_for(task.id()) else { return Ok(()) };
        let pairs: Vec<(&str, &str)> = values.iter().map(|(name, value)| (*name, value.as_str())).collect();
        let prompt =
            micro_task::request(&self.0.parts.prompts, task.prompt_id(), config.prompt_template.as_deref(), &pairs)?;
        let request = OneShotRequest::new(prompt).model(Some(&config.model)).timeout_ms(REQUEST_TIMEOUT_MS);
        let answer = self.0.parts.one_shot.complete(request).await.map_err(|e| Error::Unreachable(e.to_string()))?;
        task.apply(entity, &answer.text).await
    }

    /// Pending runs: armed or paused.
    pub fn pending(&self) -> usize {
        self.state().runs.len()
    }
}
