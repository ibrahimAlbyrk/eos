//! This computer's position (`manager/modules/genui/location-routes.ts`, the
//! location source of `media.ts`): read by the window shell from the system's
//! location service, labelled with the area around it. Local-only; 403 unless
//! the user turned location sharing on, 503 while there is no shell to ask.
//!
//! Only the dashboard and the agents that hold `current_location` (an
//! orchestrator or a focused session) may read it: a spawned worker or any
//! other local page would otherwise borrow Eos's location permission.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{FOCUSED_ROLE, LocationResponse, Num};
use eos_core::genui::{LocationRefusal, UserLocation};
use eos_core::net::Geocoder;
use eos_core::shell::{Location, PositionError, PositionFix};
use eos_core::store::{Store, agent_caller};
use eos_core::{BoxFuture, Error};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::settings::Switches;

const AREA_TIMEOUT: Duration = Duration::from_secs(5);
const FORBIDDEN: &str = "location is only for the Eos app, an orchestrator or a focused session";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    SharingOff,
    AppOffline,
    Denied,
    Disabled,
    Unavailable,
    Timeout,
    Unsupported,
}

impl Reason {
    fn code(self) -> &'static str {
        match self {
            Reason::SharingOff => "sharing-off",
            Reason::AppOffline => "app-offline",
            Reason::Denied => "denied",
            Reason::Disabled => "disabled",
            Reason::Unavailable => "unavailable",
            Reason::Timeout => "timeout",
            Reason::Unsupported => "unsupported",
        }
    }

    fn status(self) -> u16 {
        match self {
            Reason::SharingOff | Reason::Denied | Reason::Disabled => 403,
            Reason::AppOffline | Reason::Unavailable | Reason::Unsupported => 503,
            Reason::Timeout => 504,
        }
    }

    fn text(self) -> &'static str {
        match self {
            Reason::SharingOff => {
                "Location sharing is off. The user can turn it on in Settings › General › Visual answers."
            }
            Reason::AppOffline => "The Eos app isn't running, so this Mac's location can't be read right now.",
            Reason::Denied => {
                "macOS hasn't given Eos location access. The user can allow it in System Settings › Privacy & Security › Location Services (or press Test in Settings › General › Visual answers)."
            }
            Reason::Disabled => {
                "Location Services are turned off on this Mac. The user can turn them on in System Settings › Privacy & Security › Location Services."
            }
            Reason::Unavailable => "This Mac couldn't work out where it is right now (no Wi-Fi location fix).",
            Reason::Timeout => {
                "macOS didn't return a location in time. If a location prompt is open, the user should allow it, then try again."
            }
            Reason::Unsupported => "This version of the Eos app can't read the location.",
        }
    }

    fn refusal(self, detail: Option<&str>) -> LocationRefusal {
        let message = match detail {
            Some(detail) => format!("{} ({detail})", self.text()),
            None => self.text().to_owned(),
        };
        LocationRefusal { status: self.status(), code: self.code(), message }
    }
}

impl From<PositionError> for Reason {
    fn from(e: PositionError) -> Self {
        match e {
            PositionError::Denied => Reason::Denied,
            PositionError::Disabled => Reason::Disabled,
            PositionError::Unavailable => Reason::Unavailable,
            PositionError::Timeout => Reason::Timeout,
            PositionError::Unsupported => Reason::Unsupported,
        }
    }
}

/// A fix the rest of Eos can use: on the globe, with an accuracy.
fn usable(fix: &PositionFix) -> bool {
    fix.lat.is_finite()
        && fix.lon.is_finite()
        && fix.lat.abs() <= 90.0
        && fix.lon.abs() <= 180.0
        && fix.accuracy.is_finite()
        && fix.accuracy >= 0.0
}

#[derive(Clone)]
pub(crate) struct LocationSource {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) switches: Switches,
    /// `None`: the core runs without a window shell.
    pub(crate) shell: Option<Arc<dyn Location>>,
    pub(crate) geocoder: Arc<dyn Geocoder>,
}

impl LocationSource {
    pub(crate) async fn current(&self) -> Result<LocationResponse, LocationRefusal> {
        if !self.switches.location_sharing() {
            return Err(Reason::SharingOff.refusal(None));
        }
        let Some(shell) = &self.shell else { return Err(Reason::AppOffline.refusal(None)) };
        let fix = shell.current().await.map_err(|e| Reason::from(e).refusal(None))?;
        if !usable(&fix) {
            return Err(Reason::Unsupported.refusal(Some("the app sent no coordinates")));
        }
        // The position is the answer; its label is a courtesy that may not come.
        let area = match tokio::time::timeout(AREA_TIMEOUT, self.geocoder.reverse(fix.lat, fix.lon)).await {
            Ok(Ok(area)) => area,
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "location: reverse geocode failed");
                None
            }
            Err(_) => None,
        };
        #[allow(clippy::cast_precision_loss)]
        let at = Num(fix.at as f64);
        Ok(LocationResponse { lat: Num(fix.lat), lon: Num(fix.lon), accuracy: Num(fix.accuracy), at, area })
    }

    /// Whether the agent a caller declares itself to be holds `current_location`.
    async fn is_reader(&self, agent: Option<String>) -> Result<bool, Error> {
        self.store
            .read(move |tx| {
                let workers = tx.workers();
                let Some(caller) = agent_caller(workers, agent.as_deref())? else { return Ok(false) };
                let worker = workers.find(&caller.id)?;
                Ok(worker.is_some_and(|w| w.is_orchestrator || w.agent_role.as_deref() == Some(FOCUSED_ROLE)))
            })
            .await
    }
}

impl UserLocation for LocationSource {
    fn current_for<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<LocationResponse, LocationRefusal>> {
        Box::pin(async move {
            match self.is_reader(Some(worker_id.to_owned())).await {
                Ok(true) => self.current().await,
                Ok(false) => Err(LocationRefusal { status: 403, code: "forbidden", message: FORBIDDEN.to_owned() }),
                Err(e) => Err(LocationRefusal { status: 500, code: "failed", message: e.to_string() }),
            }
        })
    }
}

fn refused(refusal: LocationRefusal) -> Response {
    ApiError::coded(refusal.status, refusal.message, refusal.code).into_response().header("cache-control", "no-store")
}

/// Where this computer is: never readable from another one.
pub(crate) fn route(source: LocationSource) -> RouteDef {
    RouteDef::get("/api/location", move |req: Request| {
        let source = source.clone();
        async move {
            let agent = req.headers.get("x-eos-agent-id").map(str::to_owned);
            if !req.speaks_for_user() && !source.is_reader(agent).await? {
                return Ok(refused(LocationRefusal { status: 403, code: "forbidden", message: FORBIDDEN.to_owned() }));
            }
            Ok(match source.current().await {
                Ok(position) => Response::json(200, &position).header("cache-control", "no-store"),
                Err(refusal) => refused(refusal),
            })
        }
    })
    .access(Access::open().local_only())
}
