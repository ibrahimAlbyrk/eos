//! Raw file content: what the HTML viewer, media players and the PDF viewer
//! load. These routes belong to the raw-content origin only and are never
//! part of the API router: the HTML viewer runs untrusted files with scripts
//! allowed, which is safe only while that content cannot share an origin with
//! the dashboard and its token.

use std::path::{Path, PathBuf};

use eos_core::os::OpenFile;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Body, ByteRange, Request, file_response, percent_decode};
use eos_runtime::router::RouteDef;

use crate::Deps;
use crate::http::{Handled, bad, content_type_for, handler, text};
use crate::read::CHUNK;

/// Chunks read ahead of a slow caller.
const AHEAD: usize = 4;

/// The file's bytes (or one range of them) as a stream, read as the caller
/// takes them. A caller that goes away ends the reading.
fn stream(mut file: Box<dyn OpenFile>, range: Option<ByteRange>) -> Body {
    let (start, end) = range.map_or((0, file.size()), |r| (r.start, r.end + 1));
    if start >= end {
        return Body::Empty;
    }
    let (tx, body) = Body::channel(AHEAD);
    tokio::task::spawn_blocking(move || {
        let mut at = start;
        while at < end {
            let want = usize::try_from(end - at).unwrap_or(CHUNK).min(CHUNK);
            match file.read_at(at, want) {
                Ok(chunk) if !chunk.is_empty() => {
                    at += chunk.len() as u64;
                    if tokio::runtime::Handle::current().block_on(tx.send(chunk)).is_err() {
                        return;
                    }
                }
                // The file shrank or failed under the read: the response is cut short.
                Ok(_) => return,
                Err(e) => {
                    tokio::runtime::Handle::current().block_on(tx.fail(e.to_string()));
                    return;
                }
            }
        }
    });
    body
}

async fn serve_file(deps: &Deps, path: &Path, range: Option<&str>) -> Handled {
    let Ok(file) = deps.files.open(path).await else {
        return Err(ApiError::NotFound("not found".into()));
    };
    if !file.is_file() {
        return Err(ApiError::NotFound("not a file".into()));
    }
    Ok(file_response(content_type_for(&text(path)), file.size(), range, |range| stream(file, range)))
}

// The path is part of the URL (`/fs/raw/Users/…`, not `?path=`) so that the
// relative links of a served page (`./game.js`, `./img/x.png`) reach the
// files beside it.
async fn raw(deps: Deps, req: Request) -> Handled {
    let rest = req.param("path").unwrap_or_default();
    let Some(decoded) = percent_decode(rest) else { return Err(bad("bad path encoding")) };
    let path = format!("/{decoded}");
    if path.contains('\0') {
        return Err(bad("absolute path required"));
    }
    serve_file(&deps, Path::new(&path), req.headers.get("range")).await
}

// The bundled PDF viewer. It must be on the origin of the files it shows: it
// only loads documents from its own origin.
async fn pdfjs(deps: Deps, root: PathBuf, req: Request) -> Handled {
    let rest = req.param("path").filter(|rest| !rest.is_empty()).unwrap_or("web/viewer.html");
    // The request's path is already resolved: no `..` is left in it.
    let file = root.join(rest);
    if !file.starts_with(&root) {
        return Err(ApiError::NotFound("not found".into()));
    }
    serve_file(&deps, &file, req.headers.get("range")).await
}

pub(crate) fn routes(deps: &Deps, pdfjs_root: Option<PathBuf>) -> Vec<RouteDef> {
    let access = Access::open().phone(Tier::Read);
    let mut routes = vec![RouteDef::get("/fs/raw/{*path}", handler(deps, raw)).access(access)];
    if let Some(root) = pdfjs_root {
        for pattern in ["/pdfjs", "/pdfjs/", "/pdfjs/{*path}"] {
            let root = root.clone();
            let viewer = handler(deps, move |deps, req| pdfjs(deps, root.clone(), req));
            routes.push(RouteDef::get(pattern, viewer).access(access));
        }
    }
    routes
}
