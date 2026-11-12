//! Forward and reverse geocoding through OpenStreetMap's Nominatim, within its
//! usage policy (`infra/src/genui/geo/NominatimGeocoder.ts`): an identifying
//! User-Agent, at most one request per second (one queue for the whole app),
//! and every answer cached on disk, so a repeated pin or a reopened view
//! never asks again.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use eos_contracts::{Area, GeocodeResult, Num};
use eos_core::net::{GeoError, Geocoder};
use eos_core::{BoxFuture, Clock};
use reqwest::header::{ACCEPT, USER_AGENT};
use serde_json::Value;
use url::form_urlencoded;

use super::ttl_store::JsonTtlStore;
use crate::map::root_cause;
use crate::num::to_fixed;

pub const NOMINATIM_URL: &str = "https://nominatim.openstreetmap.org";

const MIN_INTERVAL_MS: i64 = 1000;
const TIMEOUT: Duration = Duration::from_secs(8);
const HIT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Asks beyond this many waiting are refused rather than queued for a minute.
const MAX_WAITING: usize = 30;

/// Waits between two requests. The app sleeps; a test moves its clock.
pub(crate) use crate::Sleep;

fn text<'a>(fields: &'a Value, key: &str) -> Option<&'a str> {
    fields.get(key).and_then(Value::as_str)
}

/// The district, city and country an address names, from whichever of its
/// parts exist.
pub(crate) fn area_of(address: Option<&Value>) -> Option<Area> {
    let address = address.filter(|address| address.is_object())?;
    let pick = |keys: &[&str]| {
        keys.iter()
            .filter_map(|key| text(address, key))
            .map(eos_domain::text::js_trim)
            .find(|part| !part.is_empty())
            .map(str::to_owned)
    };
    let area = Area {
        district: pick(&["suburb", "city_district", "district", "borough", "quarter", "neighbourhood"]),
        city: pick(&["city", "town", "village", "municipality", "county", "province", "state"]),
        country: pick(&["country"]),
    };
    (area.district.is_some() || area.city.is_some() || area.country.is_some()).then_some(area)
}

/// `Number(value)`; a missing value is not a number.
fn number(value: Option<&Value>) -> f64 {
    let Some(value) = value else { return f64::NAN };
    serde_json::from_value::<eos_genui::Value>(value.clone()).map_or(f64::NAN, |value| value.to_js_number())
}

/// One Nominatim place as a result, or `None` when it has no usable position.
pub(crate) fn to_geocode_result(place: &Value) -> Option<GeocodeResult> {
    let (lat, lon) = (number(place.get("lat")), number(place.get("lon")));
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    let named = |key| text(place, key).filter(|name| !name.is_empty()).map(str::to_owned);
    let label = named("display_name")
        .or_else(|| named("name"))
        .unwrap_or_else(|| format!("{}, {}", to_fixed(lat, 5), to_fixed(lon, 5)));
    Some(GeocodeResult {
        lat: Num(lat),
        lon: Num(lon),
        label,
        area: area_of(place.get("address")),
        kind: named("type").or_else(|| named("addresstype")),
    })
}

/// `URLSearchParams` over the pairs.
fn query(pairs: &[(&str, &str)]) -> String {
    form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

struct Turn {
    /// When the previous request started.
    last_start: Option<i64>,
}

pub struct NominatimGeocoder {
    client: reqwest::Client,
    clock: Arc<dyn Clock>,
    sleep: Sleep,
    store: JsonTtlStore,
    user_agent: String,
    base_url: String,
    /// Fair: requests go out in the order they were asked.
    turn: tokio::sync::Mutex<Turn>,
    waiting: AtomicUsize,
}

impl std::fmt::Debug for NominatimGeocoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NominatimGeocoder").field("base_url", &self.base_url).finish_non_exhaustive()
    }
}

impl NominatimGeocoder {
    pub(crate) fn new(
        client: reqwest::Client,
        clock: Arc<dyn Clock>,
        sleep: Sleep,
        store: JsonTtlStore,
        user_agent: String,
        base_url: &str,
    ) -> Self {
        Self {
            client,
            clock,
            sleep,
            store,
            user_agent,
            base_url: base_url.trim_end_matches('/').to_owned(),
            turn: tokio::sync::Mutex::new(Turn { last_start: None }),
            waiting: AtomicUsize::new(0),
        }
    }

