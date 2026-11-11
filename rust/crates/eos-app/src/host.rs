//! What this build's system offers and holds, for the features that report it.

use std::path::Path;

use eos_contracts::UiConfigResponseFeatures;
use eos_core::accounts::Browser;
use eos_core::os::{LocalTime, ProcessStats};

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
