//! Reading files and folders: stat, list and search, the viewer's read,
//! images, default apps and their icons, installed editors.

use bytes::Bytes;
use eos_contracts::{
    DefaultAppResponse, DefaultAppResponseApp, FsEntry, FsEntryType, FsListResponse, FsReadResponse, FsStatResponse,
    FsStatResponseType, Num,
};
use eos_core::os::{FileRead, FsEntryMeta, ListDirOptions, OpenFile};
use eos_kit_fs::path::{is_inside, normalize};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde::Serialize;

use crate::Deps;
use crate::http::{
    DASHBOARD, Handled, READ, abs_path, bad, encode_uri_component, extension, handler, image_mime, text,
};
use crate::search::search_project;

/// A text file larger than this is not sent to the viewer: it shows the size
/// and offers to open the file elsewhere.
const TEXT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Bytes read from a file at a time.
pub(crate) const CHUNK: usize = 64 * 1024;

fn wire_entry(entry: FsEntryMeta) -> FsEntry {
    FsEntry {
        name: entry.name,
        absolute_path: text(&entry.absolute_path),
        relative_path: entry.relative_path,
        r#type: if entry.is_dir { FsEntryType::Directory } else { FsEntryType::File },
        is_symlink: Some(entry.is_symlink),
    }
}

/// `Math.min(Number(limit) || 50, 200)`, as a whole number. A negative one
/// counts from the end, as `slice(0, limit)` does.
fn search_limit(raw: Option<&str>) -> i64 {
    let asked = raw.and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(50.0);
    asked.min(200.0).trunc().max(-1e15) as i64
}

/// The whole file in memory; for small things the panels show inline.
pub(crate) async fn read_all(mut file: Box<dyn OpenFile>) -> Result<Vec<u8>, eos_core::Error> {
    tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::with_capacity(usize::try_from(file.size()).unwrap_or(0));
        loop {
            let chunk = file.read_at(bytes.len() as u64, CHUNK)?;
            if chunk.is_empty() {
                return Ok(bytes);
            }
            bytes.extend_from_slice(&chunk);
        }
    })
    .await
    .unwrap_or_else(|e| Err(eos_core::Error::Storage(e.to_string())))
}

async fn stat(deps: Deps, req: Request) -> Handled {
    let asked = req.query().get("path");
    let path = abs_path(asked.as_deref(), "absolute path required")?;
    let stat = deps.files.stat(&path).await?;
    Ok(Response::json(
        200,
        &FsStatResponse {
            absolute_path: text(&path),
            r#type: if stat.is_dir { FsStatResponseType::Directory } else { FsStatResponseType::File },
            size: i64::try_from(stat.size).unwrap_or(i64::MAX),
            mtime_ms: Num::from(stat.mtime_ms),
            is_symlink: stat.is_symlink,
            readonly: stat.readonly,
        },
    ))
}

async fn list(deps: Deps, req: Request) -> Handled {
    let query = req.query();
    let cwd = abs_path(query.get("cwd").as_deref(), "cwd required")?;
    let include_hidden = matches!(query.get("includeHidden").as_deref(), Some("true" | "1"));
    let options = ListDirOptions { root: &cwd, include_hidden, apply_ignore: true };
    let listed = |entries: Vec<FsEntryMeta>| {
        Response::json(200, &FsListResponse { entries: entries.into_iter().map(wire_entry).collect() })
    };

    // One level of a folder below `cwd` (browsing while writing an @-mention).
    // Judged by the text of the path, so each entry's relative path stays
    // relative to `cwd`; links are followed as in the plain listing.
    if let Some(dir) = query.get("dir").filter(|d| !d.is_empty()) {
        let target = normalize(&cwd.join(dir.as_ref()));
        if !is_inside(&cwd, &target) {
            return Err(bad("dir escapes cwd"));
        }
        return Ok(listed(deps.files.list_dir(&target, options).await?));
    }
    // A query searches the whole project by name; without one, one level is listed.
    let wanted = query.get("query").unwrap_or_default().trim().to_lowercase();
    if !wanted.is_empty() {
        let files = eos_core::git::CandidateFiles::list(deps.candidates.as_ref(), &cwd).await;
        let limit = search_limit(query.get("limit").as_deref());
        return Ok(Response::json(200, &FsListResponse { entries: search_project(&files, &cwd, &wanted, limit) }));
    }
    Ok(listed(deps.files.list_dir(&cwd, options).await?))
}

async fn read(deps: Deps, req: Request) -> Handled {
    let asked = req.query().get("path");
    let path = abs_path(asked.as_deref(), "absolute path required")?;
    let read = deps.files.read_text(&path, TEXT_MAX_BYTES).await.map_err(|e| ApiError::NotFound(e.to_string()))?;
    let size = |n: u64| Some(i64::try_from(n).unwrap_or(i64::MAX));
    let empty = FsReadResponse { path: text(&path), content: None, lines: None, binary: None, large: None, size: None };
    Ok(Response::json(
        200,
        &match read {
            FileRead::Binary { size: n } => FsReadResponse { binary: Some(true), size: size(n), ..empty },
            FileRead::Large { size: n } => FsReadResponse { large: Some(true), size: size(n), ..empty },
            FileRead::Text { content, lines, size: n } => {
                FsReadResponse { content: Some(content), lines: size(lines), size: size(n), ..empty }
            }
        },
    ))
}

