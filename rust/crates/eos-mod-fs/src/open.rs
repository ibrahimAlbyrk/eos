//! Handing a path to the desktop: open, reveal, open in an editor. These put
//! something on the user's screen, so only the user's own dashboard may call
//! them — an agent that can reach the routes must not. And the other way:
//! the open panel, where the user picks a folder or files.

use eos_contracts::{FsOpenInRequest, FsOpenInRequestTarget, FsWatchResponse};
use eos_core::os::OpenIn;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Deserialize;

use crate::Deps;
use crate::http::{CHANGE, Handled, abs_path, handler, require_user};

/// `{ path }`, read without rules: a missing or odd path is told apart by the handler.
#[derive(Deserialize)]
struct PathBody {
    #[serde(default)]
    path: Option<serde_json::Value>,
}

fn path_of(req: &Request) -> Result<Option<String>, ApiError> {
    let body: PathBody = req.json()?;
    Ok(body.path.and_then(|path| path.as_str().map(str::to_owned)))
}

fn ok() -> Response {
    Response::json(200, &FsWatchResponse { ok: true })
}

fn failed(e: eos_core::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

async fn open(deps: Deps, req: Request) -> Handled {
    let path = path_of(&req)?;
    let is_url = path.as_deref().is_some_and(|p| p.starts_with("http://") || p.starts_with("https://"));
    let target = match path {
        Some(url) if is_url => url,
        path => abs_path(path.as_deref(), "absolute path or URL required")?.to_string_lossy().into_owned(),
    };
    require_user(&req)?;
    deps.desktop.open_path(&target).await.map_err(failed)?;
    Ok(ok())
}

async fn reveal(deps: Deps, req: Request) -> Handled {
    let path = abs_path(path_of(&req)?.as_deref(), "absolute path required")?;
    require_user(&req)?;
    deps.desktop.reveal_path(&path).await.map_err(failed)?;
    Ok(ok())
}

fn editor_id(target: FsOpenInRequestTarget) -> Option<&'static str> {
    Some(match target {
        FsOpenInRequestTarget::Finder => return None,
        FsOpenInRequestTarget::Vscode => "vscode",
        FsOpenInRequestTarget::Cursor => "cursor",
        FsOpenInRequestTarget::Zed => "zed",
        FsOpenInRequestTarget::Sublime => "sublime",
        FsOpenInRequestTarget::Xcode => "xcode",
    })
}

async fn open_in(deps: Deps, req: Request) -> Handled {
    let body: FsOpenInRequest = req.parse()?;
    let path = abs_path(Some(&body.path), "absolute path required")?;
    require_user(&req)?;
    let target = editor_id(body.target).map_or(OpenIn::FileManager, OpenIn::Editor);
    let position = |n: Option<i64>| n.and_then(|n| u32::try_from(n).ok());
    deps.desktop.open_in(target, &path, position(body.line), position(body.column)).await.map_err(failed)?;
    Ok(ok())
}

#[derive(serde::Serialize)]
#[serde(untagged)]
enum Picked {
    Cancelled { cancelled: bool },
    Directory { path: String },
    Files { paths: Vec<String> },
}

// The open panel appears on this computer's screen, so these never cross to
// another computer or the phone.
async fn pick_directory(deps: Deps, _req: Request) -> Handled {
    let Some(picker) = &deps.picker else {
        return Err(ApiError::status_with(501, "no directory picker on this system"));
    };
    Ok(Response::json(
        200,
        &match picker.pick_directory().await.filter(|path| !path.is_empty()) {
            Some(path) => Picked::Directory { path },
            None => Picked::Cancelled { cancelled: true },
        },
    ))
}

async fn pick_file(deps: Deps, _req: Request) -> Handled {
    let Some(picker) = &deps.picker else {
        return Err(ApiError::status_with(501, "no file picker on this system"));
    };
    Ok(Response::json(
        200,
        &match picker.pick_files().await.filter(|paths| !paths.is_empty()) {
            Some(paths) => Picked::Files { paths },
            None => Picked::Cancelled { cancelled: true },
        },
    ))
}

pub(crate) fn routes(deps: &Deps) -> Vec<RouteDef> {
    vec![
        // A dialog on the user's screen: only their own window may raise one. Today's
        // routes took any local caller; the dashboard sends no token with these two, so
        // the shell's bridge vouches for a request its own document made (`eos-bridge`,
        // `token::wants_dialog_token`).
        RouteDef::get("/pick-directory", handler(deps, pick_directory)).access(Access::ui_token().local_only()),
        RouteDef::get("/pick-file", handler(deps, pick_file)).access(Access::ui_token().local_only()),
        RouteDef::post("/fs/open", handler(deps, open)).access(CHANGE),
        RouteDef::post("/fs/reveal", handler(deps, reveal)).access(CHANGE),
        RouteDef::post("/fs/open-in", handler(deps, open_in)).access(Access::open()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_manager_is_not_an_editor() {
        assert_eq!(editor_id(FsOpenInRequestTarget::Finder), None);
        assert_eq!(editor_id(FsOpenInRequestTarget::Cursor), Some("cursor"));
    }
}
