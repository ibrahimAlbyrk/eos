//! Liveness and the configuration the dashboard reads when it opens
//! (`manager/routes/health.ts`, `uiConfig.ts`).
//!
//! Read handlers only: `POST /api/model-catalog/refresh` needs a sign-in and
//! the network, and arrives with the accounts work.

use std::sync::Arc;

use eos_contracts::{
    HealthFds, HealthResponse, UiBackendProfile, UiConfigResponse, UiConfigResponseFeatures,
    UiConfigResponsePermissions, UiConfigResponseSse,
};
use eos_core::agent::{BackendCatalog, ModelCatalog};
use eos_core::os::ProcessStats;
use eos_core::store::ConfigSource;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

/// What `/health` says about this run of the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    pub pid: u32,
    /// Epoch milliseconds.
    pub started_at: i64,
    /// Names the build: a client that sees it change knows the app was replaced.
    pub source_stamp: String,
}

pub struct SystemModule {
    run: RunInfo,
    features: UiConfigResponseFeatures,
    stats: Arc<dyn ProcessStats>,
    config: Arc<dyn ConfigSource>,
    models: Arc<dyn ModelCatalog>,
    backends: Arc<dyn BackendCatalog>,
}

impl std::fmt::Debug for SystemModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemModule").field("run", &self.run).finish_non_exhaustive()
    }
}

impl SystemModule {
    /// `features`: what the system this build runs on offers (pairing, a POSIX shell).
    pub fn new(
        run: RunInfo,
        features: UiConfigResponseFeatures,
        stats: Arc<dyn ProcessStats>,
        config: Arc<dyn ConfigSource>,
        models: Arc<dyn ModelCatalog>,
        backends: Arc<dyn BackendCatalog>,
    ) -> Self {
        Self { run, features, stats, config, models, backends }
    }
}

fn health(run: &RunInfo, stats: &dyn ProcessStats) -> HealthResponse {
    // File descriptors are far below 2^53: the wire number is exact.
    let count = |n: Option<u64>| n.map(|n| (n as f64).into());
    HealthResponse {
        ok: Default::default(),
        pid: i64::from(run.pid),
        started_at: run.started_at.into(),
        source_stamp: run.source_stamp.clone(),
        fds: Some(HealthFds { open: count(stats.open_fds()), limit: count(stats.fd_limit()) }),
    }
}

fn ui_config(
    config: &dyn ConfigSource,
    models: &dyn ModelCatalog,
    backends: &dyn BackendCatalog,
    features: &UiConfigResponseFeatures,
) -> UiConfigResponse {
    let current = config.current();
    // The picker lists the profiles the user wrote, not the built-in ones
    // merged in; a file that declares none keeps them all, so a fresh install
    // never has an empty picker.
    let declared = config.declared_backends();
    let backend_profiles = current
        .backends
        .iter()
        .filter(|(name, _)| declared.as_ref().is_none_or(|names| names.contains(name)))
        .map(|(name, profile)| UiBackendProfile {
            name: name.clone(),
            // The kind as config.json spells it.
            kind: serde_json::to_value(profile.kind)
                .ok()
                .and_then(|k| k.as_str().map(str::to_owned))
                .unwrap_or_default(),
            model: profile.model.clone(),
            label: format!("{name} ({})", profile.model),
        })
        .collect();
    UiConfigResponse {
        models: current.prices.keys().cloned().collect(),
        model_catalog: models.models(),
        prices: current.prices.clone(),
        permissions: UiConfigResponsePermissions { default_ttl_ms: current.permissions.default_ttl_ms },
        sse: UiConfigResponseSse { keepalive_ms: current.daemon.sse_keepalive_ms },
        backends: backends.descriptors(),
        backend_profiles,
        features: features.clone(),
    }
}

impl Module for SystemModule {
    fn id(&self) -> &'static str {
        "system"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let (run, stats) = (self.run.clone(), self.stats.clone());
        let health = move |_req: Request| {
            let body = health(&run, stats.as_ref());
            async move { Ok(Response::json(200, &body)) }
        };
        let (config, models, backends, features) =
            (self.config.clone(), self.models.clone(), self.backends.clone(), self.features.clone());
        let ui_config = move |_req: Request| {
            let body = ui_config(config.as_ref(), models.as_ref(), backends.as_ref(), &features);
            async move { Ok(Response::json(200, &body)) }
        };
        vec![
            RouteDef::get("/health", health).access(Access::open().phone(Tier::Read)),
            RouteDef::get("/api/ui-config", ui_config).access(Access::open().phone(Tier::Read)),
        ]
    }
}
