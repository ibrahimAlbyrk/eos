//! Ports over the operating system: files, watchers, processes, scripts, the
//! symbol index, location and the time zone (`core/src/ports/FileSystem.ts`,
//! `FileWatcher.ts`, `ProcessRunner.ts`, `TimeZoneProvider.ts`, …).

/// What the process holds of the system's bounded resources.
pub trait ProcessStats: Send + Sync + 'static {
    /// File descriptors open now; `None` where the system does not say.
    fn open_fds(&self) -> Option<u64>;
    /// The most it may open.
    fn fd_limit(&self) -> Option<u64>;
}
