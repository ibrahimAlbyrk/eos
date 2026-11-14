//! Keeping the computer out of system sleep.

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
