//! Geocoding and place search (`core/src/ports/Geocoder.ts`, `PlaceSearch.ts`).

use eos_contracts::{Area, GeocodeResult};
use serde_json::Value;

use crate::BoxFuture;

/// The map service did not answer usably. The text is a sentence for the
/// user or the model.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct GeoError(pub String);

pub trait Geocoder: Send + Sync + 'static {
    /// Places matching `q`, best first; `limit` is clamped to 1–10.
    fn search<'a>(&'a self, q: &'a str, limit: i64) -> BoxFuture<'a, Result<Vec<GeocodeResult>, GeoError>>;
    /// The district, city and country around a point; `None` when the
    /// service knows none.
    fn reverse(&self, lat: f64, lon: f64) -> BoxFuture<'_, Result<Option<Area>, GeoError>>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaceQuery {
    /// A name or a kind in free text ("ramen").
    pub query: Option<String>,
    /// A kind of place ("cafe", "pharmacy").
    pub category: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub radius_m: f64,
    pub limit: usize,
}

pub trait PlaceSearch: Send + Sync + 'static {
    /// `Place` entities near the point, nearest first, ready to put in a view.
    fn search<'a>(&'a self, query: &'a PlaceQuery) -> BoxFuture<'a, Result<Vec<Value>, GeoError>>;
}
