//! The page as the dashboard frames it: one document with Eos's base
//! stylesheet first, the faces the page names inlined, the page's own style,
//! the body, and the page runtime, which the CSP admits by its hash alone.

use std::sync::LazyLock;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::css::font_faces;

use super::format::escape;
use super::{Mode, RenderInput, render_body};

/// The only script a page runs.
pub const RUNTIME_JS: &str = include_str!("../../assets/page-runtime.js");
/// The measuring script the page probe evaluates in a candidate page.
pub const PROBE_JS: &str = include_str!("../../assets/page-probe.js");

static RUNTIME_HASH: LazyLock<String> =
    LazyLock::new(|| base64::engine::general_purpose::STANDARD.encode(Sha256::digest(RUNTIME_JS.as_bytes())));

/// `sha256-…` of [`RUNTIME_JS`], as the CSP names it.
pub fn runtime_hash() -> &'static str {
    &RUNTIME_HASH
}

/// Eos's own look, under every page: its ground and ink, so a page with no
/// background of its own looks like Eos, and the parts Eos draws itself.
pub const BASE_CSS: &str = r#":root{color-scheme:dark}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:#101010;color:#e9e9e9;font-family:'Geist',-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.eos-page{box-sizing:border-box;max-width:1064px;margin:0 auto;padding:28px 32px}
img{max-width:100%;height:auto;display:block}
a{color:inherit}
[data-part]{break-inside:avoid}
.eos-image-missing{display:flex;align-items:flex-end;box-sizing:border-box;min-height:120px;padding:10px 12px;border-radius:3px;background:rgba(127,127,127,.14);font-size:13px;opacity:.85}
.eos-filters{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0}
.eos-filters button,.eos-button,.eos-ask{display:inline-flex;align-items:center;box-sizing:border-box;height:30px;padding:0 12px;border-radius:8px;border:1px solid rgba(127,127,127,.38);background:transparent;color:inherit;font:inherit;font-size:13px;text-decoration:none;cursor:pointer}
.eos-filters button[aria-pressed=true]{background:rgba(127,127,127,.22)}
.eos-filters button:focus-visible,.eos-button:focus-visible,.eos-ask:focus-visible{outline:2px solid #6d8bff;outline-offset:2px}
[data-filter-hidden]{display:none!important}
.eos-disclosure>summary{cursor:pointer}
.eos-secret{font-family:'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.12em}
.eos-pointing [data-part]{cursor:crosshair}
.eos-pointing [data-part]:hover{outline:1px dashed rgba(109,139,255,.8);outline-offset:3px}
.eos-pointed,.eos-pointing .eos-pointed:hover{outline:2px solid #6d8bff;outline-offset:3px}
.eos-live[data-stale]{opacity:.6}
@media print{body{background:#fff;color:#000}.eos-page{max-width:none;padding:0}.eos-filters,.eos-button,.eos-ask{display:none}}
"#;

/// The frame's policy: no network, no form, no other script, images only
/// from the surface's own store.
pub fn frame_csp(surface_id: &str) -> String {
    format!(
        "default-src 'none'; script-src 'sha256-{}'; style-src 'unsafe-inline'; img-src http://raw.eos.localhost/surfaces/{surface_id}/img/ data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
        runtime_hash()
    )
}

/// The whole frame document for an issue.
pub fn frame_document(input: &RenderInput<'_>, surface_id: &str) -> String {
    document(input, Mode::Frame, &frame_csp(surface_id), Some(RUNTIME_JS))
}

/// A document of `mode` with `csp`, and the runtime only when given.
pub(crate) fn document(input: &RenderInput<'_>, mode: Mode, csp: &str, script: Option<&str>) -> String {
    let mut families = vec!["Geist"];
    families.extend(input.design.style.families().into_iter().filter(|f| *f != "Geist"));
    let body = render_body(input, mode);
    let mut out = String::with_capacity(body.len() + 64 * 1024);
    out.push_str("<!doctype html><html lang=\"");
    out.push_str(&escape(input.lang));
    out.push_str(
        "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    );
    out.push_str(&format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">", escape(csp)));
    out.push_str(&format!("<title>{}</title><style>", escape(input.title)));
    out.push_str(&font_faces(&families));
    out.push_str(BASE_CSS);
    out.push_str("</style><style>");
    out.push_str(&input.design.style.to_css());
    out.push_str("</style>");
    out.push_str(&super::comfort::css(input.comfort));
    out.push_str(&format!(
        "</head><body><div class=\"eos-page\" role=\"document\" aria-label=\"{}\">",
        escape(input.title)
    ));
    out.push_str(&body);
    out.push_str("</div>");
    if let Some(script) = script {
        out.push_str("<script>");
        out.push_str(script);
        out.push_str("</script>");
    }
    out.push_str("</body></html>");
    out
}
