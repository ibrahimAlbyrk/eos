//! The document an App is tested in (05 Q7): the probe loads it on the raw
//! origin at a phone's width. Eos's fake host runs in the document itself;
//! the App runs in a frame inside it, sandboxed to scripts alone under the
//! frame's own policy as the dashboard draws it, with Eos's harness first
//! and the builder's tests after the App. The probe evaluates
//! [`APP_TEST_JS`], which answers `{findings}`.

use serde_json::json;

use crate::app::AppDesign;

const HOST_JS: &str = include_str!("app_test/host.js");
const HARNESS_JS: &str = include_str!("app_test/harness.js");

/// What the probe evaluates in the test document: the host's answer once
/// the harness reported, or its own finding when the App never got there.
pub const APP_TEST_JS: &str = "window.__eosAppTests";

/// The width an App is tested at: a phone's.
pub const APP_TEST_WIDTH: u16 = 360;

/// The policy an App's frame runs under, the dashboard's: inline code and
/// styles, nothing from or to the network.
pub const APP_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/// The test document's own policy: the same walls, since the frame's
/// document inherits it; only Eos's code runs in it.
pub const APP_TEST_CSP: &str = APP_CSP;

/// Text as a double-quoted attribute's value.
fn attribute(text: &str) -> String {
    text.replace('&', "&amp;").replace('"', "&quot;")
}

/// Code that stays inside its script element: a closing tag in it is
/// broken up, which a string or a comment reads the same.
fn inline(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let mut rest = code;
    while let Some(at) = rest.to_ascii_lowercase().find("</script") {
        out.push_str(&rest[..at]);
        out.push_str("<\\/");
        rest = &rest[at + 2..];
    }
    out.push_str(rest);
    out
}

/// The App's frame document: the policy, the harness, the App, its tests.
fn frame_document(app: &AppDesign) -> String {
    let tests = app.tests.as_deref().map_or_else(String::new, |tests| {
        format!("<script data-eos-tests>window.__eosTests = async (eosTest) => {{\n{}\n}};</script>\n", inline(tests))
    });
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta http-equiv=\"Content-Security-Policy\" content=\"{APP_CSP}\">\n\
         <meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <script data-eos-harness>{HARNESS_JS}</script>\n</head>\n<body>\n{}\n{tests}</body>\n</html>",
        app.html
    )
}

/// The whole test document of `app`.
pub fn app_test_document(app: &AppDesign) -> String {
    let m = &app.manifest;
    let files = m.files.as_ref();
    let declared = json!({
        "uses": m.uses,
        "queries": m.queries,
        "filesRead": files.is_some_and(|f| !f.read.is_empty()),
        "filesWrite": files.is_some_and(|f| !f.write.is_empty()),
    });
    let host = HOST_JS.replace("__DECLARED__", &inline(&declared.to_string()));
    let height = m.height.unwrap_or(crate::app::APP_HEIGHT.1);
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <style>html,body{{margin:0;padding:0}}iframe{{display:block;border:0;width:100%;height:{height}px}}</style>\n\
         </head>\n<body>\n<script data-eos-host>{host}</script>\n\
         <iframe id=\"eos-app\" sandbox=\"allow-scripts\" csp=\"{}\" srcdoc=\"{}\"></iframe>\n</body>\n</html>",
        attribute(APP_CSP),
        attribute(&frame_document(app)),
    )
}
