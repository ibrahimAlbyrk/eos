//! Start-up and shutdown, as named steps the app drives:
//!
//! ```text
//! build ──▶ start ──▶ ready ──▶ (deferred work, in the background) … shutdown
//! ```
//!
//! - **build**: the app constructs adapters, services and modules, and the
//!   runtime composes them. Nothing runs yet.
//! - **start**: every module's `start`, in composition order.
//! - **ready**: the app can take requests and owns the data folder; every
//!   module's `after_ready`, then the deferred tasks, one after another, off
//!   the start-up path (backup pruning, vacuum, sweeps).
//! - **shutdown**: modules stop in reverse order, inside one deadline.
//!
//! Every step is timed in the log.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;

use crate::error::{Error, panic_message};
use crate::module::{ModuleError, Modules};
use crate::router::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Built,
    Started,
    Ready,
    Stopped,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Built => "built",
            Phase::Started => "started",
            Phase::Ready => "ready",
            Phase::Stopped => "stopped",
        }
    }
}

type DeferredTask = Box<dyn FnOnce() -> BoxFuture<'static, Result<(), ModuleError>> + Send>;

struct State {
    phase: Phase,
    /// How many modules had `start` called (the ones shutdown must stop).
    started: usize,
    deferred: Vec<(&'static str, DeferredTask)>,
    deferred_run: Option<JoinHandle<()>>,
}

/// What shutdown managed inside its deadline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownReport {
    pub stopped: Vec<&'static str>,
    /// Modules whose `stop` did not finish in time (it was abandoned).
    pub timed_out: Vec<&'static str>,
    /// Modules never asked to stop: the deadline had already passed.
    pub skipped: Vec<&'static str>,
    pub took: Duration,
}

impl ShutdownReport {
    pub fn clean(&self) -> bool {
        self.timed_out.is_empty() && self.skipped.is_empty()
    }
}

pub struct Lifecycle {
    modules: Modules,
    state: Arc<Mutex<State>>,
}

impl std::fmt::Debug for Lifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lifecycle").field("phase", &self.phase()).field("modules", &self.modules).finish()
    }
}

impl Lifecycle {
    pub fn new(modules: Modules) -> Self {
        let state = State { phase: Phase::Built, started: 0, deferred: Vec::new(), deferred_run: None };
        Self { modules, state: Arc::new(Mutex::new(state)) }
    }

