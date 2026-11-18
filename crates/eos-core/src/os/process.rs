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

/// The time zone of the user's clock.
pub trait TimeZone: Send + Sync + 'static {
    /// The zone's name (`Europe/Istanbul`).
    fn name(&self) -> String;
    /// Minutes east of UTC at `epoch_ms`, daylight saving included.
    fn offset_minutes_at(&self, epoch_ms: i64) -> i32;
}

/// Every time zone the system knows, by its IANA name written exactly (`Europe/Istanbul`).
pub trait ZoneRules: Send + Sync + 'static {
    /// Minutes east of UTC in `zone` at `epoch_ms`, daylight saving included; `None` for a
    /// zone the system does not know.
    fn offset_minutes_at(&self, zone: &str, epoch_ms: i64) -> Option<i32>;
    /// The system knows `zone`.
    fn known(&self, zone: &str) -> bool;
    /// The name of the zone the user's clock is in.
    fn local_name(&self) -> String;
}
