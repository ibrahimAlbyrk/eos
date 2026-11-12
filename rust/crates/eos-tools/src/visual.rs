//! Visual answers and what feeds them (`present`, `present_app`,
//! `find_places`, `current_location`): for the sessions that answer the user.

use std::sync::Arc;

use eos_contracts::{Area, LocationResponse, PlacesRequest};
use eos_core::genui::{LocationRefusal, Places, PresentRefusal, UserLocation, VisualAnswers};
use eos_core::{BoxFuture, Clock};
use eos_genui::catalog::{GENUI_LIMITS, GENUI_TONES, format_problem, format_problems};
use eos_genui::spec::{app_success_text, present_success_text};
use eos_runtime::http::ApiError;
use serde_json::{Map, Value, json};

use crate::js::{round, slice_units, to_fixed, trim};
use crate::schema::{number, object, one_of, record, string, union};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec};

/// A refusal's own sentence, as the model should relay it: never the status
/// around it.
fn reason(message: &str) -> &str {
    message.strip_prefix("invalid request: ").unwrap_or(message)
}

/// What a refused `present` / `present_app` hands the model.
fn refused(tool: &str, refusal: PresentRefusal) -> Outcome {
    match refusal {
        // The user switched it off: the sentence is the answer, not an error to retry.
        PresentRefusal::SwitchedOff(text) => Ok(Output::text(text)),
        PresentRefusal::Rejected(problems) => {
            let listed = format_problems(&problems);
            let listed = match listed.strip_suffix("call present again") {
                Some(head) => format!("{head}call {tool} again"),
                None => listed,
            };
            Err(Failure(format!("{tool}: {listed}")))
        }
        PresentRefusal::Failed(e) => Err(Failure(reason(&ApiError::from(e).to_string()).to_owned())),
        other @ PresentRefusal::NotPresenter => Err(Failure(other.to_string())),
    }
}

struct Present(Arc<dyn VisualAnswers>);

impl Handler for Present {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            match self.0.present_view(call.self_id, input).await {
                Ok(view) => Ok(Output::Text(present_success_text(&view.view_id, &view.stats, 0, &view.warnings))),
                Err(refusal) => refused("present", refusal),
            }
        })
    }
}

struct PresentApp(Arc<dyn VisualAnswers>);

impl Handler for PresentApp {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let app = match self.0.present_app(call.self_id, input).await {
                Ok(app) => app,
                Err(refusal) => return refused("present_app", refusal),
            };
            let head = app_success_text(&app.view_id);
            if app.warnings.is_empty() {
                return Ok(Output::Text(head));
            }
            let mut lines = vec![head, "warnings (fix next time, no need to re-present):".to_owned()];
            lines.extend(app.warnings.iter().map(|w| format!("· {}", format_problem(w))));
            Ok(Output::Text(lines.join("\n")))
        })
    }
}

// ---- places and position ------------------------------------------------------

const DEFAULT_RADIUS_M: i64 = 1500;
const DEFAULT_LIMIT: i64 = 12;

/// `district, city, country`, each once.
fn area_line(area: Option<&Area>) -> String {
    let Some(area) = area else { return String::new() };
    let mut parts: Vec<&str> = Vec::new();
    for part in [&area.district, &area.city, &area.country].into_iter().flatten() {
        if !part.is_empty() && !parts.contains(&part.as_str()) {
            parts.push(part);
        }
    }
    parts.join(", ")
}

fn format_accuracy(m: f64) -> String {
    if m < 1000.0 {
        return format!("±{} m", round(m).max(1.0));
    }
    format!("±{} km", to_fixed(m / 1000.0, if m < 10_000.0 { 1 } else { 0 }))
}

fn format_age(ms: f64) -> String {
    if ms < 60_000.0 {
        return "just now".to_owned();
    }
    let minutes = round(ms / 60_000.0);
    if minutes < 60.0 { format!("{minutes} min ago") } else { format!("{} h ago", round(minutes / 60.0)) }
}

fn radius_text(m: i64) -> String {
    if m < 1000 {
        return format!("{m} m");
    }
    #[allow(clippy::cast_precision_loss)]
    let km = m as f64 / 1000.0;
    format!("{} km", to_fixed(km, usize::from(m % 1000 != 0)))
}

/// A number the model may have written loosely, held to a range.
fn clamp(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    match value.and_then(Value::as_f64).filter(|n| n.is_finite()) {
        #[allow(clippy::cast_possible_truncation)]
        Some(n) => (round(n) as i64).clamp(min, max),
        None => fallback,
    }
}

/// A trimmed, non-empty text of at most `max` UTF-16 units.
fn text_arg(value: Option<&Value>, max: usize) -> Option<String> {
    let text = trim(value?.as_str()?);
    (!text.is_empty()).then(|| slice_units(text, max))
}

