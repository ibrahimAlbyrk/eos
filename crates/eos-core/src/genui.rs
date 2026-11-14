//! What the visual-answers feature offers the rest of Eos: the write path the
//! `present` and `present_app` tools store through, place search for
//! `find_places`, and this computer's position for `current_location`.
//! The feature implements these; the tools hold them as `Arc<dyn …>`.

use eos_contracts::{LocationResponse, PlacesRequest};
use eos_genui::{ViewProblem, ViewStats};
use serde_json::Value;

use crate::{BoxFuture, Error};

/// A stored view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedView {
    pub view_id: String,
    /// Slips that did not stop the view; the model fixes them next time.
    pub warnings: Vec<ViewProblem>,
    pub stats: ViewStats,
}

/// A stored app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedApp {
    pub view_id: String,
    pub warnings: Vec<ViewProblem>,
}

/// Why nothing was presented.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PresentRefusal {
    /// The caller is neither an orchestrator nor a focused session.
    #[error("only an orchestrator or a focused session can present — report to your orchestrator instead")]
    NotPresenter,
    /// The user switched visual answers (or apps) off. The text is the
    /// answer the model should take, not an error to retry.
    #[error("{0}")]
    SwitchedOff(&'static str),
    /// The input failed the check: every problem with its path.
    #[error("{}", eos_genui::format_problems(.0))]
    Rejected(Vec<ViewProblem>),
    #[error(transparent)]
    Failed(#[from] Error),
}

/// The one write path for visual answers. `input` is the tool's raw input.
pub trait VisualAnswers: Send + Sync + 'static {
    fn present_view<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedView, PresentRefusal>>;
    fn present_app<'a>(
        &'a self,
        worker_id: &'a str,
        input: Value,
    ) -> BoxFuture<'a, Result<PresentedApp, PresentRefusal>>;
}

/// Where a place search was centred.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaceCenter {
    pub lat: f64,
    pub lon: f64,
    /// The geocoder's name for it, when the search was given a place name.
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacesFound {
    /// `Place` entities, nearest first.
    pub places: Vec<Value>,
    pub attribution: &'static str,
    pub center: PlaceCenter,
    pub radius_m: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlacesError {
    /// The place name given as the centre is not on the map.
    #[error("{0}")]
    UnknownPlace(String),
    /// The map service did not answer usably.
    #[error("{0}")]
    Service(String),
}

pub trait Places: Send + Sync + 'static {
    fn find(&self, request: PlacesRequest) -> BoxFuture<'_, Result<PlacesFound, PlacesError>>;
}

/// Why the position was not given: a sentence, a short code the dashboard
/// knows, and the status the route answers with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct LocationRefusal {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

/// This computer's position, for the agents that may ask.
pub trait UserLocation: Send + Sync + 'static {
    /// The position with the area around it. Refused unless `worker_id` is an
    /// orchestrator or a focused session, and unless the user shares it.
    fn current_for<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<LocationResponse, LocationRefusal>>;
}