    // The state is a few plain fields: valid whatever panicked while it was held.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn phase(&self) -> Phase {
        self.state().phase
    }

    fn expect(&self, action: &'static str, wanted: Phase) -> Result<(), Error> {
        let phase = self.state().phase;
        if phase == wanted { Ok(()) } else { Err(Error::WrongPhase { action, phase: phase.name() }) }
    }

    /// Registers work that must not delay start-up: it runs after `ready`,
    /// in the order registered, one task at a time. A task that fails is
    /// logged and the next one runs.
    pub fn defer<F, Fut>(&self, name: &'static str, task: F) -> Result<(), Error>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), ModuleError>> + Send + 'static,
    {
        let mut state = self.state();
        if !matches!(state.phase, Phase::Built | Phase::Started) {
            return Err(Error::WrongPhase { action: "defer", phase: state.phase.name() });
        }
        state.deferred.push((name, Box::new(move || Box::pin(task()))));
        Ok(())
    }

    /// Starts every module, in order. A module that fails to start (a panic
    /// counts) does not keep the app from opening: it is recorded as failed —
    /// its routes answer 503, its hooks do not run, the user is told — and the
    /// next one starts. `shutdown` stops every module that was started.
    pub async fn start(&self) -> Result<(), Error> {
        self.expect("start", Phase::Built)?;
        let began = Instant::now();
        for module in self.modules.iter() {
            let step = Instant::now();
            self.state().started += 1;
            let outcome = match Guarded(module.start()).await {
                Ok(outcome) => outcome,
                Err(panic) => Err(format!("panicked: {panic}").into()),
            };
            tracing::info!(
                module = module.id(),
                micros = step.elapsed().as_micros() as u64,
                ok = outcome.is_ok(),
                "module started"
            );
            if let Err(e) = outcome {
                self.modules.failed().fail(module.id(), &e.to_string());
            }
        }
        self.state().phase = Phase::Started;
        tracing::info!(
            modules = self.modules.len(),
            micros = began.elapsed().as_micros() as u64,
            "start-up: modules started"
        );
        Ok(())
    }

    /// The app is ready: runs `after_ready` of every module that started (one
    /// that fails is recorded as failed, like a failed start), then sets the
    /// deferred tasks off in the background.
    pub async fn ready(&self) -> Result<(), Error> {
        self.expect("ready", Phase::Started)?;
        for module in self.modules.iter().filter(|m| !self.modules.failed().is_failed(m.id())) {
            let step = Instant::now();
            let outcome = match Guarded(module.after_ready()).await {
                Ok(outcome) => outcome,
                Err(panic) => Err(format!("panicked: {panic}").into()),
            };
            tracing::info!(
                module = module.id(),
                micros = step.elapsed().as_micros() as u64,
                ok = outcome.is_ok(),
                "module ready"
            );
            if let Err(e) = outcome {
                self.modules.failed().fail(module.id(), &e.to_string());
            }
        }
        let mut state = self.state();
        state.phase = Phase::Ready;
        let tasks = std::mem::take(&mut state.deferred);
        if !tasks.is_empty() {
            state.deferred_run = Some(tokio::spawn(run_deferred(tasks)));
        }
        drop(state);
        Ok(())
    }

    /// Waits for the deferred tasks to finish (tests, and tools that want a
    /// quiet app).
    pub async fn deferred_done(&self) {
        let run = self.state().deferred_run.take();
        if let Some(run) = run {
            let _ = run.await;
        }
    }

    /// Stops the modules that were started, last first, all inside
    /// `deadline`. A module still stopping when the time is up is abandoned
    /// and reported; deferred work still running is cancelled. Safe to call
    /// in any phase, once.
    pub async fn shutdown(&self, deadline: Duration) -> ShutdownReport {
        // The runtime's clock, so the budget and the timeouts below agree.
        let began = tokio::time::Instant::now();
        let started = {
            let mut state = self.state();
            if state.phase == Phase::Stopped {
                return ShutdownReport {
                    stopped: Vec::new(),
                    timed_out: Vec::new(),
                    skipped: Vec::new(),
                    took: Duration::ZERO,
                };
            }
            state.phase = Phase::Stopped;
            state.deferred.clear();
            if let Some(run) = state.deferred_run.take() {
                run.abort();
            }
            std::mem::take(&mut state.started)
        };
        let mut report =
            ShutdownReport { stopped: Vec::new(), timed_out: Vec::new(), skipped: Vec::new(), took: Duration::ZERO };
        for module in self.modules.iter().take(started).rev() {
            let Some(left) = deadline.checked_sub(began.elapsed()).filter(|left| !left.is_zero()) else {
                report.skipped.push(module.id());
                continue;
            };
            let step = Instant::now();
            let outcome = tokio::time::timeout(left, Guarded(module.stop())).await;
            match outcome {
                Ok(Ok(())) => report.stopped.push(module.id()),
                Ok(Err(panic)) => {
                    tracing::error!(module = module.id(), %panic, "module panicked while stopping");
                    report.stopped.push(module.id());
                }
                Err(_) => {
                    tracing::error!(module = module.id(), "module did not stop before the shutdown deadline");
                    report.timed_out.push(module.id());
                }
            }
            tracing::info!(module = module.id(), micros = step.elapsed().as_micros() as u64, "module stopped");
        }
        report.took = began.elapsed();
        report
    }
}

/// Polls a module's `start`, `after_ready` or `stop`, turning a panic into
/// an error: it never unwinds into whoever starts or stops the app.
struct Guarded<'a, T>(BoxFuture<'a, T>);

impl<T> Future for Guarded<'_, T> {
    type Output = Result<T, String>;

    fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.0.as_mut().poll(cx))) {
            Ok(poll) => poll.map(Ok),
            Err(payload) => std::task::Poll::Ready(Err(panic_message(payload.as_ref()))),
        }
    }
}

async fn run_deferred(tasks: Vec<(&'static str, DeferredTask)>) {
    for (name, task) in tasks {
        let step = Instant::now();
        // Each task gets its own task: a panic fails that one only.
        let outcome = tokio::spawn(async move { task().await }).await;
        let micros = step.elapsed().as_micros() as u64;
        match outcome {
            Ok(Ok(())) => tracing::info!(task = name, micros, "deferred start-up task done"),
            Ok(Err(e)) => tracing::warn!(task = name, micros, error = %e, "deferred start-up task failed"),
            Err(e) => tracing::error!(task = name, micros, error = %e, "deferred start-up task panicked"),
        }
    }
}

#[cfg(test)]
mod tests;
