//! Places near a point or a named place (`POST /api/genui/places`, the
//! `find_places` tool): the centre is geocoded when it is a name, then the
//! place search runs around it.

use std::sync::Arc;

use eos_contracts::{PlacesRequest, PlacesRequestNear};
use eos_core::BoxFuture;
use eos_core::genui::{PlaceCenter, Places, PlacesError, PlacesFound};
use eos_core::net::{Geocoder, PlaceQuery, PlaceSearch};

pub(crate) const OSM_ATTRIBUTION: &str = "© OpenStreetMap contributors (ODbL)";
const DEFAULT_RADIUS_M: i64 = 1500;
const DEFAULT_LIMIT: i64 = 12;

#[derive(Clone)]
pub(crate) struct PlaceFinder {
    pub(crate) geocoder: Arc<dyn Geocoder>,
    pub(crate) search: Arc<dyn PlaceSearch>,
}

impl Places for PlaceFinder {
    fn find(&self, request: PlacesRequest) -> BoxFuture<'_, Result<PlacesFound, PlacesError>> {
        Box::pin(async move {
            let service = |e: eos_core::net::GeoError| PlacesError::Service(e.0);
            let center = match request.near {
                PlacesRequestNear::LatLon(point) => {
                    PlaceCenter { lat: point.lat.as_f64(), lon: point.lon.as_f64(), label: None }
                }
                PlacesRequestNear::Text(name) => {
                    let hits = self.geocoder.search(&name.text, 1).await.map_err(service)?;
                    let Some(hit) = hits.into_iter().next() else {
                        return Err(PlacesError::UnknownPlace(format!(
                            "Couldn't find \"{}\" on the map — try a fuller name (street, district, city).",
                            name.text
                        )));
                    };
                    PlaceCenter { lat: hit.lat.as_f64(), lon: hit.lon.as_f64(), label: Some(hit.label) }
                }
            };
            let radius_m = request.radius_m.unwrap_or(DEFAULT_RADIUS_M);
            let query = PlaceQuery {
                query: request.query,
                category: request.category,
                lat: center.lat,
                lon: center.lon,
                #[allow(clippy::cast_precision_loss)]
                radius_m: radius_m as f64,
                limit: usize::try_from(request.limit.unwrap_or(DEFAULT_LIMIT)).unwrap_or(0),
            };
            let places = self.search.search(&query).await.map_err(service)?;
            Ok(PlacesFound { places, attribution: OSM_ATTRIBUTION, center, radius_m })
        })
    }
}
