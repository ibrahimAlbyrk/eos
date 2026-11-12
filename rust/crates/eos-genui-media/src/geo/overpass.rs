//! Places near a point from OpenStreetMap through the Overpass API: what the
//! `find_places` tool answers with (`infra/src/genui/geo/OverpassPlaceSearch.ts`).
//! Results are `Place` entities an agent can drop straight into a view (id
//! `osm:<type>/<id>`, position, cuisine, hours, site, address), nearest first.
//! OpenStreetMap has no ratings or prices, so those stay out. One query at a
//! time, answers cached on disk for a day.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use eos_core::BoxFuture;
use eos_core::net::{GeoError, PlaceQuery, PlaceSearch};
use regress::Regex;
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::{Url, form_urlencoded};

use super::ttl_store::JsonTtlStore;
use crate::map::root_cause;
use crate::num::{head16, len16, round, to_fixed};

pub const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";

const TIMEOUT: Duration = Duration::from_secs(25);
const TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Elements Overpass returns before they are sorted by distance and cut to the limit.
const FETCH_CAP: usize = 300;

type TagFilter = (&'static str, &'static str);

/// Plain-language categories → OSM tag filters. Anything else is matched as
/// a tag value (amenity/shop/tourism/leisure) or a cuisine.
const CATEGORIES: &[(&str, &[TagFilter])] = &[
    ("restaurant", &[("amenity", "^(restaurant|food_court)$")]),
    ("restaurants", &[("amenity", "^(restaurant|food_court)$")]),
    ("food", &[("amenity", "^(restaurant|fast_food|food_court|cafe)$")]),
    ("fast food", &[("amenity", "^fast_food$")]),
    ("cafe", &[("amenity", "^cafe$")]),
    ("coffee", &[("amenity", "^cafe$"), ("shop", "^coffee$")]),
    ("bar", &[("amenity", "^(bar|pub|biergarten)$")]),
    ("pub", &[("amenity", "^(pub|bar)$")]),
    ("nightlife", &[("amenity", "^(bar|pub|nightclub)$")]),
    ("bakery", &[("shop", "^(bakery|pastry)$")]),
    ("dessert", &[("shop", "^(pastry|confectionery|chocolate)$"), ("amenity", "^ice_cream$")]),
    ("ice cream", &[("amenity", "^ice_cream$")]),
    ("pharmacy", &[("amenity", "^pharmacy$")]),
    ("hospital", &[("amenity", "^(hospital|clinic)$")]),
    ("doctor", &[("amenity", "^(doctors|clinic)$")]),
    ("dentist", &[("amenity", "^dentist$")]),
    ("hotel", &[("tourism", "^(hotel|hostel|guest_house|motel|apartment)$")]),
    ("hostel", &[("tourism", "^hostel$")]),
    ("museum", &[("tourism", "^(museum|gallery)$")]),
    ("gallery", &[("tourism", "^gallery$"), ("shop", "^art$")]),
    ("attraction", &[("tourism", "^(attraction|viewpoint|museum|artwork)$")]),
    ("sights", &[("tourism", "^(attraction|viewpoint|museum)$"), ("historic", ".")]),
    ("viewpoint", &[("tourism", "^viewpoint$")]),
    ("park", &[("leisure", "^(park|garden)$")]),
    ("playground", &[("leisure", "^playground$")]),
    ("gym", &[("leisure", "^(fitness_centre|sports_centre)$")]),
    ("supermarket", &[("shop", "^(supermarket|convenience|greengrocer)$")]),
    ("grocery", &[("shop", "^(supermarket|convenience|greengrocer)$")]),
    ("market", &[("amenity", "^marketplace$"), ("shop", "^(supermarket|greengrocer)$")]),
    ("shop", &[("shop", ".")]),
    ("shopping", &[("shop", "^(mall|department_store|clothes|shoes)$")]),
    ("bookstore", &[("shop", "^books$")]),
    ("atm", &[("amenity", "^atm$")]),
    ("bank", &[("amenity", "^bank$")]),
    ("fuel", &[("amenity", "^fuel$")]),
    ("gas station", &[("amenity", "^fuel$")]),
    ("ev charging", &[("amenity", "^charging_station$")]),
    ("parking", &[("amenity", "^parking$")]),
    ("library", &[("amenity", "^library$")]),
    ("cinema", &[("amenity", "^cinema$")]),
    ("theatre", &[("amenity", "^theatre$")]),
    ("coworking", &[("amenity", "^coworking_space$"), ("office", "^coworking$")]),
    ("post office", &[("amenity", "^post_office$")]),
    ("school", &[("amenity", "^(school|university|college)$")]),
    ("veterinary", &[("amenity", "^veterinary$")]),
    ("laundry", &[("shop", "^(laundry|dry_cleaning)$")]),
    ("hairdresser", &[("shop", "^(hairdresser|beauty)$")]),
    ("bike rental", &[("amenity", "^bicycle_rental$")]),
    ("car rental", &[("amenity", "^car_rental$")]),
];

