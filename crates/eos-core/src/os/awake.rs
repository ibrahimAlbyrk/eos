//! Keeping the computer out of system sleep, and the app working while nobody looks at it.

/// Holds sleep off for as long as it lives. Dropping it lets the computer
/// sleep again.
pub trait AwakeHold: Send + Sync + 'static {}

/// The system's way of staying awake while something must stay reachable: a
/// phone or another computer can then still reach the app with the screen
/// locked or off. How, and whether at all, is the platform's call (on macOS:
/// on mains power only, and never past this process's own life).
pub trait KeepAwake: Send + Sync + 'static {
    /// `None` when the system offers no way; the caller carries on without.
    fn hold(&self) -> Option<Box<dyn AwakeHold>>;
}

/// Why the app must keep working with its window hidden. Closed on purpose: whatever the
/// reason, all the system is told is "Eos is running a routine".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HoldReason {
    /// A run works: the app must not nap, and the computer must not sleep when idle, on
    /// battery too.
    Run,
    /// A routine waits for its time: the app must not nap; the computer may still sleep.
    Armed,
}

/// Keeps the app at full pace while routines run or wait. Holds are counted per reason: the
/// system's own hold for a reason lasts while any hold of it lives. Closing the lid still
/// sleeps the computer; nothing in user space changes that.
pub trait WorkHold: Send + Sync + 'static {
    /// `None` when the system offers no way; the caller carries on without.
    fn begin(&self, why: HoldReason) -> Option<Box<dyn AwakeHold>>;
}
