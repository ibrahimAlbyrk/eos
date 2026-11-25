//! An App version's body (05 Q7): one HTML document, its manifest and the
//! builder's tests, read and scanned as a whole. The static scan refuses
//! every way out of the frame Eos does not relay (network, storage, other
//! frames and windows) and every bridge name the code uses that its
//! manifest does not declare. The line of access under an App is written
//! here from the manifest, never by the App.

use serde_json::{Map, Value, json};

use crate::limits::APP_STATE_BYTES;
use crate::problem::Problem;

/// The App's one HTML document.
pub const APP_HTML_BYTES: usize = 256 * 1024;
/// The builder's tests.
pub const APP_TESTS_BYTES: usize = 64 * 1024;
/// How tall an App may ask to be drawn inline.
pub const APP_HEIGHT: (u16, u16) = (160, 720);

/// What code inside the frame may never name: each would reach past the
/// bridge, or keep data where Eos cannot see it.
const REFUSED: &[(&str, &str)] = &[
    ("fetch(", "fetches from the network"),
    ("XMLHttpRequest", "fetches from the network"),
    ("WebSocket", "opens a connection"),
    ("EventSource", "opens a connection"),
    ("sendBeacon", "sends to the network"),
    ("importScripts", "loads code"),
    ("<iframe", "opens another frame"),
    ("<object", "embeds other content"),
    ("<embed", "embeds other content"),
    ("window.open", "opens a window"),
    ("document.cookie", "keeps cookies"),
    ("localStorage", "keeps data outside Eos"),
    ("sessionStorage", "keeps data outside Eos"),
    ("indexedDB", "keeps data outside Eos"),
    ("serviceWorker", "installs a worker"),
    ("new Worker", "starts a worker"),
];

/// Where an App's files are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRoot {
    /// The project its routine works in.
    Project,
    /// The routine's own files folder.
    RoutineFiles,
}

impl FileRoot {
    pub fn as_str(self) -> &'static str {
        match self {
            FileRoot::Project => "project",
            FileRoot::RoutineFiles => "routine_files",
        }
    }
}

/// The files an App may list, read and write, by globs below one root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileScope {
    pub root: FileRoot,
    pub read: Vec<String>,
    pub write: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManifest {
    pub title: String,
    pub summary: String,
    pub height: Option<u16>,
    /// The direct actions it calls.
    pub uses: Vec<String>,
    /// The named queries it reads.
    pub queries: Vec<String>,
    pub files: Option<FileScope>,
    pub state_max_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDesign {
    pub html: String,
    pub manifest: AppManifest,
    pub tests: Option<String>,
}

fn strings(value: Option<&Value>, path: &str, problems: &mut Vec<Problem>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(n, item)| match item.as_str() {
                Some(text) if !text.is_empty() => Some(text.to_owned()),
                _ => {
                    problems.push(Problem::new(format!("{path}[{n}]"), "is text"));
                    None
                }
            })
            .collect(),
        Some(_) => {
            problems.push(Problem::new(path, "is a list of text"));
            Vec::new()
        }
    }
}

/// A glob below the root: relative, without `..`, `~` or a backslash.
fn glob_ok(glob: &str) -> bool {
    !glob.starts_with('/')
        && !glob.starts_with('~')
        && !glob.contains('\\')
        && glob.split('/').all(|part| !part.is_empty() && !part.starts_with('.'))
}

fn file_scope(value: &Value, problems: &mut Vec<Problem>) -> Option<FileScope> {
    let root = match value["root"].as_str() {
        Some("project") => FileRoot::Project,
        Some("routine_files") => FileRoot::RoutineFiles,
        _ => {
            problems.push(Problem::new("manifest.files.root", "is `project` or `routine_files`"));
            return None;
        }
    };
    let read = strings(value.get("read"), "manifest.files.read", problems);
    let write = strings(value.get("write"), "manifest.files.write", problems);
    for (key, globs) in [("read", &read), ("write", &write)] {
        for (n, glob) in globs.iter().enumerate().filter(|(_, glob)| !glob_ok(glob)) {
            problems.push(Problem::new(
                format!("manifest.files.{key}[{n}]"),
                format!("`{glob}` is not a glob below the root: no `/` first, no `..`, no hidden name"),
            ));
        }
    }
    if read.is_empty() && write.is_empty() {
        problems.push(Problem::new("manifest.files", "names at least one glob, or is left out"));
    }
    Some(FileScope { root, read, write })
}