/// `n.toString(36)` of a whole number.
fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

async fn image(deps: Deps, req: Request) -> Handled {
    let asked = req.query().get("path");
    let path = abs_path(asked.as_deref(), "absolute path required")?;
    let not_found = |e: eos_core::Error| ApiError::NotFound(e.to_string());
    let file = deps.files.open(&path).await.map_err(not_found)?;
    // The file behind a path can change, so the caller revalidates every use:
    // an unchanged file costs a 304, an edited one is never stale.
    let etag = format!("\"{}-{}\"", base36(file.size()), base36(file.mtime_ms().floor() as u64));
    let headers = |res: Response| {
        res.header("content-type", image_mime(&extension(&text(&path))))
            .header("cache-control", "no-cache")
            .header("etag", etag.clone())
    };
    if req.headers.get("if-none-match") == Some(etag.as_str()) {
        return Ok(headers(Response::new(304)));
    }
    let bytes = read_all(file).await.map_err(not_found)?;
    Ok(headers(Response::new(200)).body(Bytes::from(bytes).into()))
}

async fn icon(deps: Deps, req: Request) -> Handled {
    let Some(bundle_id) = req.query().get("bundleId").filter(|id| !id.is_empty()) else {
        return Err(bad("bundleId required"));
    };
    let Some(path) = deps.desktop.icon_path_for_bundle_id(&bundle_id).await else {
        return Err(ApiError::NotFound("bundle not resolved yet — query /fs/default-app first".into()));
    };
    let bytes = read_all(deps.files.open(&path).await?).await?;
    Ok(Response::bytes(200, "image/png", bytes).header("cache-control", "public, max-age=86400"))
}

async fn default_app(deps: Deps, req: Request) -> Handled {
    let query = req.query();
    let (path, ext) = (query.get("path").filter(|p| !p.is_empty()), query.get("ext").filter(|e| !e.is_empty()));
    if path.is_none() && ext.is_none() {
        return Err(bad("path or ext required"));
    }
    if path.is_some() {
        abs_path(path.as_deref(), "path must be absolute")?;
    }
    let app =
        deps.desktop.resolve_default_app(path.as_deref(), ext.as_deref()).await.map(|app| DefaultAppResponseApp {
            icon_url: (!app.bundle_id.is_empty())
                .then(|| format!("/fs/icon?bundleId={}", encode_uri_component(&app.bundle_id))),
            bundle_id: app.bundle_id,
            bundle_path: app.bundle_path,
            app_name: app.app_name,
        });
    Ok(Response::json(200, &DefaultAppResponse { app }))
}

#[derive(Serialize)]
struct EditorOut {
    id: &'static str,
    name: &'static str,
}

#[derive(Serialize)]
struct EditorsOut {
    editors: Vec<EditorOut>,
}

async fn editors(deps: Deps, _req: Request) -> Handled {
    let editors = deps.desktop.installed_editors().into_iter().map(|e| EditorOut { id: e.id, name: e.name }).collect();
    Ok(Response::json(200, &EditorsOut { editors }))
}

pub(crate) fn routes(deps: &Deps) -> Vec<RouteDef> {
    vec![
        RouteDef::get("/fs/stat", handler(deps, stat)).access(READ),
        RouteDef::get("/fs/list", handler(deps, list)).access(READ),
        RouteDef::get("/fs/read", handler(deps, read)).access(READ),
        RouteDef::get("/fs/image", handler(deps, image)).access(READ),
        RouteDef::get("/fs/icon", handler(deps, icon)).access(READ),
        RouteDef::get("/fs/default-app", handler(deps, default_app)).access(READ),
        RouteDef::get("/fs/editors", handler(deps, editors)).access(DASHBOARD),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_limit_reads_as_the_javascript_expression_does() {
        assert_eq!(search_limit(None), 50);
        assert_eq!(search_limit(Some("5")), 5);
        assert_eq!(search_limit(Some("abc")), 50);
        assert_eq!(search_limit(Some("")), 50);
        assert_eq!(search_limit(Some("0")), 50);
        assert_eq!(search_limit(Some("999")), 200);
        assert_eq!(search_limit(Some("2.9")), 2);
        assert_eq!(search_limit(Some("-3")), -3);
    }

    #[test]
    fn base36_matches_javascript() {
        // (26).toString(36), (1767259800125).toString(36)
        assert_eq!(base36(26), "q");
        assert_eq!(base36(0), "0");
        assert_eq!(base36(1_767_259_800_125), "mjv8uszh");
    }
}
