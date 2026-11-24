//! A page issue taken out of the frame:
//!
//! - `GET /api/surfaces/:id/issues/:issueId/document?mode=phone|share`: one
//!   document with no script, images inlined (for the phone at most 800 px,
//!   and the whole under 3.5 MB so its frame through the relay stays under
//!   5 MB; an image past that is drawn as its alt text);
//! - `GET …/issues/:issueId/mail`: the mail as it would be sent, its images
//!   inlined so a browser shows it;
//! - `POST …/issues/:issueId/pdf {paper?}`: the issue printed by the shell's
//!   hidden view to `surfaces/<sf>/exports/<si>.pdf` (A4 unless the reader's
//!   region asks for Letter), its images inlined; refused without the window;
//! - [`SurfaceRender`] for the mail channel: the mail with its images as
//!   `cid:` parts, at most 600 px and 5 MB in all.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use eos_contracts::{PdfExport, PdfRequest};
use eos_core::surface::{InlineImage, MailDocument, Paper, ProbeDoc, StoredImage, SurfaceRender};
use eos_core::{BoxFuture, Error};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use eos_surface::limits::{MAIL_IMAGE_BYTES, MAIL_IMAGE_WIDTH, PHONE_DOCUMENT_BYTES, PHONE_IMAGE_WIDTH};
use eos_surface::render::{PHONE_CSP, frame_document, mail_body, phone_document, share_document};

use crate::SurfacesParts;
use crate::page::{Drawn, load};
use crate::raw::ProbeDocs;
use crate::routes::param;

/// Each image of the issue read once at `width`, while the running total
/// stays under `budget`; past it, an image is left to its alt text.
async fn read_images(
    parts: &SurfacesParts,
    drawn: &Drawn,
    width: Option<u32>,
    budget: Option<usize>,
) -> Result<HashMap<String, StoredImage>, Error> {
    let mut out = HashMap::new();
    let mut total = 0;
    for hash in drawn.hashes() {
        let Some(image) = parts.images.read(&drawn.surface.id, &hash, width).await? else { continue };
        let cost = image.body.len() * 4 / 3;
        if budget.is_some_and(|budget| total + cost > budget) {
            continue;
        }
        total += cost;
        out.insert(hash, image);
    }
    Ok(out)
}

fn data_uri(image: &StoredImage) -> String {
    format!("data:{};base64,{}", image.content_type, base64::engine::general_purpose::STANDARD.encode(&image.body))
}

fn cid(hash: &str) -> String {
    format!("{}@eos", &hash[..hash.len().min(24)])
}

fn subject(drawn: &Drawn) -> String {
    match drawn.issue.seq {
        Some(seq) => format!("{} · No. {seq}", drawn.surface.title),
        None => drawn.surface.title.clone(),
    }
}

/// The issue as mail: `inline` puts images in as `data:` for a preview,
/// otherwise as `cid:` parts.
async fn mail(parts: &SurfacesParts, drawn: &Drawn, inline: bool) -> Result<MailDocument, Error> {
    let images = read_images(parts, drawn, Some(MAIL_IMAGE_WIDTH), Some(MAIL_IMAGE_BYTES)).await?;
    let src =
        |hash: &str| images.get(hash).map(|image| if inline { data_uri(image) } else { format!("cid:{}", cid(hash)) });
    let live = HashMap::new();
    let body = mail_body(&drawn.input(&src, &live));
    let inline_images = if inline {
        Vec::new()
    } else {
        images
            .iter()
            .map(|(hash, image)| InlineImage {
                cid: cid(hash),
                content_type: image.content_type.clone(),
                body: image.body.clone(),
            })
            .collect()
    };
    Ok(MailDocument { subject: subject(drawn), html: body.html, text: body.text, inline_images, pdf: None })
}

/// Prints the issue to its export file; the file's path and size.
async fn pdf(parts: &SurfacesParts, docs: &ProbeDocs, drawn: &Drawn, paper: Paper) -> Result<PdfExport, ApiError> {
    if !parts.printer.is_available() {
        return Err(ApiError::Conflict("A PDF needs Eos's window: open Eos and try again".into()));
    }
    let images = read_images(parts, drawn, None, None).await?;
    let src = |hash: &str| images.get(hash).map(data_uri);
    let live = HashMap::new();
    let url = docs.hold(frame_document(&drawn.input(&src, &live), &drawn.surface.id));
    let out = parts.root.join(&drawn.surface.id).join("exports").join(format!("{}.pdf", drawn.issue.id));
    let bytes = parts.printer.pdf(ProbeDoc { url, script: String::new() }, paper, &out).await?;
    tracing::info!(surface = %drawn.surface.id, issue = %drawn.issue.id, bytes, "a page issue was printed to PDF");
    Ok(PdfExport { path: out.to_string_lossy().into_owned(), bytes })
}

