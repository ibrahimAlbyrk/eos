//! Visual answers, the server side.
//!
//! `present` and `present_app` store through one write path ([`Presenter`]);
//! the dashboard reads the stored record and keeps each view's UI state; the
//! media, map, geocoding and place routes fetch for the dashboard through
//! guarded adapters; this computer's position is read from the window shell.
//! The user's switches (Settings › General) are this feature's own settings,
//! and the level reaches the prompt as `GENUI_LEVEL` / `GENUI_OFF`.
//!
//! A click on a view's send action is not a route here: the dashboard posts
//! it with the message (`…/message { text, action }`), and the message
//! dispatcher turns it into the turn the model reads
//! (`eos_domain::view_action::view_action_turn`).
//!
//! What other features use: [`GenuiModule::visual_answers`],
//! [`GenuiModule::places`] and [`GenuiModule::user_location`] — the traits
//! of `eos_core::genui`, for the agent tools.

mod location;
mod media_routes;
mod places;
mod present;
mod prompt;
mod routes;
mod settings;
mod settings_routes;

use std::sync::Arc;

use eos_contracts::{GenuiChange, GenuiDelta};
use eos_core::agent::ToolInputDelta;
use eos_core::genui::{Places, UserLocation, VisualAnswers};
use eos_core::net::{Geocoder, MapTiles, MediaFetcher, PlaceSearch};
use eos_core::shell::Location;
use eos_core::store::{ConfigSource, Store, UserSettingsStore};
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Scope, ScopeKind, Topic, TopicDecl};
use eos_runtime::module::{Module, PromptValue, ProtectedSettings};
use eos_runtime::router::RouteDef;
use serde::Serialize;

use location::LocationSource;
use places::PlaceFinder;
use present::Presenter;
use settings::Switches;

/// A view's UI state was replaced.
pub const GENUI_CHANGE: Topic<GenuiChange> = Topic::new(eos_genui::wire::TOPIC_CHANGE);
/// A visual answer's tool input while the model writes it. Its own topic, so
/// what reads live text (the transcript, the phone) never sees tool JSON.
/// Never stored; a tab hears it only for the workers it has on screen.
pub const GENUI_DELTA: Topic<GenuiDelta> =
    Topic::scoped(eos_genui::wire::TOPIC_DELTA, ScopeKind::Worker, |delta| Some(delta.worker_id.as_str()));

/// Only Eos's own servers: another MCP server's `present` is an ordinary tool.
const FOLLOWED_TOOLS: [&str; 4] = [
    "mcp__orchestrator__present",
    "mcp__orchestrator__present_app",
    "mcp__worker__present",
    "mcp__worker__present_app",
];

/// What the feature is built from.
#[derive(Clone)]
pub struct GenuiParts {
    pub store: Arc<dyn Store>,
    pub settings: Arc<dyn UserSettingsStore>,
    pub config: Arc<dyn ConfigSource>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub bus: Bus,
    pub media: Arc<dyn MediaFetcher>,
    pub map: Arc<dyn MapTiles>,
    pub geocoder: Arc<dyn Geocoder>,
    pub place_search: Arc<dyn PlaceSearch>,
    /// The window shell's reading of the system's location service; `None`
    /// when the core runs without a shell.
    pub location: Option<Arc<dyn Location>>,
}

impl std::fmt::Debug for GenuiParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenuiParts").field("location", &self.location.is_some()).finish_non_exhaustive()
    }
}

pub struct GenuiModule {
    parts: GenuiParts,
    switches: Switches,
    presenter: Presenter,
    places: PlaceFinder,
    location: LocationSource,
}

impl std::fmt::Debug for GenuiModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenuiModule").field("parts", &self.parts).finish_non_exhaustive()
    }
}

impl GenuiModule {
    pub fn new(parts: GenuiParts) -> Self {
        let switches = Switches { settings: parts.settings.clone(), config: parts.config.clone() };
        let presenter = Presenter {
            store: parts.store.clone(),
            switches: switches.clone(),
            clock: parts.clock.clone(),
            ids: parts.ids.clone(),
        };
        let places = PlaceFinder { geocoder: parts.geocoder.clone(), search: parts.place_search.clone() };
        let location = LocationSource {
            store: parts.store.clone(),
            switches: switches.clone(),
            shell: parts.location.clone(),
            geocoder: parts.geocoder.clone(),
        };
        Self { parts, switches, presenter, places, location }
    }

    /// The write path of the `present` and `present_app` tools.
    pub fn visual_answers(&self) -> Arc<dyn VisualAnswers> {
        Arc::new(self.presenter.clone())
    }

    /// Place search for the `find_places` tool.
    pub fn places(&self) -> Arc<dyn Places> {
        Arc::new(self.places.clone())
    }

    /// This computer's position for the `current_location` tool.
    pub fn user_location(&self) -> Arc<dyn UserLocation> {
        Arc::new(self.location.clone())
    }
}

/// One `genui:delta` frame, written straight from the engine's piece: the
/// payload is serialized once and nothing is copied on the way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaFrame<'a> {
    worker_id: &'a str,
    #[serde(flatten)]
    delta: &'a ToolInputDelta,
}

impl Module for GenuiModule {
    fn id(&self) -> &'static str {
        "genui"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = routes::all(self.presenter.clone());
        routes.extend(media_routes::all(media_routes::MediaParts {
            media: self.parts.media.clone(),
            map: self.parts.map.clone(),
            geocoder: self.parts.geocoder.clone(),
            places: self.places.clone(),
        }));
        routes.push(location::route(self.location.clone()));
        routes.extend(settings_routes::all(self.switches.clone()));
        routes
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![GENUI_CHANGE.decl(), GENUI_DELTA.decl()]
    }

    fn prompt_variables(&self) -> Vec<(&'static str, PromptValue)> {
        prompt::variables(self.switches.read().level)
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(ProtectedSettings { keys: settings::PROTECTED_KEYS.to_vec(), via: settings::SETTINGS_ROUTE })
    }

    fn follows_tool_input(&self, tool: &str) -> bool {
        FOLLOWED_TOOLS.contains(&tool)
    }

    fn on_tool_input_delta(&self, worker_id: &str, delta: &ToolInputDelta) {
        match serde_json::to_vec(&DeltaFrame { worker_id, delta }) {
            Ok(frame) => self.parts.bus.publish_raw(GENUI_DELTA.name(), Some(Scope::worker(worker_id)), frame.into()),
            Err(e) => tracing::error!(error = %e, "a genui:delta frame could not be serialized; dropped"),
        }
    }
}
