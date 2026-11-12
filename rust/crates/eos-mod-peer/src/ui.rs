//! `GET /ui/*`: this app's own dashboard bundle (`manager/routes/ui-bundle.ts`).
//!
//! A computer that controls this one loads the dashboard from here, through
//! its host facade, so the dashboard always matches the app it drives,
//! whatever version the controlling computer runs. Fingerprinted assets never
//! change; everything else is revalidated.

use std::path::{Component, Path, PathBuf};

use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response, percent_decode};
use eos_runtime::router::RouteDef;

fn mime(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `rel` inside `root`, or `None` when it would leave it.
fn within(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

async fn serve(root: Option<PathBuf>, req: Request) -> Result<Response, ApiError> {
    let rest = req.param("rest").unwrap_or_default();
    let rel = if rest.is_empty() {
        "index.html".to_owned()
    } else {
        percent_decode(rest).map(|d| d.into_owned()).unwrap_or_default()
    };
    let missing = || crate::no_route(&format!("/ui/{rel}"));
    let Some(file) = root.as_deref().and_then(|root| within(root, &rel)) else { return Ok(missing()) };
    match tokio::fs::metadata(&file).await {
        Ok(meta) if meta.is_file() => {}
        _ => return Ok(missing()),
    }
    let Ok(bytes) = tokio::fs::read(&file).await else { return Ok(missing()) };
    // The bundler fingerprints everything under assets/; index.html must always revalidate.
    let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Ok(Response::bytes(200, mime(&file), bytes).header("cache-control", cache))
}

/// Public by design: a controlling computer loads the bundle before its
/// dashboard can vouch for anything.
pub(crate) fn routes(root: Option<PathBuf>) -> Vec<RouteDef> {
    // `/ui`, `/ui/` and everything below.
    ["/ui", "/ui/", "/ui/{*rest}"]
        .into_iter()
        .map(|pattern| {
            let root = root.clone();
            RouteDef::get(pattern, move |req: Request| serve(root.clone(), req)).access(Access::open().peer_open())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_never_leaves_the_bundle() {
        let root = Path::new("/bundle");
        assert_eq!(within(root, "assets/app.js"), Some(PathBuf::from("/bundle/assets/app.js")));
        assert_eq!(within(root, "./index.html"), Some(PathBuf::from("/bundle/index.html")));
        assert_eq!(within(root, "../secret"), None);
        assert_eq!(within(root, "assets/../../secret"), None);
        assert_eq!(within(root, "/etc/passwd"), None);
    }

    #[test]
    fn files_are_typed_by_their_extension() {
        assert_eq!(mime(Path::new("index.HTML")), "text/html; charset=utf-8");
        assert_eq!(mime(Path::new("assets/app-1a2b.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime(Path::new("font.woff2")), "font/woff2");
        assert_eq!(mime(Path::new("blob")), "application/octet-stream");
    }
}
