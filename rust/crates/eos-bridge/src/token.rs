//! The ui-token rule. The token proves a request comes from this Mac's dashboard itself:
//! a sandboxed frame inside it can still send requests to the app's origin, but cannot read
//! the token, so privileged routes keep asking for `x-eos-ui-token` exactly as today.

use crate::transport::{Initiator, Req};

pub const TOKEN_HEADER: &str = "x-eos-ui-token";

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether `given` is the ui-token. An empty token never matches.
pub fn matches(token: &str, given: Option<&str>) -> bool {
    !token.is_empty() && given.is_some_and(|g| same(token, g))
}

/// Whether the request carries the ui-token in its header.
pub fn authorized(token: &str, req: &Req) -> bool {
    matches(token, req.header(TOKEN_HEADER))
}

/// True for the dashboard's own top-level document load only: the one response that
/// carries the token.
pub fn is_top_level_document(req: &Req) -> bool {
    req.initiator == Initiator::TopLevel
}

/// True when the dashboard's own document made the request: not a navigation, not a frame
/// inside it (a sandboxed frame must never ride the dashboard's rights).
pub fn is_from_dashboard(req: &Req) -> bool {
    req.initiator == Initiator::Document
}

/// Visual answers load images and map tiles from the core's media proxy, which wants the
/// ui-token, and neither `<img>` nor the map library can add a header. The shell adds it
/// for exactly those two prefixes, for the dashboard's own subresource loads only.
const MEDIA_PREFIXES: [&str; 2] = ["/api/genui/media/", "/api/genui/map/"];

pub fn wants_media_token(core_target: &str, req: &Req) -> bool {
    MEDIA_PREFIXES.iter().any(|p| core_target.starts_with(p)) && req.is_read() && is_from_dashboard(req)
}

/// The open panels (`/pick-directory`, `/pick-file`) want the ui-token: a dialog on the
/// user's screen is theirs to raise. The dashboard asks for them without a token, as it
/// always has, so the shell adds it for exactly these two reads, and only when the
/// dashboard's own document asked: a frame inside it, another view or the raw-content
/// origin never gets it.
const DIALOG_ROUTES: [&str; 2] = ["/pick-directory", "/pick-file"];

pub fn wants_dialog_token(core_target: &str, req: &Req) -> bool {
    let path = core_target.split_once('?').map_or(core_target, |(path, _)| path);
    DIALOG_ROUTES.contains(&path) && req.method == "GET" && is_from_dashboard(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(headers: &[(&str, &str)]) -> Req {
        from(Initiator::Document, headers)
    }

    fn from(initiator: Initiator, headers: &[(&str, &str)]) -> Req {
        Req {
            initiator,
            method: "GET".into(),
            url: String::new(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: vec![],
        }
    }

    #[test]
    fn the_header_must_equal_the_token() {
        assert!(authorized("s3cret", &req(&[("X-Eos-Ui-Token", "s3cret")])));
        assert!(!authorized("s3cret", &req(&[("x-eos-ui-token", "s3cre")])));
        assert!(!authorized("s3cret", &req(&[("x-eos-ui-token", "S3CRET")])));
        assert!(!authorized("s3cret", &req(&[])));
    }

    #[test]
    fn an_empty_token_authorizes_nobody() {
        assert!(!authorized("", &req(&[("x-eos-ui-token", "")])));
        assert!(!matches("", None));
    }

    #[test]
    fn only_a_top_level_load_is_the_document() {
        assert!(is_top_level_document(&from(Initiator::TopLevel, &[])));
        assert!(!is_top_level_document(&from(Initiator::Document, &[])));
        assert!(!is_top_level_document(&from(Initiator::Frame, &[])));
        // What a page says about itself counts for nothing.
        assert!(!is_top_level_document(&from(Initiator::Frame, &[("sec-fetch-dest", "document")])));
        assert!(!is_top_level_document(&Req::default()), "unattributed is the least trusted");
    }

    #[test]
    fn media_token_only_for_the_dashboards_own_subresources() {
        assert!(wants_media_token("/api/genui/media/img?u=x", &from(Initiator::Document, &[])));
        assert!(wants_media_token("/api/genui/map/tiles/1/2/3", &from(Initiator::Document, &[])));
        // Another route never gains a token it did not send.
        assert!(!wants_media_token("/api/settings", &from(Initiator::Document, &[])));
        assert!(!wants_media_token("/api/genui/mediax", &from(Initiator::Document, &[])));
        // A frame navigated to the proxy, or a sandboxed frame loading from it, must not ride the token.
        assert!(!wants_media_token("/api/genui/media/img", &from(Initiator::TopLevel, &[])));
        assert!(!wants_media_token(
            "/api/genui/media/img",
            &from(Initiator::Frame, &[("sec-fetch-site", "same-origin")])
        ));
        let mut post = from(Initiator::Document, &[]);
        post.method = "POST".into();
        assert!(!wants_media_token("/api/genui/media/img", &post));
    }

    #[test]
    fn only_the_dashboards_own_document_may_raise_an_open_panel() {
        assert!(wants_dialog_token("/pick-directory", &req(&[])));
        assert!(wants_dialog_token("/pick-file?start=/tmp", &req(&[])));
        // A sandboxed frame inside the dashboard, and the load of a page itself.
        assert!(!wants_dialog_token("/pick-directory", &from(Initiator::Frame, &[])));
        assert!(!wants_dialog_token("/pick-directory", &from(Initiator::TopLevel, &[])));
        // Nothing but these two routes, and only as a read.
        assert!(!wants_dialog_token("/pick-directory/x", &req(&[])));
        assert!(!wants_dialog_token("/fs/open", &req(&[])));
        let mut post = req(&[]);
        post.method = "POST".into();
        assert!(!wants_dialog_token("/pick-file", &post));
    }
}
