//! Responses, and the JSON conventions every route shares.

use std::borrow::Cow;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use serde::Serialize;
use sha1::{Digest, Sha1};

use super::body::Body;
use super::request::Method;
use crate::access::Refusal;

type Text = Cow<'static, str>;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(Text, Text)>,
    pub body: Body,
    /// Set when an access rule turned the caller away, so a gateway can answer
    /// in its own terms (the phone's `ROUTE_REFUSED` frame).
    pub refusal: Option<Refusal>,
    json: bool,
}

/// Today's error body, keys in today's order. A `json!` value would sort them.
#[derive(Debug, Default, Serialize)]
pub(crate) struct ErrorBody<'a> {
    pub(crate) error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) limit: Option<usize>,
}

/// A GET answer worth tagging: an unchanged one (the same list read again)
/// then costs a 304 instead of the body — over a peer link every KB is relay time.
const ETAG_MIN_BYTES: usize = 512;

impl Response {
    pub fn new(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Body::Empty, refusal: None, json: false }
    }

    /// A JSON body. A value that cannot be serialized is a 500, not a panic.
    pub fn json<T: Serialize + ?Sized>(status: u16, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(bytes) => Self::json_bytes(status, bytes.into()),
            Err(e) => Self::error(500, format!("response could not be serialized: {e}")),
        }
    }

    /// JSON that is already serialized.
    pub fn json_bytes(status: u16, json: Bytes) -> Self {
        let mut res = Self::new(status).header("content-type", "application/json");
        res.body = Body::Bytes(json);
        res.json = true;
        res
    }

    /// `{ "error": message }`.
    pub fn error(status: u16, message: impl AsRef<str>) -> Self {
        Self::json(status, &ErrorBody { error: message.as_ref(), ..ErrorBody::default() })
    }

    pub fn bytes(status: u16, content_type: impl Into<Text>, body: impl Into<Bytes>) -> Self {
        Self::new(status).header("content-type", content_type).body(Body::from(body.into()))
    }

    pub fn header(mut self, name: impl Into<Text>, value: impl Into<Text>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn body(mut self, body: Body) -> Self {
        self.body = body;
        self
    }

    pub(crate) fn refused(mut self, refusal: Refusal) -> Self {
        self.refusal = Some(refusal);
        self
    }

    /// `name` in lower case.
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_ref())
    }

    /// Tags a large JSON answer to a GET and turns it into a 304 when the
    /// caller already holds that version. The tag, not an age, says whether it
    /// changed, so the answer is marked `no-cache` unless the route chose
    /// its own caching.
    pub(crate) fn revalidated(mut self, method: Method, if_none_match: Option<&str>) -> Self {
        let Body::Bytes(json) = &self.body else { return self };
        if !(self.json && self.status == 200 && method == Method::Get && json.len() >= ETAG_MIN_BYTES) {
            return self;
        }
        let etag = format!("W/\"{}\"", URL_SAFE_NO_PAD.encode(Sha1::digest(json)));
        let own_cache_control = self.header_value("cache-control").is_none();
        if if_none_match == Some(etag.as_str()) {
            self.headers.retain(|(n, _)| n != "content-type");
            self.status = 304;
            self.body = Body::Empty;
        }
        if own_cache_control {
            self.headers.push(("cache-control".into(), "no-cache".into()));
        }
        self.headers.push(("etag".into(), etag.into()));
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn text(res: Response) -> String {
        String::from_utf8(res.body.collect().await.expect("in memory").to_vec()).expect("utf-8")
    }

    #[tokio::test]
    async fn writes_json_the_way_the_wire_expects() {
        #[derive(Serialize)]
        struct Row<'a> {
            ok: bool,
            n: f64,
            s: &'a str,
        }
        let res = Response::json(200, &Row { ok: true, n: 1.5, s: "é\u{1f}" });
        assert_eq!(res.header_value("content-type"), Some("application/json"));
        assert_eq!(text(res).await, r#"{"ok":true,"n":1.5,"s":"é\u001f"}"#);
        assert_eq!(text(Response::error(404, "not found")).await, r#"{"error":"not found"}"#);
    }

    #[tokio::test]
    async fn tags_large_get_answers_and_answers_304_to_a_match() {
        let big = json!({ "rows": "x".repeat(600) });
        let first = Response::json(200, &big).revalidated(Method::Get, None);
        let etag = first.header_value("etag").expect("tagged").to_owned();
        // sha1 + base64url of the body, as Node writes it.
        assert_eq!(etag.len(), "W/\"\"".len() + 27);
        assert_eq!(first.header_value("cache-control"), Some("no-cache"));
        assert_eq!(first.status, 200);

        let again = Response::json(200, &big).revalidated(Method::Get, Some(&etag));
        assert_eq!(again.status, 304);
        assert_eq!(again.header_value("etag"), Some(etag.as_str()));
        assert_eq!(again.header_value("cache-control"), Some("no-cache"));
        assert_eq!(text(again).await, "");

        let changed = Response::json(200, &json!({ "rows": "y".repeat(600) })).revalidated(Method::Get, Some(&etag));
        assert_eq!(changed.status, 200);
    }

    #[test]
    fn leaves_small_non_get_and_non_json_answers_alone() {
        assert!(
            Response::json(200, &json!({ "ok": true })).revalidated(Method::Get, None).header_value("etag").is_none()
        );
        let big = json!({ "rows": "x".repeat(600) });
        assert!(Response::json(200, &big).revalidated(Method::Post, None).header_value("etag").is_none());
        assert!(Response::json(404, &big).revalidated(Method::Get, None).header_value("etag").is_none());
        let raw = Response::bytes(200, "text/plain", "x".repeat(600));
        assert!(raw.revalidated(Method::Get, None).header_value("etag").is_none());
        let own = Response::json(200, &big).header("cache-control", "max-age=60").revalidated(Method::Get, None);
        assert_eq!(own.header_value("cache-control"), Some("max-age=60"));
        assert!(own.header_value("etag").is_some());
    }
}
