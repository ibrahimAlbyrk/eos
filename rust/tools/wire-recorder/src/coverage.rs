//! The route table a daemon registers, and how much of it the recordings reach.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use anyhow::Context;
use regex::Regex;
use serde::Deserialize;

use crate::model::{Recording, Via};

/// `routes.json`, written by the route probe from the running Node daemon.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFile {
    /// `ROUTES` key → path template (`:p0` for the first parameter).
    pub route_keys: BTreeMap<String, String>,
    pub routes: Vec<Route>,
}

/// One registration, in the order the router tries them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// 0 = the API router, 1 = the raw-content router.
    pub router: u8,
    pub method: String,
    pub pattern: String,
    pub regex: bool,
    /// The pattern with `:name` for each parameter.
    pub template: String,
    /// A path the pattern matches.
    pub sample: Option<String>,
    pub plugin_guarded: bool,
    pub local_only: Option<bool>,
    pub peer_open: Option<bool>,
    pub phone_tier: Option<String>,
    pub phone_ui_token: Option<bool>,
}

impl Route {
    /// How recordings and the coverage table name the route.
    pub fn label(&self) -> String {
        let raw = if self.router == 1 { " (raw)" } else { "" };
        format!("{} {}{raw}", self.method, self.template)
    }

    fn plane(&self) -> String {
        let mut parts = Vec::new();
        if self.local_only == Some(true) {
            parts.push("local-only".to_owned());
        }
        if self.peer_open == Some(true) {
            parts.push("peer-open".to_owned());
        }
        match (self.phone_tier.as_deref(), self.phone_ui_token) {
            (Some("REFUSED") | None, _) => {}
            (Some(tier), Some(true)) => parts.push(format!("phone {tier} +token")),
            (Some(tier), _) => parts.push(format!("phone {tier}")),
        }
        if self.plugin_guarded {
            parts.push("plugin".to_owned());
        }
        parts.join(", ")
    }
}

/// Finds the registration that answers a request: first match wins, like the daemon's router.
#[derive(Debug)]
pub struct RouteTable {
    file: RouteFile,
    patterns: Vec<Option<Regex>>,
}

impl RouteTable {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::new(serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?)
    }

    pub fn new(file: RouteFile) -> anyhow::Result<Self> {
        let patterns = file
            .routes
            .iter()
            .map(|route| match route.regex {
                true => {
                    Regex::new(&route.pattern).map(Some).with_context(|| format!("route pattern {}", route.pattern))
                }
                false => Ok(None),
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Self { file, patterns })
    }

    pub fn find(&self, via: Via, method: &str, path: &str) -> Option<&Route> {
        let router = u8::from(via == Via::Raw);
        self.file.routes.iter().zip(&self.patterns).find_map(|(route, pattern)| {
            let hit = route.router == router
                && route.method == method
                && match pattern {
                    Some(pattern) => pattern.is_match(path),
                    None => route.pattern == path,
                };
            hit.then_some(route)
        })
    }
}

/// Why a route has no recorded success (`not-recordable.toml`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notes {
    #[serde(default, rename = "note")]
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Note {
    /// Route labels (`"POST /workers"`).
    pub routes: Vec<String>,
    pub why: String,
}

