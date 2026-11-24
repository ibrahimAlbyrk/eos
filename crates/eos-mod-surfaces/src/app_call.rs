//! `POST /api/surfaces/:id/app/call` (05 Q7): one `tools/call` of an App,
//! which the dashboard only relays. The core holds the App to the manifest
//! of the version in use: an action it `uses` goes through the dispatcher
//! and the gate like a press, a `query.<id>` it declares is read for its
//! routine, `state.*` is its own saved state, and `files.*` reach only the
//! files its globs name below its root. Anything else is refused. At most
//! ten calls a second and sixteen at once per App, and two state writes a
//! second. Logs carry the surface, the version and the kind of call: never
//! arguments, results or paths.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_contracts::{AppCallAnswer, AppCallRequest};
use eos_core::store::StoredSurface;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::{APP_FILE_BYTES, APP_FILES_LISTED, AppDesign, FileRoot, FileScope, Level, app_path, glob_matches};
use serde_json::{Value, json};

use crate::SurfacesParts;
use crate::apps::apps_on;
use crate::dispatch::{AppPress, Dispatcher};
use crate::routes::{param, save_state, surface_in};

const CALLS_PER_SECOND: usize = 10;
const CALLS_IN_FLIGHT: usize = 16;
const STATE_WRITES_PER_SECOND: usize = 2;

#[derive(Debug, Default)]
struct Window {
    calls: VecDeque<i64>,
    writes: VecDeque<i64>,
    in_flight: usize,
}

/// What each App called lately, by surface.
#[derive(Debug, Default)]
pub(crate) struct AppCalls(Mutex<HashMap<String, Window>>);

/// One call in flight; it ends when dropped.
struct Slot(Arc<AppCalls>, String);

impl Drop for Slot {
    fn drop(&mut self) {
        let mut windows = self.0.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(window) = windows.get_mut(&self.1) {
            window.in_flight = window.in_flight.saturating_sub(1);
        }
    }
}

fn recent(times: &mut VecDeque<i64>, now: i64, max: usize) -> bool {
    while times.front().is_some_and(|at| *at <= now - 1_000) {
        times.pop_front();
    }
    if times.len() >= max {
        return false;
    }
    times.push_back(now);
    true
}

impl AppCalls {
    fn admit(self: &Arc<Self>, surface_id: &str, now: i64, writes_state: bool) -> Result<Slot, ApiError> {
        let mut windows = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let window = windows.entry(surface_id.to_owned()).or_default();
        if window.in_flight >= CALLS_IN_FLIGHT {
            return Err(ApiError::LimitExceeded(format!("this App has {CALLS_IN_FLIGHT} calls waiting")));
        }
        if !recent(&mut window.calls, now, CALLS_PER_SECOND) {
            return Err(ApiError::LimitExceeded(format!("an App makes at most {CALLS_PER_SECOND} calls a second")));
        }
        if writes_state && !recent(&mut window.writes, now, STATE_WRITES_PER_SECOND) {
            let max = STATE_WRITES_PER_SECOND;
            return Err(ApiError::LimitExceeded(format!("an App saves its state at most {max} times a second")));
        }
        window.in_flight += 1;
        Ok(Slot(self.clone(), surface_id.to_owned()))
    }
}

/// The App in use on the surface, as the call's version names it.
async fn app_in_use(parts: &SurfacesParts, id: String, version: i64) -> Result<(StoredSurface, AppDesign), ApiError> {
    let (surface, body) = parts
        .store
        .read(move |tx| {
            let surface = surface_in(tx, &id)?;
            let body = tx.surface_versions().find(&id, version)?.map(|found| found.body_json);
            Ok((surface, body))
        })
        .await?;
    if surface.level != Level::App || surface.archived_at.is_some() {
        return Err(ApiError::NotFound("this surface has no App".into()));
    }
    if surface.current_version != Some(version) {
        return Err(ApiError::Conflict("this version of the App is not the one in use".into()));
    }
    let body: Value = body.and_then(|body| serde_json::from_str(&body).ok()).unwrap_or_default();
    let registry = parts.actions.registry();
    let app = AppDesign::from_body(&body, |id| registry.action(id).is_some())
        .map_err(|_| ApiError::Conflict("this App no longer passes Eos's scan".into()))?;
    Ok((surface, app))
}

