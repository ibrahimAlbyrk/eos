//! What this build's system offers and holds, for the features that report it.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::UiConfigResponseFeatures;
use eos_core::accounts::Browser;
use eos_core::os::{HoldReason, LocalTime, ProcessStats, TimeZone, WorkHold, ZoneRules};
use eos_core::shell::{Location, PositionError, PositionFix};
use eos_core::{BoxFuture, Clock};
use eos_platform::{Argv, LocationFailure};

/// File-descriptor figures from the platform kit. The limit cannot change
/// while the process runs, and finding the system's ceiling runs a program,
/// so it is read once.
#[derive(Debug)]
pub(crate) struct HostStats {
    fd_limit: Option<u64>,
}

impl HostStats {
    pub(crate) fn read() -> Self {
        let soft = eos_platform::soft_fd_limit();
        // Some systems stop a process well below its own limit.
        let ceiling = eos_platform::host().fd_ceiling();
        let fd_limit = match (soft, ceiling) {
            (Some(soft), Some(ceiling)) => Some(soft.min(ceiling)),
            (soft, ceiling) => soft.or(ceiling),
        };
        Self { fd_limit }
    }
}

impl ProcessStats for HostStats {
    fn open_fds(&self) -> Option<u64> {
        eos_platform::open_fd_count()
    }

    fn fd_limit(&self) -> Option<u64> {
        self.fd_limit
    }
}

/// What the dashboard hides when the system cannot do it.
pub(crate) fn features() -> UiConfigResponseFeatures {
    let features = eos_platform::host().features();
    UiConfigResponseFeatures { remote: features.remote, posix_shell: features.posix_shell }
}

/// This computer's position, read by the native helper the app ships beside
/// its executable. Each ask runs the helper once; the system may show its
/// permission prompt, so an answer can take as long as the user does.
struct HelperLocation {
    helper: Argv,
    clock: Arc<dyn Clock>,
}

impl Location for HelperLocation {
    fn current(&self) -> BoxFuture<'_, Result<PositionFix, PositionError>> {
        let helper = self.helper.clone();
        Box::pin(async move {
            let read = tokio::task::spawn_blocking(move || eos_platform::read_location(&helper)).await;
            match read {
                Ok(Ok(reading)) => Ok(PositionFix {
                    lat: reading.lat,
                    lon: reading.lon,
                    accuracy: reading.accuracy,
                    at: reading.at_ms.unwrap_or_else(|| self.clock.now_ms()),
                }),
                Ok(Err(LocationFailure::Denied)) => Err(PositionError::Denied),
                Ok(Err(LocationFailure::Disabled)) => Err(PositionError::Disabled),
                Ok(Err(LocationFailure::Timeout)) => Err(PositionError::Timeout),
                Ok(Err(LocationFailure::Unsupported)) => Err(PositionError::Unsupported),
                Ok(Err(LocationFailure::Unavailable)) | Err(_) => Err(PositionError::Unavailable),
            }
        })
    }
}

/// This computer's position over the helper in `resources` (the folder the
/// app ships its extra files in). `None` on a system without a helper.
pub(crate) fn helper_location(resources: &Path, clock: Arc<dyn Clock>) -> Option<Arc<dyn Location>> {
    let helper = eos_platform::host().location_helper(resources, eos_platform::LOCATION_WAIT_SECONDS)?;
    Some(Arc::new(HelperLocation { helper, clock }))
}

/// The user's default browser.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct SystemBrowser;

impl Browser for SystemBrowser {
    fn open(&self, url: &str) {
        // The system's opener takes an address as it takes a path.
        if let Err(e) = eos_platform::host().desktop().open_path(Path::new(url)) {
            tracing::warn!(error = %e, "the browser could not be opened");
        }
    }
}

/// The time of day on the user's clock, from the system; UTC when it does not say.
pub(crate) struct HostLocalTime;

impl LocalTime for HostLocalTime {
    fn hour_minute(&self, epoch_ms: i64) -> String {
        eos_platform::local_hour_minute(epoch_ms)
            .unwrap_or_else(|| eos_domain::time::iso_from_ms(epoch_ms).get(11..16).unwrap_or_default().to_owned())
    }
}

/// The time zone of the user's clock, from the system; UTC when it does not say.
pub(crate) struct HostTimeZone;

impl TimeZone for HostTimeZone {
    fn name(&self) -> String {
        eos_platform::local_zone_name().unwrap_or_else(|| "UTC".to_owned())
    }

    fn offset_minutes_at(&self, epoch_ms: i64) -> i32 {
        eos_platform::local_utc_offset_minutes(epoch_ms).unwrap_or(0)
    }
}

/// Every time zone the system knows, from its zone files.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct HostZoneRules;

impl ZoneRules for HostZoneRules {
    fn offset_minutes_at(&self, zone: &str, epoch_ms: i64) -> Option<i32> {
        eos_platform::zone_offset_minutes(zone, epoch_ms)
    }

    fn known(&self, zone: &str) -> bool {
        eos_platform::zone_known(zone)
    }

    fn local_name(&self) -> String {
        HostTimeZone.name()
    }
}

/// Keeps this computer out of system sleep for as long as the hold lives,
/// and never past this process's own life.
#[derive(Debug)]
pub(crate) struct HostKeepAwake;

/// Keeps what holds the computer awake until it is dropped.
struct Hold<T>(#[allow(dead_code)] T);

impl<T: Send + Sync + 'static> eos_core::os::AwakeHold for Hold<T> {}

impl eos_core::os::KeepAwake for HostKeepAwake {
    fn hold(&self) -> Option<Box<dyn eos_core::os::AwakeHold>> {
        match eos_platform::host().keep_awake(std::process::id()) {
            Ok(hold) => Some(Box::new(Hold(hold))),
            Err(error) => {
                tracing::info!(%error, "this computer cannot be kept awake");
                None
            }
        }
    }
}

/// The work hold without the window shell: a run keeps the computer out of
/// idle sleep, on battery too, through one process shared by every run. A
/// process of its own cannot keep this app out of App Nap, and holding idle
/// sleep off would deny what an armed routine allows, so `Armed` holds nothing.
#[derive(Debug, Default)]
pub(crate) struct HostWorkHold(eos_platform::WorkAwake);

impl WorkHold for HostWorkHold {
    fn begin(&self, why: HoldReason) -> Option<Box<dyn eos_core::os::AwakeHold>> {
        match why {
            HoldReason::Run => match self.0.hold() {
                Ok(hold) => Some(Box::new(Hold(hold))),
                Err(error) => {
                    tracing::info!(%error, "this computer cannot be kept awake for a run");
                    None
                }
            },
            HoldReason::Armed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Without the shell, `Armed` starts no process, so this test starts none either.
    #[test]
    fn an_armed_routine_holds_nothing_without_the_shell() {
        assert!(HostWorkHold::default().begin(HoldReason::Armed).is_none());
    }
}