const PLACE_KEYS: [&str; 4] = ["amenity", "shop", "tourism", "leisure"];

/// Literal text as an Overpass regex: escaped for POSIX ERE, then for the
/// double-quoted QL string it sits in (where a backslash is itself escaped).
pub(crate) fn overpass_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            c if c.is_control() => out.push(' '),
            '\\' => out.push_str(r"\\\\"),
            '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}' => {
                out.push_str(r"\\");
                out.push(c);
            }
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
    }
    out
}

fn slug(text: &str) -> String {
    eos_domain::text::collapse_spaces(&eos_domain::text::js_trim(text).to_lowercase())
}

fn known(category: &str) -> Option<&'static [TagFilter]> {
    CATEGORIES.iter().find(|(name, _)| *name == category).map(|(_, filters)| *filters)
}

fn clause(key: &str, re: &str) -> String {
    format!("[\"{key}\"~\"{re}\",i]")
}

fn filter_clauses(category: &str) -> Vec<String> {
    let c = slug(category);
    if let Some(filters) = known(&c).or_else(|| known(c.strip_suffix('s').unwrap_or(&c))) {
        return filters.iter().map(|(key, re)| clause(key, re)).collect();
    }
    let value = overpass_regex(&c.replace(' ', "_"));
    let mut clauses: Vec<String> = PLACE_KEYS.iter().map(|key| clause(key, &format!("^{value}$"))).collect();
    clauses.push(clause("cuisine", &format!("(^|;){value}($|;)")));
    clauses
}

fn filled(text: Option<&str>) -> Option<&str> {
    text.map(eos_domain::text::js_trim).filter(|text| !text.is_empty())
}

/// The Overpass QL for a search: a union of statements, each limited to named
/// features within the radius; `out center` gives ways and relations a point.
pub(crate) fn build_overpass_query(q: &PlaceQuery) -> String {
    let around = format!("(around:{},{},{})", round(q.radius_m), to_fixed(q.lat, 6), to_fixed(q.lon, 6));
    let mut statements = String::new();
    let text = filled(q.query.as_deref()).map(overpass_regex);
    if let Some(category) = filled(q.category.as_deref()) {
        for filter in filter_clauses(category) {
            match &text {
                Some(text) => {
                    statements.push_str(&format!("nwr{around}{filter}[\"name\"~\"{text}\",i];"));
                    statements.push_str(&format!("nwr{around}{filter}[\"cuisine\"~\"{text}\",i][\"name\"];"));
                }
                None => statements.push_str(&format!("nwr{around}{filter}[\"name\"];")),
            }
        }
    } else if let Some(text) = &text {
        for key in PLACE_KEYS {
            statements.push_str(&format!("nwr{around}[\"name\"~\"{text}\",i][\"{key}\"];"));
        }
        statements.push_str(&format!("nwr{around}[\"cuisine\"~\"{text}\",i][\"name\"];"));
        let value = text.replace(' ', "_");
        statements.push_str(&format!("nwr{around}[~\"^(amenity|shop|tourism|leisure)$\"~\"^{value}$\",i][\"name\"];"));
    }
    format!("[out:json][timeout:20];({statements});out center tags {FETCH_CAP};")
}