/// The folder the App's files are in: its routine's project, or the
/// routine's own `files/`.
async fn root_of(parts: &SurfacesParts, routine_id: &str, root: FileRoot) -> Result<PathBuf, ApiError> {
    if root == FileRoot::RoutineFiles {
        return Ok(parts.folders.routine_dir(routine_id).join("files"));
    }
    let id = routine_id.to_owned();
    let blueprint = parts
        .store
        .read(move |tx| {
            let Some(routine) = tx.routines().find(&id)? else { return Ok(None) };
            let Some(head) = routine.head_version_id else { return Ok(None) };
            Ok(tx.routine_versions().find(&id, &head)?.map(|version| version.blueprint))
        })
        .await?;
    let blueprint: Value = blueprint.and_then(|b| serde_json::from_str(&b).ok()).unwrap_or_default();
    let repo = blueprint["project"]["repo"].as_str().unwrap_or_default().to_owned();
    if repo.is_empty() {
        return Err(ApiError::NotFound("this App's routine works in no project".into()));
    }
    let path = if repo.starts_with("git:") { parts.keys.find_path(&repo).await } else { Some(repo) };
    path.map(PathBuf::from).ok_or_else(|| ApiError::NotFound("this App's project is not on this computer".into()))
}

fn scope_of(app: &AppDesign) -> Result<&FileScope, ApiError> {
    app.manifest.files.as_ref().ok_or_else(|| ApiError::PermissionDenied("this App declares no files".into()))
}

fn path_arg(arguments: &Value) -> Result<String, ApiError> {
    let path = arguments["path"].as_str().unwrap_or_default();
    app_path(path).map(str::to_owned).map_err(|why| ApiError::Validation(format!("path: {why}")))
}

async fn files(
    parts: &SurfacesParts,
    surface: &StoredSurface,
    app: &AppDesign,
    name: &str,
    arguments: &Value,
) -> Result<Value, ApiError> {
    let scope = scope_of(app)?;
    let root = root_of(parts, &surface.routine_id, scope.root).await?;
    match name {
        "files.list" => {
            let narrow = arguments["glob"].as_str();
            let listed = parts.app_files.list(&root, APP_FILES_LISTED * 4).await?;
            let files: Vec<String> = listed
                .into_iter()
                .filter(|path| scope.may_read(path) && narrow.is_none_or(|glob| glob_matches(glob, path)))
                .take(APP_FILES_LISTED)
                .collect();
            Ok(json!({ "files": files }))
        }
        "files.read" => {
            let path = path_arg(arguments)?;
            if !scope.may_read(&path) {
                return Err(ApiError::PermissionDenied("this App's manifest does not name that file".into()));
            }
            let body = parts.app_files.read(&root, &path, APP_FILE_BYTES).await?;
            let body = body.ok_or_else(|| ApiError::NotFound("no such file".into()))?;
            let base64 = arguments["encoding"].as_str() == Some("base64");
            match String::from_utf8(body) {
                Ok(text) if !base64 => Ok(json!({ "path": path, "text": text })),
                Ok(text) => Ok(json!({ "path": path, "base64": STANDARD.encode(text) })),
                Err(bytes) => Ok(json!({ "path": path, "base64": STANDARD.encode(bytes.into_bytes()) })),
            }
        }
        _ => {
            let path = path_arg(arguments)?;
            if !scope.may_write(&path) {
                return Err(ApiError::PermissionDenied("this App's manifest does not let it write that file".into()));
            }
            let body = match (arguments["text"].as_str(), arguments["base64"].as_str()) {
                (Some(text), None) => text.as_bytes().to_vec(),
                (None, Some(encoded)) => {
                    STANDARD.decode(encoded).map_err(|_| ApiError::Validation("base64: is not base64".into()))?
                }
                _ => return Err(ApiError::Validation("arguments: give `text` or `base64`".into())),
            };
            if body.len() > APP_FILE_BYTES {
                return Err(ApiError::Validation(format!("a file is at most {APP_FILE_BYTES} bytes")));
            }
            let bytes = body.len();
            parts.app_files.write(&root, &path, body).await?;
            Ok(json!({ "path": path, "bytes": bytes }))
        }
    }
}

