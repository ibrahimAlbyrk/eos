//! `GET`/`PUT /api/surfaces/pins`: the surfaces pinned on this Mac's Home, at
//! most three, each once (D32: pins stay per Mac). A fourth answers 409, so
//! the dashboard offers to replace one. Every change is announced on
//! `surfaces:pins`; an archived surface loses its pin.

use std::sync::Arc;

use eos_contracts::{PinsBody, SurfacesPins};
use eos_core::Error;
use eos_core::store::{Outbox, Tx};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::limits::PIN_SLOTS;
use eos_surface::{PinError, arrange_pins};

use crate::{SURFACES_PINS, SurfacesParts};

/// Unpins a surface inside a write, announcing it when it was pinned.
pub(crate) fn unpin(tx: &dyn Tx, out: &mut Outbox, surface_id: &str) -> Result<(), Error> {
    if tx.surface_pins().remove(surface_id)? {
        out.push(SURFACES_PINS.name(), &SurfacesPins {});
    }
    Ok(())
}

fn ids(pins: Vec<(u8, String)>) -> PinsBody {
    PinsBody { surface_ids: pins.into_iter().map(|(_, id)| id).collect() }
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>) -> Vec<RouteDef> {
    let at = parts.clone();
    let read = RouteDef::get("/api/surfaces/pins", move |_req: Request| {
        let at = at.clone();
        async move {
            let pins = at.store.read(|tx| tx.surface_pins().list()).await?;
            Ok::<_, ApiError>(Response::json(200, &ids(pins)))
        }
    })
    .access(Access::open().phone(Tier::Read));

    let at = parts.clone();
    let write = RouteDef::put("/api/surfaces/pins", move |req: Request| {
        let at = at.clone();
        async move {
            let asked: PinsBody = req.parse()?;
            let pins = arrange_pins(&asked.surface_ids).map_err(|PinError::Full| {
                ApiError::Conflict(format!("Home holds {PIN_SLOTS} pins: replace one to pin another"))
            })?;
            let now = at.clock.now_ms();
            let pins = at
                .store
                .write(move |tx, out| {
                    for (_, id) in &pins {
                        let live = tx.surfaces().find(id)?.filter(|s| s.archived_at.is_none());
                        live.ok_or_else(|| Error::not_found("surface", id))?;
                    }
                    if tx.surface_pins().list()? != pins {
                        tx.surface_pins().replace(&pins, now)?;
                        out.push(SURFACES_PINS.name(), &SurfacesPins {});
                    }
                    Ok(pins)
                })
                .await?;
            tracing::info!(pins = pins.len(), "Home's pins were set");
            Ok(Response::json(200, &ids(pins)))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Low));
    vec![read, write]
}
