//! Fakes of the ports behind visual answers: images, the map, geocoding,
//! place search and this computer's position. Each answers what the test put
//! in and remembers what it was asked.

use std::collections::HashMap;
use std::sync::Mutex;

use bytes::Bytes;
use eos_contracts::{Area, GeocodeResult};
use eos_core::BoxFuture;
use eos_core::net::{GeoError, Geocoder, MapResponse, MapTiles, MediaBlob, MediaFetcher, PlaceQuery, PlaceSearch};
use eos_core::shell::{Location, PositionError, PositionFix};
use serde_json::Value;

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

/// Images by what was asked for: an image URL, `og:<page url>`, `icon:<site>`.
#[derive(Debug, Default)]
pub struct FakeMedia {
    pub images: Mutex<HashMap<String, MediaBlob>>,
    pub asked: Mutex<Vec<String>>,
}

impl FakeMedia {
    pub fn with(self, key: &str, content_type: &str, body: &'static [u8], etag: &str) -> Self {
        let blob = MediaBlob {
            content_type: content_type.to_owned(),
            body: Bytes::from_static(body),
            etag: etag.to_owned(),
            fetched_at: 0,
        };
        self.images.lock().expect("images").insert(key.to_owned(), blob);
        self
    }

    fn answer(&self, key: String) -> Option<MediaBlob> {
        let blob = self.images.lock().expect("images").get(&key).cloned();
        self.asked.lock().expect("asked").push(key);
        blob
    }
}

impl MediaFetcher for FakeMedia {
    fn image<'a>(&'a self, src: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        ready(self.answer(src.to_owned()))
    }

    fn og<'a>(&'a self, page_url: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        ready(self.answer(format!("og:{page_url}")))
    }

    fn icon<'a>(&'a self, site: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        ready(self.answer(format!("icon:{site}")))
    }
}

/// Map resources by path; the style is the path `style`. An unknown path is
/// the proxy's own 404.
#[derive(Debug, Default)]
pub struct FakeMap {
    pub resources: Mutex<HashMap<String, MapResponse>>,
    pub asked: Mutex<Vec<String>>,
}

impl FakeMap {
    pub fn with(self, path: &str, content_type: &str, body: &'static [u8]) -> Self {
        let response = MapResponse {
            status: 200,
            content_type: content_type.to_owned(),
            body: Bytes::from_static(body),
            cache_control: "private, max-age=604800",
        };
        self.resources.lock().expect("resources").insert(path.to_owned(), response);
        self
    }

    fn answer(&self, path: &str) -> MapResponse {
        self.asked.lock().expect("asked").push(path.to_owned());
        self.resources.lock().expect("resources").get(path).cloned().unwrap_or(MapResponse {
            status: 404,
            content_type: "application/json".to_owned(),
            body: Bytes::from_static(br#"{"error":"no such map resource"}"#),
            cache_control: "private, max-age=300",
        })
    }
}

impl MapTiles for FakeMap {
    fn style(&self) -> BoxFuture<'_, MapResponse> {
        ready(self.answer("style"))
    }

    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, MapResponse> {
        ready(self.answer(path))
    }
}

/// A geocoder that knows the places it was given; `fail` makes every lookup
/// fail with that sentence.
#[derive(Debug, Default)]
pub struct FakeGeocoder {
    pub places: Mutex<HashMap<String, Vec<GeocodeResult>>>,
    pub area: Mutex<Option<Area>>,
    pub fail: Mutex<Option<String>>,
    pub searched: Mutex<Vec<(String, i64)>>,
    pub reversed: Mutex<Vec<(f64, f64)>>,
}

impl FakeGeocoder {
    fn failure(&self) -> Option<GeoError> {
        self.fail.lock().expect("fail").clone().map(GeoError)
    }
}

impl Geocoder for FakeGeocoder {
    fn search<'a>(&'a self, q: &'a str, limit: i64) -> BoxFuture<'a, Result<Vec<GeocodeResult>, GeoError>> {
        self.searched.lock().expect("searched").push((q.to_owned(), limit));
        let found = self.places.lock().expect("places").get(q).cloned().unwrap_or_default();
        ready(self.failure().map_or(Ok(found), Err))
    }

    fn reverse(&self, lat: f64, lon: f64) -> BoxFuture<'_, Result<Option<Area>, GeoError>> {
        self.reversed.lock().expect("reversed").push((lat, lon));
        let area = self.area.lock().expect("area").clone();
        ready(self.failure().map_or(Ok(area), Err))
    }
}

/// A place search that answers one fixed list.
#[derive(Debug, Default)]
pub struct FakePlaceSearch {
    pub places: Mutex<Vec<Value>>,
    pub fail: Mutex<Option<String>>,
    pub asked: Mutex<Vec<PlaceQuery>>,
}

impl PlaceSearch for FakePlaceSearch {
    fn search<'a>(&'a self, query: &'a PlaceQuery) -> BoxFuture<'a, Result<Vec<Value>, GeoError>> {
        self.asked.lock().expect("asked").push(query.clone());
        let failure = self.fail.lock().expect("fail").clone().map(GeoError);
        ready(failure.map_or_else(|| Ok(self.places.lock().expect("places").clone()), Err))
    }
}

/// The system's location service, answering what the test set.
#[derive(Debug)]
pub struct FakeLocation {
    pub answer: Mutex<Result<PositionFix, PositionError>>,
    pub asked: Mutex<usize>,
}

impl FakeLocation {
    pub fn at(fix: PositionFix) -> Self {
        Self { answer: Mutex::new(Ok(fix)), asked: Mutex::new(0) }
    }

    pub fn failing(error: PositionError) -> Self {
        Self { answer: Mutex::new(Err(error)), asked: Mutex::new(0) }
    }
}

impl Location for FakeLocation {
    fn current(&self) -> BoxFuture<'_, Result<PositionFix, PositionError>> {
        *self.asked.lock().expect("asked") += 1;
        ready(*self.answer.lock().expect("answer"))
    }
}