/// What the agent can put into `data.sources` for the map's facts.
fn osm_source() -> Value {
    json!({
        "title": "OpenStreetMap contributors",
        "site": "openstreetmap.org",
        "url": "https://www.openstreetmap.org/copyright",
        "note": "ODbL",
    })
}

struct FindPlaces {
    places: Arc<dyn Places>,
    location: Arc<dyn UserLocation>,
}

impl FindPlaces {
    /// The search point: `{lat, lon}`, a place name, or — when none is given
    /// — where the user is (refused with the setting's name when sharing is off).
    async fn near(&self, self_id: &str, near: Option<&Value>) -> Result<(Value, Option<String>), Failure> {
        if let Some(text) = text_arg(near.filter(|n| n.is_string()), 300) {
            return Ok((json!({ "text": text }), None));
        }
        if let Some(given) = near.and_then(Value::as_object) {
            if let Some(text) = text_arg(given.get("text"), 300) {
                return Ok((json!({ "text": text }), None));
            }
            let coordinate = |key: &str| given.get(key).and_then(Value::as_f64).filter(|n| n.is_finite());
            if let (Some(lat), Some(lon)) = (coordinate("lat"), coordinate("lon"))
                && lat.abs() <= 90.0
                && lon.abs() <= 180.0
            {
                return Ok((json!({"lat": given["lat"], "lon": given["lon"]}), None));
            }
            return Err(Failure(
                "find_places: near must be {text: \"a place or address\"} or {lat, lon} with a real latitude and longitude"
                    .to_owned(),
            ));
        }
        let here = self.location.current_for(self_id).await.map_err(|LocationRefusal { message, .. }| {
            Failure(format!(
                "No place given and the user's location isn't available: {} Ask the user where to search, then pass near: {{text}}.",
                reason(&message)
            ))
        })?;
        let area = area_line(here.area.as_ref());
        let label = if area.is_empty() { "the user's location".to_owned() } else { format!("the user ({area})") };
        Ok((json!({"lat": here.lat, "lon": here.lon}), Some(label)))
    }
}

impl Handler for FindPlaces {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let query = text_arg(input.get("query"), 200);
            let category = text_arg(input.get("category"), 60);
            if query.is_none() && category.is_none() {
                return Err(Failure(
                    "find_places needs a query or a category — e.g. {category: \"cafe\"} or {query: \"ramen\"}"
                        .to_owned(),
                ));
            }
            let (point, near_label) = self.near(call.self_id, input.get("near")).await?;
            let radius_m = clamp(input.get("radiusM"), 50, 20_000, DEFAULT_RADIUS_M);
            let mut body = Map::new();
            if let Some(query) = &query {
                body.insert("query".into(), query.clone().into());
            }
            if let Some(category) = &category {
                body.insert("category".into(), category.clone().into());
            }
            body.insert("near".into(), point);
            body.insert("radiusM".into(), radius_m.into());
            body.insert("limit".into(), clamp(input.get("limit"), 1, 40, DEFAULT_LIMIT).into());
            let request: PlacesRequest =
                eos_contracts::parse(&Value::Object(body)).map_err(|e| Failure(reason(&e.message()).to_owned()))?;
            let found = self.places.find(request).await.map_err(|e| Failure(reason(&e.to_string()).to_owned()))?;

            let what = match (&query, &category) {
                (Some(query), Some(category)) => format!("\"{query}\" ({category})"),
                (Some(query), None) => format!("\"{query}\""),
                (None, category) => category.clone().unwrap_or_default(),
            };
            let place = found.center.label.or(near_label).unwrap_or_else(|| "the given point".to_owned());
            let radius = radius_text(found.radius_m);
            let count = found.places.len();
            if count == 0 {
                return Ok(Output::Text(format!(
                    "No places for {what} within {radius} of {place} on OpenStreetMap — try a wider radiusM, a broader category, or another spelling."
                )));
            }
            let head = format!(
                "{count} place{} for {what} within {radius} of {place}, nearest first — {}. No ratings or prices in OpenStreetMap.",
                if count == 1 { "" } else { "s" },
                found.attribution
            );
            let data = json!({"places": found.places, "attribution": found.attribution, "source": osm_source()});
            Ok(Output::Text(format!("{head}\n{data}")))
        })
    }
}

struct CurrentLocation {
    location: Arc<dyn UserLocation>,
    clock: Arc<dyn Clock>,
}

