//! One keep-awake process shared by every hold the app's work takes.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::Error;

/// Starts the process that holds sleep off; dropping what it returns stops that process.
type Start = dyn Fn() -> Result<Box<dyn Send>, Error> + Send + Sync;

/// Keeps the computer out of idle sleep, on battery too, while any of its holds lives. The
/// first hold starts one process ([`HostPlatform::prevent_idle_sleep`](crate::HostPlatform::prevent_idle_sleep)
/// for this process), the last one to drop stops it, and it never outlives this process.
pub struct WorkAwake {
    shared: Arc<Shared>,
}

/// One live hold of a [`WorkAwake`]; dropping the last one lets the computer sleep again.
pub struct WorkAwakeHold {
    shared: Arc<Shared>,
}

struct Shared {
    start: Box<Start>,
    live: Mutex<Live>,
}

/// `process` is there exactly while `holds` is above zero.
struct Live {
    holds: usize,
    process: Option<Box<dyn Send>>,
}

fn lock(live: &Mutex<Live>) -> MutexGuard<'_, Live> {
    live.lock().unwrap_or_else(|p| p.into_inner())
}

impl WorkAwake {
    pub fn new() -> Self {
        Self::starting(|| {
            let process = crate::host().prevent_idle_sleep(std::process::id())?;
            Ok(Box::new(process) as Box<dyn Send>)
        })
    }

    fn starting(start: impl Fn() -> Result<Box<dyn Send>, Error> + Send + Sync + 'static) -> Self {
        let live = Mutex::new(Live { holds: 0, process: None });
        Self { shared: Arc::new(Shared { start: Box::new(start), live }) }
    }

    /// A hold, starting the process when no other hold lives. [`Error::Unsupported`] where the
    /// system has no way; a process that does not start counts no hold.
    pub fn hold(&self) -> Result<WorkAwakeHold, Error> {
        let mut live = lock(&self.shared.live);
        if live.process.is_none() {
            live.process = Some((self.shared.start)()?);
        }
        live.holds += 1;
        Ok(WorkAwakeHold { shared: self.shared.clone() })
    }
}

impl Default for WorkAwake {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WorkAwakeHold {
    fn drop(&mut self) {
        let stopped = {
            let mut live = lock(&self.shared.live);
            live.holds -= 1;
            if live.holds == 0 { live.process.take() } else { None }
        };
        // Stopping waits for the process to end, which no other hold should wait for.
        drop(stopped);
    }
}

impl fmt::Debug for WorkAwake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkAwake").field("holds", &lock(&self.shared.live).holds).finish_non_exhaustive()
    }
}

impl fmt::Debug for WorkAwakeHold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkAwakeHold").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Counts the processes started and stopped; starts none.
    #[derive(Default)]
    struct Processes {
        started: AtomicUsize,
        stopped: Arc<AtomicUsize>,
    }

    struct Process(Arc<AtomicUsize>);

    impl Drop for Process {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn counted() -> (WorkAwake, Arc<Processes>) {
        let processes = Arc::new(Processes::default());
        let seen = processes.clone();
        let awake = WorkAwake::starting(move || {
            seen.started.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Process(seen.stopped.clone())) as Box<dyn Send>)
        });
        (awake, processes)
    }

    fn counts(processes: &Processes) -> (usize, usize) {
        (processes.started.load(Ordering::SeqCst), processes.stopped.load(Ordering::SeqCst))
    }

    #[test]
    fn many_holds_share_one_process_that_stops_after_the_last() {
        let (awake, processes) = counted();
        let first = awake.hold().expect("hold");
        let more: Vec<WorkAwakeHold> = (0..4).map(|_| awake.hold().expect("hold")).collect();
        assert_eq!(counts(&processes), (1, 0));
        drop(first);
        assert_eq!(counts(&processes), (1, 0), "four holds still live");
        drop(more);
        assert_eq!(counts(&processes), (1, 1));

        let again = awake.hold().expect("hold");
        assert_eq!(counts(&processes), (2, 1), "a hold after the last one starts a new process");
        drop(again);
        assert_eq!(counts(&processes), (2, 2));
    }

    #[test]
    fn a_process_that_does_not_start_counts_no_hold() {
        let tries = Arc::new(AtomicUsize::new(0));
        let seen = tries.clone();
        let awake = WorkAwake::starting(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            Err(Error::Unsupported("keeping the computer awake"))
        });
        assert!(matches!(awake.hold(), Err(Error::Unsupported(_))));
        assert!(matches!(awake.hold(), Err(Error::Unsupported(_))));
        assert_eq!(tries.load(Ordering::SeqCst), 2, "each hold tries again");
        assert_eq!(lock(&awake.shared.live).holds, 0);
    }
}
