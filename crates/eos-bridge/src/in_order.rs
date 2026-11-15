//! Requests handed on in the order they came, when some of them need slow work first that
//! must not run on the caller's thread (a form upload's files are read from the disk).

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Jobs waiting behind a slow one; past it a job runs at once, out of order.
const WAITING: usize = 4096;

type Job = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct InOrder {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// A slow job, or what waited behind it, is running.
    busy: bool,
    waiting: VecDeque<Job>,
}

impl std::fmt::Debug for InOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InOrder").finish_non_exhaustive()
    }
}

impl InOrder {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `job` here and now, unless a slow job asked for earlier has not run yet: then
    /// right after it (and what waits before it), on that job's thread.
    pub fn now(&self, job: impl FnOnce() + Send + 'static) {
        {
            let mut state = self.lock();
            if state.busy && state.waiting.len() < WAITING {
                state.waiting.push_back(Box::new(job));
                return;
            }
        }
        job();
    }

    /// Runs `job` on a thread `spawn` starts (here when it cannot start one), after what was
    /// asked for before it; what is asked for after it waits for it.
    pub fn slow(self: &Arc<Self>, job: impl FnOnce() + Send + 'static, spawn: impl FnOnce(Job) -> bool) {
        {
            let mut state = self.lock();
            if state.busy {
                if state.waiting.len() < WAITING {
                    state.waiting.push_back(Box::new(job));
                    return;
                }
            } else {
                state.busy = true;
            }
        }
        let order = self.clone();
        let run: Job = Box::new(move || {
            let _ = catch_unwind(AssertUnwindSafe(job));
            order.drain();
        });
        // A thread that could not start dropped its closure: the job is still in the slot.
        let slot = Arc::new(Mutex::new(Some(run)));
        let on_thread = slot.clone();
        if !spawn(Box::new(move || take(&on_thread))) {
            take(&slot);
        }
    }

    /// Runs what waited, in order, until nothing does.
    fn drain(&self) {
        loop {
            let next = {
                let mut state = self.lock();
                match state.waiting.pop_front() {
                    Some(job) => job,
                    None => {
                        state.busy = false;
                        return;
                    }
                }
            };
            // One failing job must not stop the ones behind it.
            let _ = catch_unwind(AssertUnwindSafe(next));
        }
    }
}

/// Runs the job in `slot` once, whoever gets to it.
fn take(slot: &Mutex<Option<Job>>) {
    let job = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(job) = job {
        job();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn what_comes_after_a_slow_job_waits_for_it_and_order_is_kept() {
        let order = Arc::new(InOrder::default());
        let (done, seen) = mpsc::channel::<&'static str>();
        let (go, gate) = mpsc::channel::<()>();
        let threads = Arc::new(Mutex::new(Vec::new()));
        let spawn = |threads: Arc<Mutex<Vec<std::thread::JoinHandle<()>>>>| {
            move |job: Job| {
                threads.lock().unwrap().push(std::thread::spawn(job));
                true
            }
        };
        let say = |what: &'static str| {
            let done = done.clone();
            move || done.send(what).unwrap()
        };
        order.now(say("first"));
        let slow = say("upload");
        order.slow(
            move || {
                gate.recv().unwrap();
                slow();
            },
            spawn(threads.clone()),
        );
        order.now(say("after the upload"));
        order.slow(say("second upload"), spawn(threads.clone()));
        order.now(say("last"));
        assert_eq!(seen.recv().unwrap(), "first");
        assert!(seen.try_recv().is_err(), "everything else waits for the upload");
        go.send(()).unwrap();
        let rest: Vec<_> = (0..4).map(|_| seen.recv().unwrap()).collect();
        assert_eq!(rest, ["upload", "after the upload", "second upload", "last"]);
        for thread in threads.lock().unwrap().drain(..) {
            thread.join().unwrap();
        }
        // Idle again: a job runs at once.
        order.now(say("now"));
        assert_eq!(seen.try_recv().unwrap(), "now");
    }

    #[test]
    fn a_slow_job_without_a_thread_runs_here_and_a_panic_stops_nothing() {
        let order = Arc::new(InOrder::default());
        let (done, seen) = mpsc::channel::<&'static str>();
        order.slow(|| panic!("a broken upload"), |_| false);
        let done2 = done.clone();
        order.now(move || done2.send("next").unwrap());
        assert_eq!(seen.try_recv().unwrap(), "next");
        drop(done);
    }
}
