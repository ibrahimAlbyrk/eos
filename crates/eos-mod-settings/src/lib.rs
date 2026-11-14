//! Settings: the user's flat settings (`settings.json`), and two sections of the configuration (`config.json`) the
//! General pane edits, `archive` and `compaction`.
//!
//! | Route | |
//! |---|---|
//! | `GET`/`PUT /api/settings` | the flat settings; a key a feature protects is refused, naming the route that sets it |
//! | `GET`/`PUT /api/settings/archive` | `config.archive`: retention, purge at quit, what closing a tab does |
//! | `GET`/`PUT /api/settings/compaction` | `config.compaction`: on/off, threshold, summarizer timeout |
//!
//! A configuration section is merged into the file and the configuration is
//! read again, so what reads it next (the archive sweep, the compaction
//! trigger) sees the change at once.

use std::sync::Arc;

use eos_contracts::{ArchiveSettingsPatch, CompactionSettingsPatch, SettingsPatchRequest, SettingsResponse};
use eos_core::store::{ConfigSource, UserSettingsStore};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::module::{Module, ProtectedSettings};
use eos_runtime::router::RouteDef;
use serde::Serialize;
use serde_json::{Map, Value, json};

pub struct SettingsModule {
    settings: Arc<dyn UserSettingsStore>,
    config: Arc<dyn ConfigSource>,
    /// The keys other features set through routes of their own.
    protected: Arc<[ProtectedSettings]>,
}

impl std::fmt::Debug for SettingsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsModule").field("protected", &self.protected).finish_non_exhaustive()
    }
}

impl SettingsModule {
    /// `protected`: what the other features declare (`Module::protected_settings`).
    pub fn new(
        settings: Arc<dyn UserSettingsStore>,
        config: Arc<dyn ConfigSource>,
        protected: Vec<ProtectedSettings>,
    ) -> Self {
        Self { settings, config, protected: protected.into() }
    }
}

/// The fields a patch names, as `config.json` spells them.
fn fields<T: Serialize>(patch: &T) -> Map<String, Value> {
    match serde_json::to_value(patch) {
        Ok(Value::Object(fields)) => fields,
        _ => Map::new(),
    }
}

/// Merges `patch` into the `section` of `config.json`, off the async threads.
async fn write_section(
    config: &Arc<dyn ConfigSource>,
    section: &'static str,
    patch: Map<String, Value>,
) -> Result<(), ApiError> {
    let config = config.clone();
    let written = tokio::task::spawn_blocking(move || config.patch(section, patch).map(drop)).await;
    let failed = |e: &dyn std::fmt::Display| ApiError::Internal(format!("failed to write config: {e}"));
    match written {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(failed(&e)),
        Err(e) => Err(failed(&e)),
    }
}

fn read_settings(m: &SettingsModule) -> RouteDef {
    let settings = m.settings.clone();
    RouteDef::get("/api/settings", move |_req: Request| {
        let body = SettingsResponse { settings: settings.read() };
        async move { Ok(Response::json(200, &body)) }
    })
    .access(Access::open().phone(Tier::Read))
}

fn write_settings(m: &SettingsModule) -> RouteDef {
    let (settings, protected) = (m.settings.clone(), m.protected.clone());
    RouteDef::put("/api/settings", move |req: Request| {
        let (settings, protected) = (settings.clone(), protected.clone());
        async move {
            let body: SettingsPatchRequest = req.parse()?;
            // This route takes no user token: an agent must not undo a choice only the user may make.
            if let Some(refusal) = protected.iter().find_map(|p| p.refusal(body.settings.keys().map(String::as_str))) {
                return Err(ApiError::PermissionDenied(refusal));
            }
            Ok(Response::json(200, &SettingsResponse { settings: settings.patch(body.settings)? }))
        }
    })
    .access(Access::open().phone(Tier::High))
}

fn archive(m: &SettingsModule) -> Vec<RouteDef> {
    let config = m.config.clone();
    let read = move |_req: Request| {
        let body = json!({"archive": config.current().archive});
        async move { Ok(Response::json(200, &body)) }
    };
    let config = m.config.clone();
    let write = move |req: Request| {
        let config = config.clone();
        async move {
            let patch: ArchiveSettingsPatch = req.parse()?;
            write_section(&config, "archive", fields(&patch)).await?;
            Ok(Response::json(200, &json!({"archive": config.current().archive})))
        }
    };
    vec![
        RouteDef::get("/api/settings/archive", read).access(Access::open()),
        RouteDef::put("/api/settings/archive", write).access(Access::open()),
    ]
}

fn compaction(m: &SettingsModule) -> Vec<RouteDef> {
    let config = m.config.clone();
    let read = move |_req: Request| {
        let body = json!({"compaction": config.current().compaction});
        async move { Ok(Response::json(200, &body)) }
    };
    let config = m.config.clone();
    let write = move |req: Request| {
        let config = config.clone();
        async move {
            let patch: CompactionSettingsPatch = req.parse()?;
            write_section(&config, "compaction", fields(&patch)).await?;
            Ok(Response::json(200, &json!({"compaction": config.current().compaction})))
        }
    };
    vec![
        RouteDef::get("/api/settings/compaction", read).access(Access::open()),
        RouteDef::put("/api/settings/compaction", write).access(Access::open()),
    ]
}

impl Module for SettingsModule {
    fn id(&self) -> &'static str {
        "settings"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut all = vec![read_settings(self), write_settings(self)];
        all.extend(archive(self));
        all.extend(compaction(self));
        all
    }
}
