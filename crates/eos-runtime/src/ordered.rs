//! The ordered lane: one thread that runs state transitions one at a time, in
//! the order they were handed over.
//!
//! The TypeScript daemon got this for free from Node's single thread: nothing
//! could run between a state change and the event announcing it, and every
//! subscriber saw events in one order. Here the lane makes it explicit. The bus
//! delivers every event on it, so a transition that runs here and publishes is
//! ordered with every other transition and with every delivery.
//!
//! The API is two calls, [`Ordered::run`] and [`Ordered::post`], both taking a
//! plain closure: a lane job cannot `.await`, so it cannot hold the lane
//! across a suspension point. Jobs must not block (no I/O, no waiting on
//! another thread): everything ordered waits behind them.

use std::collections::{BinaryHeap, VecDeque};
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crate::error::{Error, panic_message};

type Job = Box<dyn FnOnce() + Send + 'static>;

enum Item {
    Job(Job),
    /// A timer was added from another thread: recompute the wait.
    Wake,
    Stop(oneshot::Sender<()>),
}

struct Timer {
    at: Instant,
    seq: u64,
    job: Job,
}

impl PartialEq for Timer {
    fn eq(&self, other: &Self) -> bool {
        self.at == other.at && self.seq == other.seq
    }
}
impl Eq for Timer {}
impl PartialOrd for Timer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Timer {
    // Reversed: the heap's top is the earliest timer, ties in arming order.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.at.cmp(&self.at).then(other.seq.cmp(&self.seq))
    }
}

#[derive(Default)]
struct Local {
    /// Jobs posted by a job: they run right after it, before anything queued
    /// by another thread.
    follow_ups: VecDeque<Job>,
    timers: BinaryHeap<Timer>,
    timer_seq: u64,
}

struct Core {
    thread: OnceLock<ThreadId>,
    local: Mutex<Local>,
    stopped: AtomicBool,
    capacity: usize,
    /// Jobs handed over from other threads that the lane has not taken yet (callers waiting
    /// for room included), and the most there ever were.
    queued: AtomicUsize,
    peak: AtomicUsize,
    /// Jobs that held the lane for [`SLOW_JOB`] or longer, and the longest one.
    slow: AtomicU64,
    slowest_us: AtomicU64,
}

/// A job that holds the lane this long delays every bus delivery behind it.
pub const SLOW_JOB: Duration = Duration::from_millis(5);
/// Slow jobs are logged at most this often; the line counts the ones in between.
const SLOW_LOG_EVERY: Duration = Duration::from_secs(1);

/// What the lane has done, for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneStats {
    pub queued: usize,
    pub peak_queued: usize,
    pub slow_jobs: u64,
    pub slowest_micros: u64,
}

impl Core {
    // A job that panicked while holding this lock cannot leave it in a state
    // that matters: both collections stay valid after any partial push or pop.
    fn local(&self) -> MutexGuard<'_, Local> {
        self.local.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A handle to the lane. Cheap to clone; the lane's thread ends when it is
/// stopped or when the last handle is dropped.
#[derive(Clone)]
pub struct Ordered {
    tx: SyncSender<Item>,
    core: Arc<Core>,
}

impl std::fmt::Debug for Ordered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ordered").field("capacity", &self.core.capacity).finish_non_exhaustive()
    }
}

/// How many jobs may wait. A full lane makes `post` and `run` wait for room —
/// back-pressure, never a dropped transition.
pub const DEFAULT_LANE_CAPACITY: usize = 4096;

