/// What the process holds of the system's bounded resources.
pub trait ProcessStats: Send + Sync + 'static {
    /// File descriptors open now; `None` where the system does not say.
    fn open_fds(&self) -> Option<u64>;
    /// The most it may open.
    fn fd_limit(&self) -> Option<u64>;
}

/// The user's local time, for text a person reads.
pub trait LocalTime: Send + Sync + 'static {
    /// Hours and minutes of `epoch_ms` on the user's clock (`16:40`).
    fn hour_minute(&self, epoch_ms: i64) -> String;
}
