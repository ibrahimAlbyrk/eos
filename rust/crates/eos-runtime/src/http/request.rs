//! A request as a value: no socket behind it.

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;
use serde::de::DeserializeOwned;

use super::error::ApiError;
use super::path::{Query, normalize_path, split_target};
use crate::access::Caller;
use crate::router::route::RouteMeta;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Head,
}

impl Method {
    pub(crate) const COUNT: usize = 6;

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "DELETE" => Method::Delete,
            "PATCH" => Method::Patch,
            "HEAD" => Method::Head,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
            Method::Patch => "PATCH",
            Method::Head => "HEAD",
        }
    }

    pub(crate) fn index(self) -> usize {
        self as usize
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The request headers routes read. Whoever builds a [`Request`] may pass
/// every header it received: the rest are dropped here, so a route cannot come
/// to depend on a transport's headers (`host`, `origin`, cookies, the token).
/// Reading a new header in a route means adding it to this list.
pub const READ_HEADERS: &[&str] = &[
    "content-type",
    "if-none-match",
    "last-event-id",
    "range",
    "sec-fetch-dest",
    "x-eos-agent-id",
    "x-filename",
    "x-request-id",
];

#[derive(Debug, Clone, Default)]
pub struct Headers(Vec<(&'static str, Box<str>)>);

impl Headers {
    /// Keeps the header if routes read it (see [`READ_HEADERS`]); names match
    /// in any case. A repeated header keeps its first value.
    pub fn insert(&mut self, name: &str, value: &str) {
        let Some(known) = READ_HEADERS.iter().find(|h| h.eq_ignore_ascii_case(name)) else { return };
        if self.get(known).is_none() {
            self.0.push((known, value.into()));
        }
    }

    /// `name` in lower case.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_ref())
    }
}

pub(crate) const MAX_PARAMS: usize = 4;

/// The route a request matched and where its parameters sit in the path.
#[derive(Debug, Clone)]
pub(crate) struct Matched {
    pub(crate) route: Arc<RouteMeta>,
    pub(crate) spans: [(u32, u32); MAX_PARAMS],
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: Method,
    pub caller: Caller,
    pub headers: Headers,
    pub body: Bytes,
    path: String,
    query: Query,
    pub(crate) matched: Option<Matched>,
    pub(crate) id: String,
    pub(crate) user: bool,
}

impl Request {
    /// `target` is the path with its query, as the caller sent it. The path is
    /// resolved (dot segments applied) before anything looks at it.
    pub fn new(method: Method, target: &str, caller: Caller) -> Self {
        let (path, query) = split_target(target);
        Self {
            method,
            caller,
            headers: Headers::default(),
            body: Bytes::new(),
            path: normalize_path(path).into_owned(),
            query: Query::new(query),
            matched: None,
            id: String::new(),
            user: false,
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.insert(name, value);
        self
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = body.into();
        self
    }

    /// The resolved path, still percent-encoded.
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn query(&self) -> &Query {
        &self.query
    }

    /// The id logs carry for this request: the caller's `x-request-id`, or a minted one.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// A path parameter as written in the path (percent-encoded; see
    /// [`percent_decode`](super::path::percent_decode)).
    pub fn param(&self, name: &str) -> Option<&str> {
        let m = self.matched.as_ref()?;
        let i = m.route.params.iter().position(|p| p.as_ref() == name)?;
        let (start, end) = m.spans[i];
        self.path.get(start as usize..end as usize)
    }

    /// The pattern of the matched route (`/workers/{id}/btw`), for logs and metrics.
    pub fn route(&self) -> Option<&str> {
        self.matched.as_ref().map(|m| m.route.pattern.as_ref())
    }

    /// Whether the request carries the user's own authority: their dashboard,
    /// a paired computer's dashboard, or the phone on a route where the
    /// gateway vouches. Routes with [`Access::ui_token`](crate::access::Access::ui_token)
    /// never run without it; a route that only shows more to the user asks here.
    pub fn speaks_for_user(&self) -> bool {
        self.user
    }

    /// The JSON body as the contract type `T`, checked against its rules: what
    /// `validate(Schema, await readBody(req))` did. An empty body reads as
    /// `{}`; a failure is a 400 `invalid request: <path>: <message>; …`.
    pub fn parse<T: DeserializeOwned + eos_contracts::Validate>(&self) -> Result<T, ApiError> {
        let value: serde_json::Value = if self.body.is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_slice(&self.body)
                .map_err(|_| ApiError::Validation("invalid request: body is not valid JSON".into()))?
        };
        Ok(eos_contracts::parse(&value)?)
    }

    /// The JSON body as `T`; an empty body reads as `{}`. Failures are 400s.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, ApiError> {
        let raw: &[u8] = if self.body.is_empty() { b"{}" } else { &self.body };
        serde_json::from_slice(raw).map_err(|e| {
            if e.is_data() {
                ApiError::Validation(format!("invalid request: {e}"))
            } else {
                ApiError::Validation("invalid request: body is not valid JSON".into())
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct Focus {
        #[serde(default)]
        workers: Vec<String>,
    }

    #[test]
    fn resolves_the_path_and_keeps_the_query() {
        let req = Request::new(Method::Get, "/ui/../workers/w1/events?limit=5&order=desc", Caller::DASHBOARD);
        assert_eq!(req.path(), "/workers/w1/events");
        assert_eq!(req.query().get("limit").as_deref(), Some("5"));
    }

    #[test]
    fn keeps_only_the_headers_routes_read() {
        let req = Request::new(Method::Get, "/x", Caller::DASHBOARD)
            .header("Range", "bytes=0-1")
            .header("range", "bytes=5-6")
            .header("Cookie", "a=b")
            .header("x-eos-ui-token", "secret");
        assert_eq!(req.headers.get("range"), Some("bytes=0-1"));
        assert_eq!(req.headers.get("cookie"), None);
        assert_eq!(req.headers.get("x-eos-ui-token"), None);
    }

    #[test]
    fn reads_json_bodies() {
        let req = Request::new(Method::Post, "/x", Caller::DASHBOARD);
        assert_eq!(req.json::<Focus>().expect("empty body is {}"), Focus { workers: vec![] });
        let req = req.body(r#"{"workers":["w1"]}"#);
        assert_eq!(req.json::<Focus>().expect("valid"), Focus { workers: vec!["w1".into()] });

        let broken = Request::new(Method::Post, "/x", Caller::DASHBOARD).body("{nope");
        assert_eq!(broken.json::<Focus>(), Err(ApiError::Validation("invalid request: body is not valid JSON".into())));
        let wrong = Request::new(Method::Post, "/x", Caller::DASHBOARD).body(r#"{"workers":3}"#);
        let err = wrong.json::<Focus>().expect_err("wrong shape");
        assert_eq!(err.status(), 400);
        assert!(err.to_string().starts_with("invalid request: invalid type"), "{err}");
    }

    #[test]
    fn methods_round_trip() {
        for m in ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] {
            assert_eq!(Method::parse(m).map(Method::as_str), Some(m));
        }
        assert_eq!(Method::parse("get"), None);
        assert_eq!(Method::parse("OPTIONS"), None);
    }
}