/// Metres between two points on the globe.
pub(crate) fn distance_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    const R: f64 = 6_371_000.0;
    let rad = |degrees: f64| degrees * std::f64::consts::PI / 180.0;
    let (d_lat, d_lon) = (rad(b.0 - a.0), rad(b.1 - a.1));
    let h = (d_lat / 2.0).sin().powi(2) + rad(a.0).cos() * rad(b.0).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * R * h.sqrt().asin()
}

pub(crate) fn format_distance(m: f64) -> String {
    if m < 950.0 {
        return format!("{} m", (round(m / 10.0) * 10.0).max(10.0));
    }
    format!("{} km", to_fixed(m / 1000.0, if m < 9950.0 { 1 } else { 0 }))
}

/// Trimmed and cut to `max` characters, the last one an ellipsis; `None` when empty.
fn clip(text: Option<&str>, max: usize) -> Option<String> {
    let text = filled(text)?;
    Some(if len16(text) > max { format!("{}…", head16(text, max - 1)) } else { text.to_owned() })
}

static HTTP: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"^https?://", "i").unwrap_or_else(|e| panic!("pattern: {e}")));
static SITE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z0-9-]+\.)+[a-z]{2,}$").unwrap_or_else(|e| panic!("pattern: {e}")));

struct Tags<'a>(Option<&'a Map<String, Value>>);

impl<'a> Tags<'a> {
    /// A tag's text; `None` when the element has no such tag.
    fn get(&self, key: &str) -> Option<&'a str> {
        self.0?.get(key)?.as_str()
    }

    fn is(&self, key: &str, values: &[&str]) -> bool {
        self.get(key).is_some_and(|value| values.contains(&value))
    }
}