impl Notes {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    fn why(&self, label: &str) -> Option<&str> {
        self.notes.iter().find(|note| note.routes.iter().any(|r| r == label)).map(|note| note.why.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Reach {
    /// No step reaches the route.
    None,
    /// Only refusals and errors (4xx/5xx) are recorded.
    ErrorsOnly,
    /// A success answer is recorded.
    Recorded,
}

impl Reach {
    fn word(self) -> &'static str {
        match self {
            Self::None => "not recorded",
            Self::ErrorsOnly => "errors only",
            Self::Recorded => "recorded",
        }
    }
}

/// The numbers the coverage table opens with.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub routes: usize,
    pub recorded: usize,
    pub errors_only: usize,
    pub not_recorded: usize,
    /// Routes without a recorded success and without a note saying why.
    pub unexplained: usize,
    pub keys: usize,
    pub keys_recorded: usize,
    pub steps: usize,
}

/// Builds the coverage table (markdown) from the route file, the recordings and the notes.
pub fn table(table: &RouteTable, recordings: &[Recording], notes: &Notes) -> (String, Totals) {
    let mut steps: BTreeMap<String, (usize, Reach)> = BTreeMap::new();
    let mut totals = Totals::default();
    for exchange in recordings.iter().flat_map(|r| &r.exchanges) {
        totals.steps += 1;
        let Some(label) = &exchange.route else { continue };
        let ok = exchange.response.get("status").and_then(serde_json::Value::as_u64).is_some_and(|s| s < 400);
        let entry = steps.entry(label.clone()).or_insert((0, Reach::None));
        entry.0 += 1;
        entry.1 = entry.1.max(if ok { Reach::Recorded } else { Reach::ErrorsOnly });
    }

    let routes = &table.file.routes;
    let reach = |route: &Route| steps.get(&route.label()).copied().unwrap_or((0, Reach::None));
    let mut rows = String::new();
    for route in routes {
        let (count, reached) = reach(route);
        let why = if reached == Reach::Recorded { None } else { notes.why(&route.label()) };
        totals.routes += 1;
        match reached {
            Reach::Recorded => totals.recorded += 1,
            Reach::ErrorsOnly => totals.errors_only += 1,
            Reach::None => totals.not_recorded += 1,
        }
        if reached != Reach::Recorded && why.is_none() {
            totals.unexplained += 1;
        }
        let why = why.unwrap_or(if reached == Reach::Recorded { "" } else { "**unexplained**" });
        let _ = writeln!(rows, "| `{}` | {} | {count} | {} | {why} |", route.label(), route.plane(), reached.word());
    }

    let mut key_rows = String::new();
    for (key, template) in &table.file.route_keys {
        let mine = routes_of_key(template, table);
        let cells: Vec<String> =
            mine.iter().map(|route| format!("{} {}", route.method, reach(route).1.word())).collect();
        totals.keys += 1;
        if mine.iter().any(|route| reach(route).1 == Reach::Recorded) {
            totals.keys_recorded += 1;
        }
        let cells = if cells.is_empty() { "no route registered".to_owned() } else { cells.join(", ") };
        let _ = writeln!(key_rows, "| `{key}` | `{template}` | {cells} |");
    }

    let mut out = String::new();
    let _ = writeln!(out, "# Wire coverage\n\nWritten by `wire-recorder coverage`. Do not edit by hand.\n");
    let _ = writeln!(out, "- Registered routes: **{}**", totals.routes);
    let _ = writeln!(out, "  - a success answer recorded: **{}**", totals.recorded);
    let _ = writeln!(out, "  - only refusals and errors recorded: **{}**", totals.errors_only);
    let _ = writeln!(out, "  - not recorded: **{}**", totals.not_recorded);
    let _ = writeln!(out, "  - without a recorded success and without a reason: **{}**", totals.unexplained);
    let _ = writeln!(
        out,
        "- `ROUTES` keys: **{}**, with a success recorded for at least one method: **{}**",
        totals.keys, totals.keys_recorded
    );
    let _ = writeln!(out, "- Recorded steps: **{}**\n", totals.steps);
    let _ = writeln!(out, "## Registered routes\n\nIn registration order (the router takes the first match).\n");
    let _ = writeln!(out, "| route | reach from outside | steps | result | why no success |\n|---|---|---|---|---|");
    out.push_str(&rows);
    let _ = writeln!(out, "\n## `ROUTES` keys\n\n| key | path | methods |\n|---|---|---|");
    out.push_str(&key_rows);
    (out, totals)
}

/// The registrations a `ROUTES` key stands for: every method on its path, or
/// everything below it when the key is a prefix. A literal path that has a key
/// of its own (`/workers/archived`) does not also count for `/workers/:id`.
fn routes_of_key<'a>(template: &str, table: &'a RouteTable) -> Vec<&'a Route> {
    let keys = &table.file.route_keys;
    let own_key =
        |route: &Route| !route.regex && route.pattern != template && keys.values().any(|t| *t == route.pattern);
    let parts: Vec<&str> = template.split('/').collect();
    // The key's path with each parameter taken from the route's own sample, so
    // a parameter the route constrains (an id shape, a fixed set of words) fits.
    let filled = |sample: &str| -> Option<String> {
        let given: Vec<&str> = sample.split('/').collect();
        (given.len() == parts.len()).then(|| {
            let path: Vec<&str> =
                parts.iter().zip(&given).map(|(part, own)| if part.starts_with(":p") { *own } else { *part }).collect();
            path.join("/")
        })
    };
    let routes = || table.file.routes.iter().zip(&table.patterns).filter(|(route, _)| !own_key(route));
    let exact: Vec<&Route> = routes()
        .filter(|(route, pattern)| {
            route.sample.as_deref().and_then(filled).is_some_and(|path| match pattern {
                Some(pattern) => pattern.is_match(&path),
                None => route.pattern == path,
            })
        })
        .map(|(route, _)| route)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    let prefix = format!("{template}/");
    routes()
        .filter(|(route, _)| {
            !template.contains(":p") && route.sample.as_deref().is_some_and(|s| s.starts_with(&prefix))
        })
        .map(|(route, _)| route)
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::{Exchange, Step};

    fn routes() -> RouteTable {
        let file: RouteFile = serde_json::from_value(json!({
            "routeKeys": { "workers": "/workers", "worker": "/workers/:p0", "workersArchived": "/workers/archived", "pdfjs": "/pdfjs", "gone": "/gone",
                           "transferCancel": "/api/transfers/:p0/cancel" },
            "routes": [
                { "router": 0, "method": "GET", "pattern": "/workers", "regex": false, "template": "/workers", "sample": "/workers",
                  "pluginGuarded": false, "localOnly": false, "peerOpen": false, "phoneTier": "READ", "phoneUiToken": false },
                { "router": 0, "method": "GET", "pattern": "/workers/archived", "regex": false, "template": "/workers/archived", "sample": "/workers/archived",
                  "pluginGuarded": false, "localOnly": false, "peerOpen": false, "phoneTier": "READ", "phoneUiToken": false },
                { "router": 0, "method": "GET", "pattern": "^\\/workers\\/(?<id>[^/]+)$", "regex": true, "template": "/workers/:id", "sample": "/workers/x",
                  "pluginGuarded": false, "localOnly": false, "peerOpen": false, "phoneTier": "READ", "phoneUiToken": false },
                { "router": 0, "method": "DELETE", "pattern": "^\\/workers\\/(?<id>[^/]+)$", "regex": true, "template": "/workers/:id", "sample": "/workers/x",
                  "pluginGuarded": true, "localOnly": true, "peerOpen": false, "phoneTier": "HIGH", "phoneUiToken": true },
                { "router": 0, "method": "POST", "pattern": "^\\/api\\/transfers\\/(?<id>tr-[a-z0-9]+)\\/(?<action>pause|cancel)$", "regex": true,
                  "template": "/api/transfers/:id/:action", "sample": "/api/transfers/tr-a/pause",
                  "pluginGuarded": false, "localOnly": true, "peerOpen": false, "phoneTier": "REFUSED", "phoneUiToken": false },
                { "router": 1, "method": "GET", "pattern": "^\\/pdfjs(?<rest>\\/.*)?$", "regex": true, "template": "/pdfjs/*", "sample": "/pdfjs/x",
                  "pluginGuarded": false, "localOnly": null, "peerOpen": null, "phoneTier": null, "phoneUiToken": null },
            ]
        }))
        .expect("route file");
        RouteTable::new(file).expect("patterns compile")
    }

    #[test]
    fn first_match_wins_per_router_and_method() {
        let table = routes();
        assert_eq!(
            table.find(Via::Api, "GET", "/workers/archived").map(Route::label).as_deref(),
            Some("GET /workers/archived")
        );
        assert_eq!(
            table.find(Via::Socket, "GET", "/workers/w-1").map(Route::label).as_deref(),
            Some("GET /workers/:id")
        );
        assert_eq!(
            table.find(Via::Api, "DELETE", "/workers/w-1").map(Route::label).as_deref(),
            Some("DELETE /workers/:id")
        );
        assert_eq!(
            table.find(Via::Raw, "GET", "/pdfjs/web/viewer.html").map(Route::label).as_deref(),
            Some("GET /pdfjs/* (raw)")
        );
        assert!(table.find(Via::Api, "GET", "/pdfjs/web/viewer.html").is_none());
        assert!(table.find(Via::Api, "POST", "/workers").is_none());
    }

    #[test]
    fn counts_reach_and_asks_for_reasons() {
        let exchange = |route: &str, status: u16| Exchange {
            step: Step::default(),
            route: Some(route.to_owned()),
            response: json!({ "status": status }),
        };
        let recording = Recording {
            scenario: "s".into(),
            about: String::new(),
            record_headers: Vec::new(),
            exchanges: vec![
                exchange("GET /workers", 200),
                exchange("GET /workers/:id", 404),
                exchange("GET /workers/:id", 404),
            ],
        };
        let notes =
            Notes { notes: vec![Note { routes: vec!["DELETE /workers/:id".into()], why: "ends a session".into() }] };
        let (text, totals) = table(&routes(), &[recording], &notes);
        assert_eq!(
            totals,
            Totals {
                routes: 6,
                recorded: 1,
                errors_only: 1,
                not_recorded: 4,
                unexplained: 4,
                keys: 6,
                keys_recorded: 1,
                steps: 3
            }
        );
        assert!(text.contains("| `GET /workers` | phone READ | 1 | recorded |  |"), "{text}");
        assert!(text.contains("| `GET /workers/:id` | phone READ | 2 | errors only | **unexplained** |"), "{text}");
        assert!(
            text.contains(
                "| `DELETE /workers/:id` | local-only, phone HIGH +token, plugin | 0 | not recorded | ends a session |"
            ),
            "{text}"
        );
        assert!(text.contains("| `worker` | `/workers/:p0` | GET errors only, DELETE not recorded |"), "{text}");
        assert!(text.contains("| `pdfjs` | `/pdfjs` | GET not recorded |"), "{text}");
        assert!(text.contains("| `gone` | `/gone` | no route registered |"), "{text}");
        assert!(text.contains("| `transferCancel` | `/api/transfers/:p0/cancel` | POST not recorded |"), "{text}");
    }
}
