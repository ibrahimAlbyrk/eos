//! Media and map routes for visual answers (`manager/modules/genui/media-routes.ts`).
//!
//! | Route | |
//! |---|---|
//! | `GET /api/genui/media/img?src=` | an image, fetched for the dashboard |
//! | `GET /api/genui/media/og?url=` | a page's preview image |
//! | `GET /api/genui/media/icon?site=` | a site's icon |
//! | `GET /api/genui/map/style.json` | the map style |
//! | `GET /api/genui/map/t/{path}` | tiles, glyphs, sprites |
//! | `GET /api/genui/geocode?q=` | place names to coordinates |
//! | `POST /api/genui/places` | places near a point (`find_places`) |
//!
//! The media and map routes are the user's dashboard's alone: the window
//! shell adds the token to the dashboard's `<img>` and map requests, and
//! agents get no fetch proxy. Nothing they serve is ever a document.

use std::sync::Arc;

use eos_contracts::{GeocodeQuery, GeocodeResponse, MediaIconQuery, MediaImgQuery, MediaOgQuery, PlacesRequest};
use eos_core::genui::{Places, PlacesError};
use eos_core::net::{Geocoder, MapResponse, MapTiles, MediaBlob, MediaFetcher};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::places::{OSM_ATTRIBUTION, PlaceFinder};

/// Served bytes are never a document: an SVG or a stray HTML answer opened
/// directly cannot run anything on the app's origin.
const INERT_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

pub(crate) struct MediaParts {
    pub(crate) media: Arc<dyn MediaFetcher>,
    pub(crate) map: Arc<dyn MapTiles>,
    pub(crate) geocoder: Arc<dyn Geocoder>,
    pub(crate) places: PlaceFinder,
}

pub(crate) fn all(parts: MediaParts) -> Vec<RouteDef> {
    let MediaParts { media, map, geocoder, places } = parts;
    vec![
        blob_route("/api/genui/media/img", media.clone(), |media, q: MediaImgQuery| {
            Box::pin(async move { media.image(&q.src).await })
        }),
        blob_route("/api/genui/media/og", media.clone(), |media, q: MediaOgQuery| {
            Box::pin(async move { media.og(&q.url).await })
        }),
        blob_route("/api/genui/media/icon", media, |media, q: MediaIconQuery| {
            Box::pin(async move { media.icon(&q.site).await })
        }),
        map_style(map.clone()),
        map_resource(map),
        geocode(geocoder),
        places_route(places),
    ]
}

/// A frame or window opened on the proxy (an app trying to carry data out in
/// a query string) is refused before any fetch; `<img>`, fetch and workers pass.
pub(crate) fn is_navigation(dest: Option<&str>) -> bool {
    dest.is_some_and(|dest| {
        ["document", "iframe", "frame", "embed", "object"].iter().any(|nav| dest.eq_ignore_ascii_case(nav))
    })
}

fn not_a_page(req: &Request) -> Result<(), ApiError> {
    if is_navigation(req.headers.get("sec-fetch-dest")) {
        return Err(ApiError::PermissionDenied("not a page".into()));
    }
    Ok(())
}

/// The query string as the contract type `T`, checked against its rules.
fn query<T: DeserializeOwned + eos_contracts::Validate>(req: &Request) -> Result<T, ApiError> {
    let mut fields = Map::new();
    for (name, value) in req.query().iter() {
        fields.insert(name.into_owned(), Value::String(value.into_owned()));
    }
    Ok(eos_contracts::parse(&Value::Object(fields))?)
}

type Fetched = eos_core::BoxFuture<'static, Option<MediaBlob>>;

fn blob_route<Q>(
    pattern: &'static str,
    media: Arc<dyn MediaFetcher>,
    fetch: fn(Arc<dyn MediaFetcher>, Q) -> Fetched,
) -> RouteDef
where
    Q: DeserializeOwned + eos_contracts::Validate + Send + 'static,
{
    RouteDef::get(pattern, move |req: Request| {
        let media = media.clone();
        async move {
            not_a_page(&req)?;
            let q: Q = query(&req)?;
            Ok(blob_response(&req, fetch(media, q).await))
        }
    })
    .access(Access::ui_token())
}

