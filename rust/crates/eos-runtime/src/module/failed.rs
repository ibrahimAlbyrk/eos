//! Modules whose start failed. The app opens without them: their routes
//! answer 503 naming the feature, their hooks do not run, and the user is told.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

type Announce = Box<dyn Fn(&str, &str) + Send + Sync>;

/// Shared by the router, the modules' fan-out calls, the idle hooks and the
/// lifecycle, which records a failure.
#[derive(Default)]
pub struct FailedModules {
    failed: RwLock<HashMap<String, String>>,
    announce: OnceLock<Announce>,
}

impl std::fmt::Debug for FailedModules {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FailedModules")
            .field("failed", &*self.failed.read().unwrap_or_else(|p| p.into_inner()))
            .finish()
    }
}

impl FailedModules {
    /// How a failure is told to the user (once, when it happens).
    pub fn announce_with(&self, announce: impl Fn(&str, &str) + Send + Sync + 'static) {
        let _ = self.announce.set(Box::new(announce));
    }

    /// Records that `module` could not start, and why.
    pub fn fail(&self, module: &str, reason: &str) {
        tracing::error!(module, reason, "a feature could not start; the app goes on without it");
        self.failed.write().unwrap_or_else(|p| p.into_inner()).insert(module.to_owned(), reason.to_owned());
        if let Some(announce) = self.announce.get() {
            announce(module, reason);
        }
    }

    /// Why `module` could not start; `None` while it runs.
    pub fn reason(&self, module: &str) -> Option<String> {
        self.failed.read().unwrap_or_else(|p| p.into_inner()).get(module).cloned()
    }

    pub fn is_failed(&self, module: &str) -> bool {
        self.failed.read().unwrap_or_else(|p| p.into_inner()).contains_key(module)
    }

    /// The failed modules, by id.
    pub fn list(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.failed.read().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect();
        ids.sort();
        ids
    }
}