const MANIFEST_KEYS: &[&str] = &["title", "summary", "height", "uses", "queries", "files", "stateMaxBytes"];

fn manifest(value: &Value, problems: &mut Vec<Problem>) -> AppManifest {
    let Some(map) = value.as_object() else {
        problems.push(Problem::new("manifest", "is an object"));
        return AppManifest {
            title: String::new(),
            summary: String::new(),
            height: None,
            uses: Vec::new(),
            queries: Vec::new(),
            files: None,
            state_max_bytes: APP_STATE_BYTES,
        };
    };
    for key in map.keys().filter(|key| !MANIFEST_KEYS.contains(&key.as_str())) {
        problems.push(Problem::new(format!("manifest.{key}"), "is not part of an App's manifest"));
    }
    let text = |key: &str, max: usize, problems: &mut Vec<Problem>| match map.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() && text.chars().count() <= max => text.to_owned(),
        _ => {
            problems.push(Problem::new(format!("manifest.{key}"), format!("is text of 1 to {max} characters")));
            String::new()
        }
    };
    let (title, summary) = (text("title", 80, problems), text("summary", 300, problems));
    let height = match map.get("height") {
        None | Some(Value::Null) => None,
        Some(height) => match height.as_u64().and_then(|h| u16::try_from(h).ok()) {
            Some(h) if (APP_HEIGHT.0..=APP_HEIGHT.1).contains(&h) => Some(h),
            _ => {
                let (low, high) = APP_HEIGHT;
                problems.push(Problem::new("manifest.height", format!("is {low} to {high} pixels")));
                None
            }
        },
    };
    let uses = strings(map.get("uses"), "manifest.uses", problems);
    let queries = strings(map.get("queries"), "manifest.queries", problems);
    let files = match map.get("files") {
        None | Some(Value::Null) => None,
        Some(scope) => file_scope(scope, problems),
    };
    let state_max_bytes = match map.get("stateMaxBytes") {
        None | Some(Value::Null) => APP_STATE_BYTES,
        Some(bytes) => match bytes.as_u64().and_then(|b| usize::try_from(b).ok()) {
            Some(b) if (1..=APP_STATE_BYTES).contains(&b) => b,
            _ => {
                problems.push(Problem::new("manifest.stateMaxBytes", format!("is 1 to {APP_STATE_BYTES}")));
                APP_STATE_BYTES
            }
        },
    };
    AppManifest { title, summary, height, uses, queries, files, state_max_bytes }
}

