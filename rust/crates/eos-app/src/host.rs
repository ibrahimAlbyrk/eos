//! What this build's system offers and holds, for the features that report it.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::UiConfigResponseFeatures;
use eos_core::accounts::Browser;
use eos_core::os::{LocalTime, ProcessStats};
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