impl Ordered {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_LANE_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let (tx, rx) = sync_channel::<Item>(capacity);
        let core = Arc::new(Core {
            thread: OnceLock::new(),
            local: Mutex::default(),
            stopped: AtomicBool::new(false),
            capacity,
            queued: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            slow: AtomicU64::new(0),
            slowest_us: AtomicU64::new(0),
        });
        let lane = core.clone();
        let spawned = thread::Builder::new().name("eos-ordered".into()).spawn(move || {
            // Every bus delivery waits for this thread: it runs beside the core's other threads.
            eos_platform::set_thread_class(eos_platform::ThreadClass::UserInitiated);
            let _ = lane.thread.set(thread::current().id());
            run_lane(&lane, &rx);
        });
        if let Err(e) = spawned {
            // No thread: the lane is born stopped, so every call reports it.
            tracing::error!(error = %e, "could not start the ordered lane");
            core.stopped.store(true, Ordering::SeqCst);
        }
        Self { tx, core }
    }

    /// Whether the calling code is running on the lane.
    pub fn is_current(&self) -> bool {
        self.core.thread.get() == Some(&thread::current().id())
    }

    /// Queues `job`. Jobs posted from one thread run in the order posted; a job
    /// posted by a lane job runs right after it. When the lane is full this
    /// waits for room.
    pub fn post(&self, job: impl FnOnce() + Send + 'static) -> Result<(), Error> {
        if self.core.stopped.load(Ordering::SeqCst) {
            return Err(Error::LaneStopped);
        }
        if self.is_current() {
            let mut local = self.core.local();
            if local.follow_ups.len() >= self.core.capacity {
                return Err(Error::LaneOverrun(self.core.capacity));
            }
            local.follow_ups.push_back(Box::new(job));
            return Ok(());
        }
        let queued = self.core.queued.fetch_add(1, Ordering::Relaxed) + 1;
        self.core.peak.fetch_max(queued, Ordering::Relaxed);
        self.tx.send(Item::Job(Box::new(job))).map_err(|_| {
            self.core.queued.fetch_sub(1, Ordering::Relaxed);
            Error::LaneStopped
        })
    }

    pub fn stats(&self) -> LaneStats {
        LaneStats {
            queued: self.core.queued.load(Ordering::Relaxed),
            peak_queued: self.core.peak.load(Ordering::Relaxed),
            slow_jobs: self.core.slow.load(Ordering::Relaxed),
            slowest_micros: self.core.slowest_us.load(Ordering::Relaxed),
        }
    }

    /// Queues `job` (now, not when the future is first polled) and resolves
    /// with what it returned. A job that panics fails only its own caller.
    pub fn run<R: Send + 'static>(
        &self,
        job: impl FnOnce() -> R + Send + 'static,
    ) -> impl Future<Output = Result<R, Error>> + Send + 'static {
        let (tx, rx) = oneshot::channel();
        let posted = self.post(move || {
            let out = catch_unwind(AssertUnwindSafe(job)).map_err(|p| Error::JobPanicked(panic_message(p.as_ref())));
            let _ = tx.send(out);
        });
        async move {
            posted?;
            rx.await.unwrap_or(Err(Error::LaneStopped))
        }
    }

    /// Runs `job` on the lane once `delay` has passed. For the runtime's own
    /// coalescing windows and throttles; features use their async timers and
    /// `post`.
    pub(crate) fn after(&self, delay: Duration, job: impl FnOnce() + Send + 'static) {
        if self.core.stopped.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut local = self.core.local();
            local.timer_seq += 1;
            let seq = local.timer_seq;
            local.timers.push(Timer { at: Instant::now() + delay, seq, job: Box::new(job) });
        }
        if !self.is_current() {
            // A full queue means the lane is busy and will look at its timers
            // after the job at hand anyway.
            match self.tx.try_send(Item::Wake) {
                Ok(()) | Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {}
            }
        }
    }

    /// Stops the lane after the jobs already queued. Later `post` and `run`
    /// calls fail with [`Error::LaneStopped`]; armed timers are dropped.
    pub async fn stop(&self) {
        if self.core.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Item::Stop(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

impl Default for Ordered {
    fn default() -> Self {
        Self::new()
    }
}

/// The lane thread's own record of its slow jobs, for the log.
#[derive(Default)]
struct SlowLog {
    logged_at: Option<Instant>,
    unlogged: u64,
}

fn guarded(core: &Core, slow: &mut SlowLog, job: Job) {
    let began = Instant::now();
    if let Err(payload) = catch_unwind(AssertUnwindSafe(job)) {
        tracing::error!(panic = %panic_message(payload.as_ref()), "a job on the ordered lane panicked");
    }
    let took = began.elapsed();
    if took < SLOW_JOB {
        return;
    }
    let micros = u64::try_from(took.as_micros()).unwrap_or(u64::MAX);
    core.slow.fetch_add(1, Ordering::Relaxed);
    core.slowest_us.fetch_max(micros, Ordering::Relaxed);
    slow.unlogged += 1;
    if slow.logged_at.is_none_or(|at| at.elapsed() >= SLOW_LOG_EVERY) {
        let queued = core.queued.load(Ordering::Relaxed);
        tracing::warn!(micros, queued, slow_jobs = slow.unlogged, "the ordered lane was held by a slow job");
        *slow = SlowLog { logged_at: Some(Instant::now()), unlogged: 0 };
    }
}

fn run_lane(core: &Core, rx: &std::sync::mpsc::Receiver<Item>) {
    let mut slow = SlowLog::default();
    loop {
        let follow_up = core.local().follow_ups.pop_front();
        if let Some(job) = follow_up {
            guarded(core, &mut slow, job);
            continue;
        }
        let now = Instant::now();
        let (due, next_at) = {
            let mut local = core.local();
            if local.timers.peek().is_some_and(|t| t.at <= now) {
                (local.timers.pop(), None)
            } else {
                (None, local.timers.peek().map(|t| t.at))
            }
        };
        if let Some(timer) = due {
            guarded(core, &mut slow, timer.job);
            continue;
        }
        let item = match next_at {
            Some(at) => rx.recv_timeout(at.saturating_duration_since(now)),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match item {
            Ok(Item::Job(job)) => {
                core.queued.fetch_sub(1, Ordering::Relaxed);
                guarded(core, &mut slow, job);
            }
            Ok(Item::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Item::Stop(done)) => {
                core.stopped.store(true, Ordering::SeqCst);
                *core.local() = Local::default();
                let _ = done.send(());
                return;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runs_jobs_one_at_a_time_in_each_callers_order() {
        let lane = Ordered::new();
        let log = Arc::new(Mutex::new(Vec::<(usize, usize)>::new()));
        let inside = Arc::new(AtomicBool::new(false));
        let overlaps = Arc::new(AtomicUsize::new(0));
        const THREADS: usize = 8;
        const EACH: usize = 2_000;

        let mut workers = Vec::new();
        for t in 0..THREADS {
            let (lane, log, inside, overlaps) = (lane.clone(), log.clone(), inside.clone(), overlaps.clone());
            workers.push(thread::spawn(move || {
                for i in 0..EACH {
                    let (log, inside, overlaps) = (log.clone(), inside.clone(), overlaps.clone());
                    lane.post(move || {
                        if inside.swap(true, Ordering::SeqCst) {
                            overlaps.fetch_add(1, Ordering::SeqCst);
                        }
                        log.lock().expect("log").push((t, i));
                        inside.store(false, Ordering::SeqCst);
                    })
                    .expect("lane is running");
                }
            }));
        }
        for w in workers {
            w.join().expect("worker");
        }
        lane.run(|| ()).await.expect("drained");

        assert_eq!(overlaps.load(Ordering::SeqCst), 0, "two jobs ran at once");
        let log = log.lock().expect("log");
        assert_eq!(log.len(), THREADS * EACH);
        let mut next = [0usize; THREADS];
        for &(t, i) in log.iter() {
            assert_eq!(i, next[t], "thread {t}'s jobs ran out of order");
            next[t] += 1;
        }
    }

    #[tokio::test]
    async fn run_returns_the_jobs_result_and_isolates_a_panic() {
        let lane = Ordered::new();
        assert_eq!(lane.run(|| 6 * 7).await.expect("ran"), 42);
        let failed = lane.run(|| -> u32 { panic!("bad transition") }).await;
        assert!(matches!(failed, Err(Error::JobPanicked(ref m)) if m == "bad transition"), "{failed:?}");
        lane.post(|| panic!("posted and panicked")).expect("queued");
        assert_eq!(lane.run(|| "still running").await.expect("lane survived"), "still running");
    }

    #[tokio::test]
    async fn a_job_posted_by_a_job_runs_right_after_it() {
        let lane = Ordered::with_capacity(64);
        let log = Arc::new(Mutex::new(Vec::new()));
        let gate = Arc::new(std::sync::Barrier::new(2));
        // Hold the lane so the outside jobs are queued before `first` runs.
        let held = gate.clone();
        lane.post(move || {
            held.wait();
        })
        .expect("queued");
        let (l1, lane1) = (log.clone(), lane.clone());
        lane.post(move || {
            l1.lock().expect("log").push("first");
            assert!(lane1.is_current());
            let l = l1.clone();
            lane1.post(move || l.lock().expect("log").push("follow-up")).expect("queued");
        })
        .expect("queued");
        let l2 = log.clone();
        lane.post(move || l2.lock().expect("log").push("second")).expect("queued");
        assert!(!lane.is_current());
        gate.wait();
        lane.run(|| ()).await.expect("drained");
        assert_eq!(*log.lock().expect("log"), ["first", "follow-up", "second"]);
    }

    #[tokio::test]
    async fn a_full_lane_makes_callers_wait_instead_of_dropping() {
        let lane = Ordered::with_capacity(2);
        let count = Arc::new(AtomicUsize::new(0));
        for _ in 0..200 {
            let count = count.clone();
            lane.post(move || {
                thread::sleep(Duration::from_micros(50));
                count.fetch_add(1, Ordering::SeqCst);
            })
            .expect("queued");
        }
        lane.run(|| ()).await.expect("drained");
        assert_eq!(count.load(Ordering::SeqCst), 200);
    }

    #[tokio::test]
    async fn the_lane_counts_what_waits_and_what_held_it() {
        let lane = Ordered::with_capacity(64);
        let gate = Arc::new(std::sync::Barrier::new(2));
        let held = gate.clone();
        lane.post(move || {
            held.wait();
            thread::sleep(SLOW_JOB + Duration::from_millis(1));
        })
        .expect("queued");
        // The first job is off the queue once it runs.
        let waiting = Instant::now();
        while lane.stats().queued > 0 && waiting.elapsed() < Duration::from_secs(10) {
            thread::yield_now();
        }
        for _ in 0..3 {
            lane.post(|| ()).expect("queued");
        }
        assert_eq!(lane.stats().queued, 3, "they wait behind it");
        gate.wait();
        let waiting = Instant::now();
        while (lane.stats().queued, lane.stats().slow_jobs) != (0, 1) && waiting.elapsed() < Duration::from_secs(10) {
            tokio::task::yield_now().await;
        }
        let stats = lane.stats();
        assert_eq!((stats.queued, stats.peak_queued, stats.slow_jobs), (0, 3, 1));
        assert!(stats.slowest_micros >= u64::try_from(SLOW_JOB.as_micros()).expect("fits"));
    }

    #[tokio::test]
    async fn timers_fire_on_the_lane_in_deadline_order() {
        let lane = Ordered::new();
        let log = Arc::new(Mutex::new(Vec::new()));
        for (delay, name) in [(30, "c"), (10, "a"), (20, "b")] {
            let (log, probe) = (log.clone(), lane.clone());
            lane.after(Duration::from_millis(delay), move || {
                assert!(probe.is_current());
                log.lock().expect("log").push(name);
            });
        }
        // Wait for the last one rather than for a fixed time: a busy machine
        // delays timers, it never reorders them.
        let waiting = Instant::now();
        while log.lock().expect("log").len() < 3 && waiting.elapsed() < Duration::from_secs(10) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(*log.lock().expect("log"), ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn stop_runs_what_was_queued_and_refuses_the_rest() {
        let lane = Ordered::new();
        let count = Arc::new(AtomicUsize::new(0));
        for _ in 0..10 {
            let count = count.clone();
            lane.post(move || {
                count.fetch_add(1, Ordering::SeqCst);
            })
            .expect("queued");
        }
        lane.stop().await;
        assert_eq!(count.load(Ordering::SeqCst), 10);
        assert!(matches!(lane.post(|| ()), Err(Error::LaneStopped)));
        assert!(matches!(lane.run(|| 1).await, Err(Error::LaneStopped)));
        lane.stop().await;
    }

    #[test]
    fn the_thread_ends_with_the_last_handle() {
        let lane = Ordered::new();
        let core = Arc::downgrade(&lane.core);
        lane.post(|| ()).expect("queued");
        drop(lane);
        // The lane thread holds the other reference until it sees the channel close.
        for _ in 0..200 {
            if core.strong_count() == 0 {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the lane thread outlived its handles");
    }
}
