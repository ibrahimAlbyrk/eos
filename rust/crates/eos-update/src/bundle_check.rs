//! The system's own word on a staged app, as the update port.

use std::path::Path;

use eos_core::BoxFuture;
use eos_core::net::updates::AppBundleCheck;
use eos_domain::update::{UpdateError, UpdateErrorCode};
use eos_platform::AppUpdatePlatform;

/// Asks the platform kit (`codesign` and Gatekeeper on macOS). On a system
/// where Eos cannot update itself, every staged app is refused.
#[derive(Debug, Clone, Copy)]
pub struct PlatformBundleCheck {
    platform: Option<&'static dyn AppUpdatePlatform>,
}

impl PlatformBundleCheck {
    pub fn new(platform: Option<&'static dyn AppUpdatePlatform>) -> Self {
        Self { platform }
    }
}

impl AppBundleCheck for PlatformBundleCheck {
    fn verify<'a>(&'a self, staged: &'a Path, installed: &'a Path) -> BoxFuture<'a, Result<(), UpdateError>> {
        let (platform, staged, installed) = (self.platform, staged.to_owned(), installed.to_owned());
        Box::pin(async move {
            let Some(platform) = platform else {
                return Err(UpdateError::new(
                    UpdateErrorCode::RejectedBundle,
                    "Eos cannot update itself on this system",
                ));
            };
            // The system's tools take seconds on a large bundle.
            tokio::task::spawn_blocking(move || platform.verify_bundle(&staged, &installed))
                .await
                .map_err(|e| UpdateError::disk(e.to_string()))?
                .map_err(|e| UpdateError::new(UpdateErrorCode::RejectedBundle, e.to_string()))
        })
    }
}