fn blob_response(req: &Request, blob: Option<MediaBlob>) -> Response {
    let Some(blob) = blob else {
        return Response::error(404, "no image").header("cache-control", "private, max-age=3600");
    };
    let unchanged = req.headers.get("if-none-match") == Some(blob.etag.as_str());
    let answer = if unchanged { Response::new(304) } else { Response::new(200).body(blob.body.into()) };
    answer
        .header("content-type", blob.content_type)
        .header("cache-control", "private, max-age=604800")
        .header("etag", blob.etag)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", INERT_CSP)
}

/// The types a map resource is served as; anything else goes out as bytes.
fn map_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "application/json"
            | "application/x-protobuf"
            | "application/vnd.mapbox-vector-tile"
            | "image/png"
            | "image/jpeg"
            | "image/webp"
    )
}

/// Tiles come from one trusted host, but nothing it sends is served as a page here.
fn map_response(m: MapResponse) -> Response {
    let content_type = if map_type(&m.content_type) { m.content_type } else { "application/octet-stream".to_owned() };
    Response::new(m.status)
        .body(m.body.into())
        .header("content-type", content_type)
        .header("cache-control", m.cache_control)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", INERT_CSP)
}

fn map_style(map: Arc<dyn MapTiles>) -> RouteDef {
    RouteDef::get("/api/genui/map/style.json", move |req: Request| {
        let map = map.clone();
        async move {
            not_a_page(&req)?;
            Ok(map_response(map.style().await))
        }
    })
    .access(Access::ui_token())
}

fn map_resource(map: Arc<dyn MapTiles>) -> RouteDef {
    RouteDef::get("/api/genui/map/t/{*path}", move |req: Request| {
        let map = map.clone();
        async move {
            not_a_page(&req)?;
            Ok(map_response(map.get(req.param("path").unwrap_or_default()).await))
        }
    })
    .access(Access::ui_token())
}

fn geocode(geocoder: Arc<dyn Geocoder>) -> RouteDef {
    RouteDef::get("/api/genui/geocode", move |req: Request| {
        let geocoder = geocoder.clone();
        async move {
            let q: GeocodeQuery = query(&req)?;
            match geocoder.search(&q.q, q.limit.unwrap_or(5)).await {
                Ok(results) => {
                    Ok(Response::json(200, &GeocodeResponse { results, attribution: OSM_ATTRIBUTION.to_owned() }))
                }
                Err(e) => Err(ApiError::status_with(502, e.0)),
            }
        }
    })
    .access(Access::open())
}

/// Where the search was centred, beside the contract's fields.
#[derive(Serialize)]
struct Center {
    lat: f64,
    lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacesAnswer {
    places: Vec<Value>,
    attribution: &'static str,
    center: Center,
    radius_m: i64,
}

/// The body as a place search. A body without `near` is worded as today's
/// schema worded it (a union that matched nothing), not as a missing field.
fn places_request(req: &Request) -> Result<PlacesRequest, ApiError> {
    let body: Value = req.json()?;
    if body.as_object().is_some_and(|fields| !fields.contains_key("near")) {
        return Err(ApiError::invalid([("near", "Invalid input")]));
    }
    req.parse()
}

fn places_route(places: PlaceFinder) -> RouteDef {
    RouteDef::post("/api/genui/places", move |req: Request| {
        let places = places.clone();
        async move {
            match places.find(places_request(&req)?).await {
                Ok(found) => Ok(Response::json(
                    200,
                    &PlacesAnswer {
                        places: found.places,
                        attribution: found.attribution,
                        center: Center { lat: found.center.lat, lon: found.center.lon, label: found.center.label },
                        radius_m: found.radius_m,
                    },
                )),
                Err(PlacesError::UnknownPlace(text)) => Err(ApiError::NotFound(text)),
                Err(PlacesError::Service(text)) => Err(ApiError::status_with(502, text)),
            }
        }
    })
    .access(Access::open())
}