pub(crate) fn routes(parts: &Arc<SurfacesParts>, docs: &Arc<ProbeDocs>) -> Vec<RouteDef> {
    let at = parts.clone();
    let document = RouteDef::get("/api/surfaces/{id}/issues/{issueId}/document", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        let mode = req.query().get("mode").map(|m| m.into_owned()).unwrap_or_else(|| "phone".into());
        async move {
            let phone = match mode.as_str() {
                "phone" => true,
                "share" => false,
                _ => return Err(ApiError::Validation("invalid request: mode: phone or share".into())),
            };
            let drawn = load(&at, &id, &issue_id, None).await?;
            let (width, budget) =
                if phone { (Some(PHONE_IMAGE_WIDTH), Some(PHONE_DOCUMENT_BYTES / 2)) } else { (None, None) };
            let images = read_images(&at, &drawn, width, budget).await?;
            let src = |hash: &str| images.get(hash).map(data_uri);
            let live = HashMap::new();
            let input = drawn.input(&src, &live);
            let doc = if phone { phone_document(&input) } else { share_document(&input) };
            if phone && doc.len() > PHONE_DOCUMENT_BYTES {
                return Err(ApiError::Conflict("this issue is too large for the phone".into()));
            }
            Ok(Response::bytes(200, "text/html; charset=utf-8", doc)
                .header("content-security-policy", PHONE_CSP)
                .header("x-content-type-options", "nosniff"))
        }
    })
    .access(Access::ui_token().phone_user(Tier::Read));

    let at = parts.clone();
    let preview = RouteDef::get("/api/surfaces/{id}/issues/{issueId}/mail", move |req: Request| {
        let (at, id, issue_id) = (at.clone(), param(&req, "id"), param(&req, "issueId"));
        async move {
            let drawn = load(&at, &id, &issue_id, None).await?;
            let doc = mail(&at, &drawn, true).await?;
            Ok(Response::bytes(200, "text/html; charset=utf-8", doc.html)
                .header("content-security-policy", PHONE_CSP)
                .header("x-content-type-options", "nosniff"))
        }
    })
    .access(Access::ui_token());

    let (at, docs) = (parts.clone(), docs.clone());
    let print = RouteDef::post("/api/surfaces/{id}/issues/{issueId}/pdf", move |req: Request| {
        let (at, docs, id, issue_id) = (at.clone(), docs.clone(), param(&req, "id"), param(&req, "issueId"));
        async move {
            let asked: PdfRequest = req.parse()?;
            let paper = match asked.paper.as_deref() {
                None => Paper::A4,
                Some(word) => Paper::parse(word)
                    .ok_or_else(|| ApiError::Validation("invalid request: paper: a4 or letter".into()))?,
            };
            let drawn = load(&at, &id, &issue_id, None).await?;
            Ok(Response::json(200, &pdf(&at, &docs, &drawn, paper).await?))
        }
    })
    .access(Access::ui_token());
    vec![document, preview, print]
}

/// The mail channel's view of page issues.
pub(crate) struct MailRender(pub(crate) Arc<SurfacesParts>, pub(crate) Arc<ProbeDocs>);

impl SurfaceRender for MailRender {
    fn mail_document<'a>(&'a self, issue_id: &'a str, with_pdf: bool) -> BoxFuture<'a, Result<MailDocument, Error>> {
        Box::pin(async move {
            let id = issue_id.to_owned();
            let found = self.0.store.read(move |tx| tx.surface_issues().find(&id)).await?;
            let issue = found.ok_or_else(|| Error::not_found("issue", issue_id))?;
            let drawn =
                load(&self.0, &issue.surface_id, issue_id, None).await.map_err(|e| Error::Validation(e.to_string()))?;
            let mut doc = mail(&self.0, &drawn, false).await?;
            if with_pdf {
                // Without the window the mail still goes, without its PDF.
                match pdf(&self.0, &self.1, &drawn, Paper::A4).await {
                    Ok(export) => doc.pdf = Some(export.path.into()),
                    Err(error) => tracing::info!(issue = %issue_id, %error, "a mailed issue went without its PDF"),
                }
            }
            Ok(doc)
        })
    }
}
