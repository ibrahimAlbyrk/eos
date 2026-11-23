//! Routine surfaces: the interfaces a run answers with outside a chat.
//!
//! - `GET /api/surfaces?routine=&place=`: the surfaces not archived;
//! - `GET /api/surfaces/:id`, `…/versions`, `…/versions/:version`: one
//!   surface, its designs newest first, one design with its body;
//! - `GET`/`PUT /api/surfaces/:id/state?scope=`: its small saved state, for
//!   the whole surface or one of its issues, announced on `surfaces:state`;
//! - `GET`/`PUT /api/settings/surfaces`: how surfaces read on this Mac, kept
//!   in `settings.json` under keys only that route writes.
//!
//! Surfaces belong to routines and hold the user's data: a surface's reads
//! are open to the user's own pages and the phone, its state to the user's
//! dashboard and the phone. Logs carry ids, levels, places and sizes, never
//! a title, a body or state.

mod routes;
mod settings;
mod wire;

use std::sync::Arc;

use eos_contracts::{ActionsRecord, SurfacesChange, SurfacesIssue, SurfacesState};
use eos_core::Clock;
use eos_core::store::{Store, UserSettingsStore};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ProtectedSettings};
use eos_runtime::router::RouteDef;

pub const SURFACES_CHANGE: Topic<SurfacesChange> = Topic::new("surfaces:change");
pub const SURFACES_ISSUE: Topic<SurfacesIssue> = Topic::new("surfaces:issue");
pub const SURFACES_STATE: Topic<SurfacesState> = Topic::new("surfaces:state");
pub const ACTIONS_RECORD: Topic<ActionsRecord> = Topic::new("actions:record");

/// What the module is built from.
pub struct SurfacesParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// `settings.json`, for the reading settings.
    pub settings: Arc<dyn UserSettingsStore>,
}

impl std::fmt::Debug for SurfacesParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfacesParts").finish_non_exhaustive()
    }
}

pub struct SurfacesModule {
    parts: Arc<SurfacesParts>,
}

impl std::fmt::Debug for SurfacesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfacesModule").finish_non_exhaustive()
    }
}

impl SurfacesModule {
    pub fn new(parts: SurfacesParts) -> Self {
        SurfacesModule { parts: Arc::new(parts) }
    }
}

impl Module for SurfacesModule {
    fn id(&self) -> &'static str {
        "surfaces"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut out = routes::all(&self.parts);
        out.extend(settings::all(&self.parts));
        out
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![SURFACES_CHANGE.decl(), SURFACES_ISSUE.decl(), SURFACES_STATE.decl(), ACTIONS_RECORD.decl()]
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(ProtectedSettings { keys: settings::KEYS.to_vec(), via: "PUT /api/settings/surfaces" })
    }
}