/// Every quoted text in the code that reads like a bridge name
/// (`routine.run_again`, `query.surface.issues`, `files.read`).
fn named_in(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = code;
    while let Some(start) = rest.find(['"', '\'', '`']) {
        let quote = rest.as_bytes()[start] as char;
        let after = &rest[start + 1..];
        let Some(end) = after.find(quote) else { break };
        let text = &after[..end];
        let shaped = text.contains('.')
            && text.split('.').all(|part| {
                part.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                    && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
        if shaped && !found.iter().any(|known| known == text) {
            found.push(text.to_owned());
        }
        rest = &after[end + 1..];
    }
    found
}

/// What the code may not do, by the refused names: `fetch (` counts as
/// `fetch(`.
fn refused_in(code: &str) -> Vec<Problem> {
    let squeezed: String = code.split_whitespace().collect::<Vec<_>>().join(" ").replace(" (", "(");
    let lower = squeezed.to_ascii_lowercase();
    REFUSED
        .iter()
        .filter(|(name, _)| {
            if name.starts_with('<') { lower.contains(&name.to_ascii_lowercase()) } else { squeezed.contains(name) }
        })
        .map(|(name, why)| {
            Problem::new("html", format!("uses `{name}`, which {why}: an App reaches Eos only through its bridge"))
        })
        .collect()
}

impl AppDesign {
    /// Reads a body and runs the static scan; every problem at once.
    /// `is_action` says whether a name is one of Eos's direct actions.
    pub fn from_body(body: &Value, is_action: impl Fn(&str) -> bool) -> Result<AppDesign, Vec<Problem>> {
        let mut problems = Vec::new();
        let Some(map) = body.as_object() else { return Err(vec![Problem::new("", "an App is an object")]) };
        for key in map.keys().filter(|key| !["html", "manifest", "tests"].contains(&key.as_str())) {
            problems.push(Problem::new(key.clone(), "is not part of an App"));
        }
        let html = map.get("html").and_then(Value::as_str).unwrap_or_default().to_owned();
        if html.trim().is_empty() {
            problems.push(Problem::new("html", "is required: one HTML document"));
        } else if html.len() > APP_HTML_BYTES {
            problems.push(Problem::new("html", format!("is more than {APP_HTML_BYTES} bytes")));
        }
        let tests = match map.get("tests") {
            None | Some(Value::Null) => None,
            Some(Value::String(tests)) if tests.len() <= APP_TESTS_BYTES => Some(tests.clone()),
            Some(_) => {
                problems.push(Problem::new("tests", format!("is text of at most {APP_TESTS_BYTES} bytes")));
                None
            }
        };
        let manifest = manifest(map.get("manifest").unwrap_or(&Value::Null), &mut problems);
        problems.extend(refused_in(&html));
        problems.extend(undeclared(&html, &manifest, &is_action));
        if problems.is_empty() { Ok(AppDesign { html, manifest, tests }) } else { Err(problems) }
    }

    /// The body as `surface_versions.body` keeps it.
    pub fn to_body(&self) -> Value {
        let m = &self.manifest;
        let mut manifest = Map::new();
        manifest.insert("title".into(), json!(m.title));
        manifest.insert("summary".into(), json!(m.summary));
        if let Some(height) = m.height {
            manifest.insert("height".into(), json!(height));
        }
        manifest.insert("uses".into(), json!(m.uses));
        manifest.insert("queries".into(), json!(m.queries));
        if let Some(files) = &m.files {
            manifest
                .insert("files".into(), json!({"root": files.root.as_str(), "read": files.read, "write": files.write}));
        }
        manifest.insert("stateMaxBytes".into(), json!(m.state_max_bytes));
        let mut body = Map::new();
        body.insert("html".into(), json!(self.html));
        body.insert("manifest".into(), Value::Object(manifest));
        if let Some(tests) = &self.tests {
            body.insert("tests".into(), json!(tests));
        }
        Value::Object(body)
    }

    /// What the App may do, in Eos's words: `title_of` names an action or a
    /// query as the user reads it.
    pub fn access_line(&self, title_of: impl Fn(&str) -> String) -> String {
        let m = &self.manifest;
        let mut parts = Vec::new();
        if !m.uses.is_empty() {
            let titles: Vec<String> = m.uses.iter().map(|id| title_of(id)).collect();
            parts.push(format!("can {}", titles.join(", ")));
        }
        if !m.queries.is_empty() {
            let titles: Vec<String> = m.queries.iter().map(|id| title_of(id)).collect();
            parts.push(format!("reads {}", titles.join(", ")));
        }
        if let Some(files) = &m.files {
            let place = match files.root {
                FileRoot::Project => "in this project",
                FileRoot::RoutineFiles => "in the routine's files",
            };
            if !files.read.is_empty() {
                parts.push(format!("can read {} {place}", files.read.join(", ")));
            }
            if !files.write.is_empty() {
                parts.push(format!("can write {} {place}", files.write.join(", ")));
            }
        }
        if parts.is_empty() {
            return "This App only draws itself: it reaches nothing of yours.".to_owned();
        }
        let mut line = format!("This App {}", parts.join("; "));
        line.push('.');
        line
    }
}

/// Every bridge name the code uses that the manifest does not declare.
fn undeclared(code: &str, manifest: &AppManifest, is_action: &dyn Fn(&str) -> bool) -> Vec<Problem> {
    let files = manifest.files.as_ref();
    named_in(code)
        .into_iter()
        .filter_map(|name| {
            let declared = match name.as_str() {
                "state.get" | "state.set" => true,
                "files.list" | "files.read" => files.is_some_and(|f| !f.read.is_empty() || !f.write.is_empty()),
                "files.write" => files.is_some_and(|f| !f.write.is_empty()),
                _ => match name.strip_prefix("query.") {
                    Some(query) => manifest.queries.iter().any(|q| q == query),
                    None if is_action(&name) => manifest.uses.contains(&name),
                    None => true,
                },
            };
            (!declared).then(|| Problem::new("html", format!("calls `{name}`, which its manifest does not declare")))
        })
        .collect()
}
