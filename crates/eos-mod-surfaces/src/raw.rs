//! The raw-content origin's routes of surfaces, open and never the phone's:
//!
//! - `GET /surfaces/:id/issues/:issueId/page.html?version=`: the issue drawn
//!   in the frame, with its version or one to compare it with, under the
//!   frame's CSP (sent as a header and in the page);
//! - `GET /surfaces/:id/img/:hash`: one stored image;
//! - `GET /surfaces/_probe/:token.html`: a document the page probe measures
//!   (a page drawn in its frame, or an App's test document under its own policy),
//!   held for a minute.
//!
//! The dashboard frames a page with `sandbox="allow-scripts"`, so a page has
//! no origin of its own and reaches nothing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::{Clock, Ids};
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::render::{frame_csp, frame_document, runtime_hash};

use crate::SurfacesParts;
use crate::page::load;
use crate::routes::param;

/// How long a probe document stays.
const PROBE_DOC_MS: i64 = 60_000;

/// A held document, the policy it is served under, and until when.
type Held = (String, Option<&'static str>, i64);

/// Documents the page probe loads, by a token nobody can guess.
pub struct ProbeDocs {
    docs: Mutex<HashMap<String, Held>>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for ProbeDocs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeDocs").finish_non_exhaustive()
    }
}

impl ProbeDocs {
    pub(crate) fn new(clock: Arc<dyn Clock>, ids: Arc<dyn Ids>) -> Self {
        ProbeDocs { docs: Mutex::new(HashMap::new()), clock, ids }
    }

    /// Holds a page's `html` for a minute, served under the page frame's
    /// policy; the URL the probe loads it from.
    pub fn hold(&self, html: String) -> String {
        self.hold_under(html, None)
    }

    /// Holds a document whose own policy is `csp` (an App's test document).
    pub(crate) fn hold_under(&self, html: String, csp: Option<&'static str>) -> String {
        let token = self.ids.uuid();
        let now = self.clock.now_ms();
        let mut docs = self.docs.lock().unwrap_or_else(PoisonError::into_inner);
        docs.retain(|_, (_, _, until)| *until > now);
        docs.insert(token.clone(), (html, csp, now + PROBE_DOC_MS));
        format!("http://raw.eos.localhost/surfaces/_probe/{token}.html")
    }

    fn take(&self, token: &str) -> Option<(String, Option<&'static str>)> {
        let now = self.clock.now_ms();
        let docs = self.docs.lock().unwrap_or_else(PoisonError::into_inner);
        docs.get(token).filter(|(_, _, until)| *until > now).map(|(html, csp, _)| (html.clone(), *csp))
    }
}

fn html(body: String, csp: &str) -> Response {
    Response::bytes(200, "text/html; charset=utf-8", body)
        .header("content-security-policy", csp.to_owned())
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>, probe: &Arc<ProbeDocs>) -> Vec<RouteDef> {
    let at = parts.clone();
    let page = RouteDef::get("/surfaces/{id}/issues/{issueId}/page.html", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        let version = req.query().get("version").map(|v| v.into_owned());
        async move {
            let version = match version {
                None => None,
                Some(v) => Some(v.parse::<i64>().map_err(|_| ApiError::Validation("version: a number".into()))?),
            };
            let drawn = load(&at, &id, &issue_id, version).await?;
            let surface_id = drawn.surface.id.clone();
            let image_src =
                move |hash: &str| Some(format!("http://raw.eos.localhost/surfaces/{surface_id}/img/{hash}"));
            let live = HashMap::new();
            let doc = frame_document(&drawn.input(&image_src, &live), &drawn.surface.id);
            Ok(html(doc, &frame_csp(&drawn.surface.id)))
        }
    });

    let at = parts.clone();
    let image = RouteDef::get("/surfaces/{id}/img/{hash}", move |req: Request| {
        let (at, id, hash) = (at.clone(), param(&req, "id"), param(&req, "hash"));
        async move {
            let found = at.images.read(&id, &hash, None).await?;
            let image = found.ok_or_else(|| ApiError::NotFound("image not found".into()))?;
            Ok(Response::bytes(200, image.content_type, image.body)
                .header("x-content-type-options", "nosniff")
                .header("cache-control", "private, max-age=31536000, immutable"))
        }
    });

    let docs = probe.clone();
    let probe_doc = RouteDef::get("/surfaces/_probe/{file}", move |req: Request| {
        let (docs, file) = (docs.clone(), param(&req, "file"));
        async move {
            let token = file.strip_suffix(".html").unwrap_or_default();
            let (doc, own) = docs.take(token).ok_or_else(|| ApiError::NotFound("not found".into()))?;
            if let Some(csp) = own {
                return Ok(html(doc, csp));
            }
            let csp = format!(
                "default-src 'none'; script-src 'sha256-{}'; style-src 'unsafe-inline'; img-src http://raw.eos.localhost/surfaces/ data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
                runtime_hash()
            );
            Ok(html(doc, &csp))
        }
    });

    [page, image, probe_doc].into_iter().map(|route| route.access(Access::open())).collect()
}
