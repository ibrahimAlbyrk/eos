//! The threads the core runs on: a tokio runtime of its own, sized from the machine.
//!
//! The core's handlers, streams and background work run on its async workers; whatever
//! blocks a thread (starting a process, a synchronous file, SQLite or Keychain call) goes to
//! the blocking pool, never onto a worker. The window shell keeps a small runtime of its
//! own, so a busy core never delays the shell's bridges.
//!
//! Every thread of the core (workers, blocking pool, the database's threads, the ordered
//! lane) runs at the user-initiated class, beside the browser engine's busy threads rather
//! than below them. Long work nobody waits on lowers its own thread for its duration
//! (`eos_platform::in_thread_class`).

use std::num::NonZero;

use eos_platform::ThreadClass;

/// Async workers: one per core the system gives this process, never fewer than this, so
/// one busy worker cannot stall every request …
pub const MIN_WORKERS: usize = 2;
/// … and never more than this: past it more workers only contend with Chromium's own
/// threads in the same process.
pub const MAX_WORKERS: usize = 8;
/// Threads of the blocking pool at most (tokio's default, stated here). Idle ones end after
/// tokio's keep-alive.
pub const MAX_BLOCKING_THREADS: usize = 512;

/// The number of async workers for a machine that gives this process `parallelism` cores.
pub fn workers(parallelism: usize) -> usize {
    parallelism.clamp(MIN_WORKERS, MAX_WORKERS)
}

/// The async workers of this machine. `available_parallelism` follows the cores macOS
/// actually gives the process (and a container's or a task policy's limit elsewhere).
pub(crate) fn machine_workers() -> usize {
    workers(std::thread::available_parallelism().map_or(MIN_WORKERS, NonZero::get))
}

/// Runs first on every thread of the core.
pub(crate) fn core_thread_start() {
    eos_platform::set_thread_class(ThreadClass::UserInitiated);
}

/// The core's runtime.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(machine_workers())
        .max_blocking_threads(MAX_BLOCKING_THREADS)
        .thread_name("eos-core")
        .on_thread_start(core_thread_start)
        .enable_all()
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workers_follow_the_machine_within_bounds() {
        assert_eq!(workers(1), MIN_WORKERS);
        assert_eq!(workers(4), 4);
        assert_eq!(workers(10), MAX_WORKERS);
        assert_eq!(workers(64), MAX_WORKERS);
    }

    #[test]
    fn the_runtime_has_the_machines_workers() {
        let rt = runtime().expect("runtime");
        let expected = workers(std::thread::available_parallelism().map_or(MIN_WORKERS, NonZero::get));
        assert_eq!(rt.metrics().num_workers(), expected);
        assert_eq!(machine_workers(), expected);
    }
}
