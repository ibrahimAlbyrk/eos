//! How soon the system runs a thread's work.
//!
//! macOS schedules threads by quality-of-service class. A thread that never asks for one
//! runs at the default class, below the browser engine's busy threads in the same process
//! (user-initiated and above), so in a burst of requests the core's threads wait for a CPU
//! while the page waits for them. The core's own threads therefore ask for
//! [`ThreadClass::UserInitiated`]; long work nobody waits on runs at
//! [`ThreadClass::Utility`] for its duration. Where the system has no such classes, both
//! calls do nothing.

/// A thread's scheduling class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadClass {
    /// Work someone is waiting for: requests, the database, the event bus.
    UserInitiated,
    /// Long work nobody is waiting for, such as hashing an app update.
    Utility,
}

/// Puts the calling thread in `class`.
pub fn set_thread_class(class: ThreadClass) {
    #[cfg(target_os = "macos")]
    crate::darwin::qos::set(class);
    #[cfg(not(target_os = "macos"))]
    let _ = class;
}

/// Runs `work` on the calling thread in `class`, then gives the thread back the class it
/// had, also when `work` panics: a pooled thread must not keep a lower class for the next job.
pub fn in_thread_class<T>(class: ThreadClass, work: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    let _restore = crate::darwin::qos::Restore::current();
    set_thread_class(class);
    work()
}