async fn state(
    parts: &SurfacesParts,
    surface: &StoredSurface,
    app: &AppDesign,
    name: &str,
    arguments: &Value,
) -> Result<Value, ApiError> {
    if name == "state.get" {
        let id = surface.id.clone();
        let stored = parts.store.read(move |tx| tx.surface_state().find(&id, "")).await?;
        let data = stored.and_then(|s| serde_json::from_str::<Value>(&s.data_json).ok()).unwrap_or_else(|| json!({}));
        return Ok(json!({ "data": data }));
    }
    let data = &arguments["data"];
    if !data.is_object() {
        return Err(ApiError::Validation("data: must be an object".into()));
    }
    let max = Some(app.manifest.state_max_bytes);
    let saved = save_state(parts, surface.id.clone(), String::new(), data, max).await?;
    Ok(json!({ "updatedAt": saved.updated_at }))
}

async fn call(
    parts: &SurfacesParts,
    dispatcher: &Dispatcher,
    calls: &Arc<AppCalls>,
    id: String,
    asked: AppCallRequest,
) -> Result<Value, ApiError> {
    if !apps_on(parts) {
        return Err(ApiError::PermissionDenied("Apps are switched off in Settings".into()));
    }
    let (surface, app) = app_in_use(parts, id, asked.version).await?;
    let name = asked.name.as_str();
    let _slot = calls.admit(&surface.id, parts.clock.now_ms(), name == "state.set")?;
    let kind = match name {
        "state.get" | "state.set" => "state",
        "files.list" | "files.read" | "files.write" => "files",
        _ if name.starts_with("query.") => "query",
        _ => "action",
    };
    tracing::info!(surface = %surface.id, version = asked.version, kind, "an App called Eos");
    match kind {
        "state" => state(parts, &surface, &app, name, &asked.arguments).await,
        "files" => files(parts, &surface, &app, name, &asked.arguments).await,
        "query" => {
            let query_id = &name["query.".len()..];
            let args = if asked.arguments.is_null() { json!({}) } else { asked.arguments.clone() };
            let (answer, _) = crate::queries::read(parts, &surface, &app.manifest.queries, query_id, args).await?;
            Ok(answer)
        }
        _ => {
            if !app.manifest.uses.iter().any(|used| used == name) {
                return Err(ApiError::PermissionDenied(format!("this App's manifest does not use `{name}`")));
            }
            let client_id = asked.client_id.clone().unwrap_or_else(|| parts.ids.uuid());
            let args = if asked.arguments.is_null() { json!({}) } else { asked.arguments.clone() };
            let answer = dispatcher
                .run_app(AppPress {
                    surface_id: surface.id.clone(),
                    routine_id: surface.routine_id.clone(),
                    action_id: name.to_owned(),
                    args,
                    client_id,
                    confirm: asked.confirm.clone(),
                    typed: asked.typed.clone(),
                })
                .await?;
            Ok(serde_json::to_value(answer).unwrap_or_default())
        }
    }
}

pub(crate) fn route(parts: &Arc<SurfacesParts>, dispatcher: &Arc<Dispatcher>, calls: &Arc<AppCalls>) -> RouteDef {
    let (parts, dispatcher, calls) = (parts.clone(), dispatcher.clone(), calls.clone());
    RouteDef::post("/api/surfaces/{id}/app/call", move |req: Request| {
        let (parts, dispatcher, calls, id) = (parts.clone(), dispatcher.clone(), calls.clone(), param(&req, "id"));
        async move {
            let asked: AppCallRequest = req.parse()?;
            let result = call(&parts, &dispatcher, &calls, id, asked).await?;
            Ok(Response::json(200, &AppCallAnswer { result }))
        }
    })
    // A file of 1 MB as base64, with room for the call around it.
    .max_body(2 * APP_FILE_BYTES)
    // An App runs only in this Mac's dashboard: the phone has no App frame.
    .access(Access::ui_token())
}
