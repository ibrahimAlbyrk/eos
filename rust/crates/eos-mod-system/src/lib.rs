//! Liveness and the configuration the dashboard reads when it opens
//! (`manager/routes/health.ts`, `uiConfig.ts`), the models a backend profile
//! offers (`backends.ts`: `GET /api/backends/{name}/models`), and the skills
//! and slash commands of a folder (`commands.ts`: `GET /commands`).
//!
//! Read handlers only: `POST /api/model-catalog/refresh` needs a sign-in and
//! the network, and arrives with the accounts work.

use std::sync::Arc;

use eos_contracts::{
    BackendModelsResponse, HealthFds, HealthResponse, UiBackendProfile, UiConfigResponse, UiConfigResponseFeatures,
    UiConfigResponsePermissions, UiConfigResponseSse,
};
use eos_core::Clock;
use eos_core::agent::{BackendCatalog, CommandCatalog, ModelCatalog};
use eos_core::os::{ProcessStats, TimeZone};
use eos_core::store::ConfigSource;
use eos_domain::time::current_datetime;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::path::percent_decode;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;
use serde_json::json;

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
    commands: Arc<dyn CommandCatalog>,
    time: LocalClock,
}

/// What the engine offers: models, backends, a folder's commands.
#[derive(Clone)]
pub struct Offers {
    pub models: Arc<dyn ModelCatalog>,
    pub backends: Arc<dyn BackendCatalog>,
    pub commands: Arc<dyn CommandCatalog>,
}

impl std::fmt::Debug for Offers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Offers").finish_non_exhaustive()
    }
}

/// The clock and the time zone of the user's computer.
#[derive(Clone)]
pub struct LocalClock {
    pub clock: Arc<dyn Clock>,
    pub zone: Arc<dyn TimeZone>,
}

impl std::fmt::Debug for LocalClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalClock").field("zone", &self.zone.name()).finish_non_exhaustive()
    }
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
        offers: Offers,
        time: LocalClock,
    ) -> Self {
        let Offers { models, backends, commands } = offers;
        Self { run, features, stats, config, models, backends, commands, time }
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

/// The models the picker offers for a backend profile. Every lane this build
/// runs takes the model with the request, so they all offer the Claude
/// catalog (the profile's own model while the catalog is not fetched yet). A
/// profile of a lane this build does not run (the metered providers) offers
/// its own model only, with why.
fn backend_models(
    config: &dyn ConfigSource,
    models: &dyn ModelCatalog,
    backends: &dyn BackendCatalog,
    name: &str,
) -> Result<BackendModelsResponse, ApiError> {
    let current = config.current();
    let profile =
        current.backends.get(name).ok_or_else(|| ApiError::NotFound(format!("backend \"{name}\" not found")))?;
    let kind = serde_json::to_value(profile.kind).ok().and_then(|k| k.as_str().map(str::to_owned)).unwrap_or_default();
    if !backends.descriptors().iter().any(|d| d.kind == kind) {
        let error = format!("{kind} sessions are not available in this version");
        return Ok(BackendModelsResponse { models: vec![profile.model.clone()], prices: None, error: Some(error) });
    }
    let ids: Vec<String> = models.models().into_iter().map(|m| m.id).collect();
    let models = if ids.is_empty() { vec![profile.model.clone()] } else { ids };
    Ok(BackendModelsResponse { models, prices: None, error: None })
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
        let time = self.time.clone();
        let datetime = move |_req: Request| {
            let now = time.clock.now_ms();
            let body = current_datetime(now, time.zone.offset_minutes_at(now), &time.zone.name());
            async move { Ok(Response::json(200, &body)) }
        };
        let (config, models, backends, features) =
            (self.config.clone(), self.models.clone(), self.backends.clone(), self.features.clone());
        let ui_config = move |_req: Request| {
            let body = ui_config(config.as_ref(), models.as_ref(), backends.as_ref(), &features);
            async move { Ok(Response::json(200, &body)) }
        };
        let (config, models, backends) = (self.config.clone(), self.models.clone(), self.backends.clone());
        let backend_models = move |req: Request| {
            let raw = req.param("name").unwrap_or_default();
            let name = percent_decode(raw).map_or_else(|| raw.to_owned(), |n| n.into_owned());
            let answer = backend_models(config.as_ref(), models.as_ref(), backends.as_ref(), &name);
            async move { Ok(Response::json(200, &answer?)) }
        };
        let catalog = self.commands.clone();
        let commands = move |req: Request| {
            let catalog = catalog.clone();
            let cwd = req.query().get("cwd").map(|c| c.into_owned()).filter(|c| !c.is_empty());
            async move {
                let commands = catalog.commands(cwd.as_deref().map(std::path::Path::new)).await;
                Ok(Response::json(200, &json!({"commands": commands})))
            }
        };
        vec![
            RouteDef::get("/commands", commands).access(Access::open().phone(Tier::Read)),
            RouteDef::get("/api/backends/{name}/models", backend_models).access(Access::open().phone(Tier::Read)),
            RouteDef::get("/health", health).access(Access::open().phone(Tier::Read)),
            RouteDef::get("/api/ui-config", ui_config).access(Access::open().phone(Tier::Read)),
            RouteDef::get("/datetime", datetime).access(Access::open()),
        ]
    }
}