/// The place's website and its bare domain, when the tag holds a usable one.
fn website_of(tags: &Tags<'_>) -> (Option<String>, Option<String>) {
    let tagged = tags.get("website").or_else(|| tags.get("contact:website")).or_else(|| tags.get("url")).unwrap_or("");
    let raw = eos_domain::text::js_trim(tagged.split(';').next().unwrap_or(""));
    if raw.is_empty() {
        return (None, None);
    }
    let parsed = if HTTP.find(raw).is_some() { Url::parse(raw) } else { Url::parse(&format!("https://{raw}")) };
    let Ok(url) = parsed else { return (None, None) };
    if !matches!(url.scheme(), "http" | "https") {
        return (None, None);
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let site = SITE.find(host).is_some().then(|| host.to_owned());
    let text = url.to_string();
    ((len16(&text) <= 2048).then_some(text), site)
}

fn address_of(tags: &Tags<'_>) -> Option<String> {
    let truthy = |key| tags.get(key).filter(|value| !value.is_empty());
    let street: Vec<&str> = [truthy("addr:street"), truthy("addr:housenumber")].into_iter().flatten().collect();
    let street = street.join(" ");
    let place = tags.get("addr:suburb").or_else(|| tags.get("addr:district")).or_else(|| tags.get("addr:city"));
    let first = if street.is_empty() { tags.get("addr:place") } else { Some(street.as_str()) };
    let parts: Vec<&str> = [first, place].into_iter().flatten().filter(|part| !part.is_empty()).collect();
    clip(Some(&parts.join(", ")), 300)
}

fn tags_of(tags: &Tags<'_>) -> Option<Vec<&'static str>> {
    let mut out = Vec::new();
    for (label, key, values) in [
        ("outdoor seating", "outdoor_seating", &["yes"][..]),
        ("vegan options", "diet:vegan", &["yes", "only"]),
        ("vegetarian options", "diet:vegetarian", &["yes", "only"]),
        ("takeaway", "takeaway", &["yes", "only"]),
        ("delivery", "delivery", &["yes"]),
        ("wheelchair accessible", "wheelchair", &["yes"]),
        ("wi-fi", "internet_access", &["wlan", "yes"]),
    ] {
        if tags.is(key, values) {
            out.push(label);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn hours_of(tags: &Tags<'_>) -> Option<Value> {
    let hours = filled(tags.get("opening_hours"))?;
    Some(match hours {
        "24/7" => json!({ "text": "Open 24/7" }),
        "closed" | "off" => json!({ "closed": true, "text": "Closed" }),
        other => json!({ "text": clip(Some(other), 80) }),
    })
}

fn cuisine_of(tags: &Tags<'_>) -> Option<String> {
    let kinds: Vec<String> = tags
        .get("cuisine")?
        .split(';')
        .map(|kind| eos_domain::text::js_trim(kind).replace('_', " "))
        .filter(|kind| !kind.is_empty())
        .collect();
    clip(Some(&kinds.join(", ")), 100)
}

/// A JSON value as a template literal prints it.
fn js_string(value: &Value) -> String {
    serde_json::from_value::<eos_genui::Value>(value.clone()).map(|v| v.to_js_string()).unwrap_or_default()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// One Overpass element as a `Place` and its distance in metres, or `None`
/// when it has no name or position.
pub(crate) fn element_to_place(el: &Value, center: (f64, f64)) -> Option<(Value, f64)> {
    let tags = Tags(el.get("tags").and_then(Value::as_object));
    let name = clip(tags.get("name"), 200)?;
    let coordinate = |axis: &str| {
        let own = el.get(axis).filter(|v| !v.is_null());
        own.or_else(|| el.get("center").and_then(|c| c.get(axis))).and_then(Value::as_f64)
    };
    let (lat, lon) = (coordinate("lat")?, coordinate("lon")?);
    let (kind, id) = (el.get("type"), el.get("id").filter(|id| !id.is_null())?);
    if !truthy(kind) {
        return None;
    }
    let (kind, id) = (js_string(kind?), js_string(id));
    let meters = distance_m(center, (lat, lon));
    let category = ["amenity", "shop", "tourism", "leisure", "historic"].into_iter().find_map(|key| tags.get(key));
    let (url, site) = website_of(&tags);
    let area = tags.get("addr:suburb").or_else(|| tags.get("addr:district")).or_else(|| tags.get("addr:city"));

    let mut place = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            place.insert(key.to_owned(), value);
        }
    };
    put("id", Some(json!(format!("osm:{kind}/{id}"))));
    put("type", Some(json!("Place")));
    put("name", Some(json!(name)));
    put("geo", Some(json!([number(round(lat * 1e6) / 1e6), number(round(lon * 1e6) / 1e6)])));
    put("cuisine", cuisine_of(&tags).map(Value::String));
    put("hours", hours_of(&tags));
    put("site", site.map(Value::String));
    put("url", url.map(Value::String));
    put("address", address_of(&tags).map(Value::String));
    put("area", clip(area, 100).map(Value::String));
    put("tags", tags_of(&tags).map(|labels| json!(labels)));
    put("distance", Some(json!(format_distance(meters))));
    put("distanceM", Some(number(round(meters))));
    put("kind", category.filter(|category| !category.is_empty()).map(|category| json!(category.replace('_', " "))));
    put("phone", clip(tags.get("phone").or_else(|| tags.get("contact:phone")), 40).map(Value::String));
    put("osm", Some(json!(format!("https://www.openstreetmap.org/{kind}/{id}"))));

    // A field OpenStreetMap filled oddly (an unusual website) should not cost the place.
    for attempt in 0..2 {
        let broken =
            eos_genui::catalog::entity_issue_fields(&serde_json::from_value(Value::Object(place.clone())).ok()?);
        if broken.is_empty() {
            return Some((Value::Object(place), round(meters)));
        }
        if attempt == 1 {
            break;
        }
        for field in broken {
            place.shift_remove(&field);
        }
    }
    None
}

/// A number as JavaScript writes it in JSON: a whole one without a fraction (`89`, not `89.0`).
fn number(n: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    let value = if n.fract() == 0.0 && n.abs() < 9e15 { json!(n as i64) } else { json!(n) };
    value
}

pub struct OverpassPlaceSearch {
    client: reqwest::Client,
    store: JsonTtlStore,
    user_agent: String,
    endpoint: String,
    /// One query at a time.
    turn: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for OverpassPlaceSearch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OverpassPlaceSearch").field("endpoint", &self.endpoint).finish_non_exhaustive()
    }
}

impl OverpassPlaceSearch {
    pub(crate) fn new(client: reqwest::Client, store: JsonTtlStore, user_agent: String, endpoint: &str) -> Self {
        Self { client, store, user_agent, endpoint: endpoint.to_owned(), turn: tokio::sync::Mutex::new(()) }
    }

    async fn find(&self, q: &PlaceQuery) -> Result<Vec<Value>, GeoError> {
        if filled(q.query.as_deref()).is_none() && filled(q.category.as_deref()).is_none() {
            return Err(GeoError("a query or a category is needed".to_owned()));
        }
        let ql = build_overpass_query(q);
        let key: String = Sha256::digest(ql.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
        let elements = match self.store.get(&key) {
            Some(Value::Array(elements)) => elements,
            _ => {
                let elements = {
                    let _turn = self.turn.lock().await;
                    match tokio::time::timeout(TIMEOUT, self.run(&ql)).await {
                        Ok(answer) => answer?,
                        Err(_) => return Err(GeoError("OpenStreetMap place search timed out".to_owned())),
                    }
                };
                self.store.set(&key, Value::Array(elements.clone()), TTL_MS);
                elements
            }
        };
        let mut seen = HashSet::new();
        let mut places: Vec<(Value, f64)> = Vec::new();
        for element in &elements {
            let Some((place, meters)) = element_to_place(element, (q.lat, q.lon)) else { continue };
            let id = place.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            if seen.insert(id) && meters <= q.radius_m * 1.05 {
                places.push((place, meters));
            }
        }
        // Stable: places equally far keep the order Overpass gave them.
        places.sort_by(|a, b| a.1.total_cmp(&b.1));
        Ok(places.into_iter().take(q.limit).map(|(place, _)| place).collect())
    }

    async fn run(&self, ql: &str) -> Result<Vec<Value>, GeoError> {
        let failed = |e: &dyn std::fmt::Display| GeoError(format!("OpenStreetMap place search failed: {e}"));
        let body = form_urlencoded::Serializer::new(String::new()).append_pair("data", ql).finish();
        let response = self
            .client
            .post(&self.endpoint)
            .header(USER_AGENT, &self.user_agent)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ACCEPT, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| failed(&root_cause(&e)))?;
        let status = response.status().as_u16();
        if status == 429 || status == 504 {
            return Err(GeoError("OpenStreetMap place search is busy right now — try again in a minute".to_owned()));
        }
        if !(200..300).contains(&status) {
            return Err(GeoError(format!("OpenStreetMap place search answered {status}")));
        }
        let body = response.bytes().await.map_err(|e| failed(&root_cause(&e)))?;
        let body: Value = serde_json::from_slice(&body).map_err(|e| failed(&e))?;
        Ok(body.get("elements").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// Resolves once every answer cached so far is on disk.
    pub async fn flush(&self) {
        self.store.flush().await;
    }
}

impl PlaceSearch for OverpassPlaceSearch {
    fn search<'a>(&'a self, query: &'a PlaceQuery) -> BoxFuture<'a, Result<Vec<Value>, GeoError>> {
        Box::pin(self.find(query))
    }
}
