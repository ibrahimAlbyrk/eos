//! What powers the computer.

/// The computer's power source and energy saving, as the system reports them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PowerStatus {
    /// It draws from a battery (its own, or a UPS), not from mains.
    pub on_battery: bool,
    /// How full its own battery is; `None` without one.
    pub battery_percent: Option<u8>,
    /// The user turned Low Power Mode on.
    pub low_power: bool,
}

/// The system's power report.
pub trait Power: Send + Sync + 'static {
    /// A system that does not say reads as mains power with no battery. Asking the system
    /// takes a moment (the real one asks at most once a minute): call it from a blocking thread.
    fn status(&self) -> PowerStatus;
}