    async fn search_places(&self, q: &str, limit: i64) -> Result<Vec<GeocodeResult>, GeoError> {
        let query_text = eos_domain::text::collapse_spaces(eos_domain::text::js_trim(q));
        if query_text.is_empty() {
            return Ok(Vec::new());
        }
        let n = limit.clamp(1, 10);
        let key = format!("s:{n}:{}", query_text.to_lowercase());
        if let Some(hit @ Value::Array(_)) = self.store.get(&key)
            && let Ok(known) = serde_json::from_value::<Vec<GeocodeResult>>(hit)
        {
            return Ok(known);
        }
        let params =
            query(&[("q", &query_text), ("format", "jsonv2"), ("addressdetails", "1"), ("limit", &n.to_string())]);
        let raw = self.request(format!("{}/search?{params}", self.base_url)).await?;
        let list: Vec<GeocodeResult> =
            raw.as_array().map(|places| places.iter().filter_map(to_geocode_result).collect()).unwrap_or_default();
        let ttl = if list.is_empty() { EMPTY_TTL_MS } else { HIT_TTL_MS };
        self.store.set(&key, serde_json::to_value(&list).unwrap_or(Value::Array(Vec::new())), ttl);
        Ok(list)
    }

    /// Coordinates are rounded to about 100 m before they leave this computer
    /// (and that is the cache key too).
    async fn reverse_area(&self, lat: f64, lon: f64) -> Result<Option<Area>, GeoError> {
        let (lat, lon) = (to_fixed(lat, 3), to_fixed(lon, 3));
        let key = format!("r:{lat},{lon}");
        if let Some(hit) = self.store.get(&key) {
            return Ok(serde_json::from_value::<Area>(hit).ok());
        }
        let params =
            query(&[("lat", &lat), ("lon", &lon), ("format", "jsonv2"), ("addressdetails", "1"), ("zoom", "14")]);
        let raw = self.request(format!("{}/reverse?{params}", self.base_url)).await?;
        let area = area_of(raw.get("address"));
        let ttl = if area.is_some() { HIT_TTL_MS } else { EMPTY_TTL_MS };
        self.store.set(&key, serde_json::to_value(&area).unwrap_or(Value::Null), ttl);
        Ok(area)
    }

    /// One request at a time, each starting at least a second after the one before.
    async fn request(&self, url: String) -> Result<Value, GeoError> {
        if self.waiting.load(Ordering::SeqCst) >= MAX_WAITING {
            return Err(GeoError("too many place lookups at once — try again in a moment".to_owned()));
        }
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let waiting = Waiting(&self.waiting);
        let mut turn = self.turn.lock().await;
        if let Some(last_start) = turn.last_start {
            let wait = last_start + MIN_INTERVAL_MS - self.clock.now_ms();
            if wait > 0 {
                (self.sleep)(Duration::from_millis(wait.unsigned_abs())).await;
            }
        }
        turn.last_start = Some(self.clock.now_ms());
        drop(waiting);
        match tokio::time::timeout(TIMEOUT, self.fetch_json(&url)).await {
            Ok(answer) => answer,
            Err(_) => Err(GeoError("OpenStreetMap geocoding timed out".to_owned())),
        }
    }

    async fn fetch_json(&self, url: &str) -> Result<Value, GeoError> {
        let failed = |e: &reqwest::Error| GeoError(format!("OpenStreetMap geocoding failed: {}", root_cause(e)));
        let response = self
            .client
            .get(url)
            .header(USER_AGENT, &self.user_agent)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| failed(&e))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let limited = if status == 429 { " (rate limited)" } else { "" };
            return Err(GeoError(format!("OpenStreetMap geocoding answered {status}{limited}")));
        }
        let body = response.bytes().await.map_err(|e| failed(&e))?;
        serde_json::from_slice(&body).map_err(|e| GeoError(format!("OpenStreetMap geocoding failed: {e}")))
    }

    /// Resolves once every answer cached so far is on disk.
    pub async fn flush(&self) {
        self.store.flush().await;
    }
}

/// One ask waiting for its turn; counted down when the turn starts or the
/// caller goes away.
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Geocoder for NominatimGeocoder {
    fn search<'a>(&'a self, q: &'a str, limit: i64) -> BoxFuture<'a, Result<Vec<GeocodeResult>, GeoError>> {
        Box::pin(self.search_places(q, limit))
    }

    fn reverse(&self, lat: f64, lon: f64) -> BoxFuture<'_, Result<Option<Area>, GeoError>> {
        Box::pin(self.reverse_area(lat, lon))
    }
}