fn located(loc: &LocationResponse, now_ms: i64) -> String {
    let area = area_line(loc.area.as_ref());
    let place = if area.is_empty() { "Area unknown (no reverse-geocode answer)" } else { &area };
    #[allow(clippy::cast_precision_loss)]
    let age = format_age((now_ms as f64 - loc.at.as_f64()).max(0.0));
    let head = format!("{place} · {} · {age}", format_accuracy(loc.accuracy.as_f64()));
    let mut out = Map::new();
    out.insert("lat".into(), json!(loc.lat));
    out.insert("lon".into(), json!(loc.lon));
    out.insert("accuracy".into(), json!(eos_contracts::Num(round(loc.accuracy.as_f64()))));
    out.insert("at".into(), json!(loc.at));
    if let Some(area) = &loc.area {
        out.insert("area".into(), json!(area));
    }
    format!("{head}\n{}", Value::Object(out))
}

impl Handler for CurrentLocation {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let loc = self
                .location
                .current_for(call.self_id)
                .await
                .map_err(|refusal| Failure(reason(&refusal.message).to_owned()))?;
            Ok(Output::Text(located(&loc, self.clock.now_ms())))
        })
    }
}

/// What the visual-answer tools reach.
#[derive(Clone)]
pub struct Visual {
    pub answers: Arc<dyn VisualAnswers>,
    pub places: Arc<dyn Places>,
    pub location: Arc<dyn UserLocation>,
}

impl std::fmt::Debug for Visual {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Visual").finish_non_exhaustive()
    }
}

pub(crate) fn specs(v: &Visual, clock: &Arc<dyn Clock>) -> Vec<Spec> {
    let limits = GENUI_LIMITS;
    vec![
        // The catalog rides this tool's description: a session with tool
        // search on must see it from its first turn.
        Spec::new(
            "present",
            // Loose on purpose: the validator words every slip with its path,
            // which a schema's refusal cannot.
            object(vec![
                ("title", string().describe(format!("≤ {} chars", limits.title_chars))),
                ("tone", one_of(GENUI_TONES).optional().describe("the view's one accent")),
                ("icon", string().optional().describe("an icon name from the catalog")),
                ("replaces", string().optional().describe("id of an earlier view (v_…) this one updates")),
                (
                    "data",
                    record().optional().describe("collections (arrays of entities) and scalars, each written once"),
                ),
                ("actions", record().optional().describe("{id: {label, kind, primary?, text?, href?, set?}}")),
                ("ui", string().describe("markup that references data")),
                (
                    "summary",
                    string().describe(format!("the answer as plain text, ≤ {} chars", limits.summary_chars)),
                ),
            ]),
            Present(v.answers.clone()),
        )
        .always_load(),
        Spec::new(
            "present_app",
            object(vec![
                ("title", string().describe(format!("≤ {} chars", limits.title_chars))),
                (
                    "html",
                    string()
                        .describe(format!("one self-contained HTML document, ≤ {} KB", limits.app_html_bytes / 1024)),
                ),
                (
                    "summary",
                    string().describe(format!(
                        "what the app is and does, as plain text, ≤ {} chars",
                        limits.summary_chars
                    )),
                ),
                (
                    "height",
                    number().optional().describe(format!(
                        "initial height in px, {}–{}",
                        limits.app_height_min, limits.app_height_max
                    )),
                ),
            ]),
            PresentApp(v.answers.clone()),
        )
        .search_hint("sandboxed HTML app in the chat: calculator, timer, game, simulator, custom interactive visual"),
        Spec::new(
            "find_places",
            object(vec![
                (
                    "query",
                    string().optional().describe("what to look for — a name or a kind: \"ramen\", \"bike repair\""),
                ),
                (
                    "category",
                    string().optional().describe(
                        "a kind of place: restaurant, cafe, bar, bakery, pharmacy, hotel, museum, supermarket, atm, …",
                    ),
                ),
                (
                    "near",
                    union(vec![
                        string(),
                        object(vec![("text", string())]),
                        object(vec![("lat", number()), ("lon", number())]),
                    ])
                    .optional()
                    .describe(
                        "{text: a place name or address} or {lat, lon}; omitted = around the user's current location (needs location sharing)",
                    ),
                ),
                ("radiusM", number().optional().describe("search radius in meters, 50–20000 (default 1500)")),
                ("limit", number().optional().describe("how many places, 1–40 (default 12)")),
            ]),
            FindPlaces { places: v.places.clone(), location: v.location.clone() },
        )
        .search_hint(
            "nearby places near me or an address: restaurants, cafes, shops, pharmacies — coordinates, hours, websites from OpenStreetMap",
        ),
        Spec::new(
            "current_location",
            object(vec![]),
            CurrentLocation { location: v.location.clone(), clock: clock.clone() },
        )
        .search_hint("where the user is now, near me, around here: latitude, longitude, district, city"),
    ]
}
