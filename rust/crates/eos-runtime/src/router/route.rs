//! How a route is declared.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::access::Access;
use crate::http::{ApiError, Method, Request, Response};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A route's code: takes the request, answers or fails. Any
/// `async fn(Request) -> Result<Response, ApiError>` is one.
pub trait Handler: Send + Sync + 'static {
    fn call(&self, req: Request) -> BoxFuture<'static, Result<Response, ApiError>>;
}

impl<F, Fut> Handler for F
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Response, ApiError>> + Send + 'static,
{
    fn call(&self, req: Request) -> BoxFuture<'static, Result<Response, ApiError>> {
        Box::pin(self(req))
    }
}

/// Checks a request before its handler runs (after the access rule).
pub type Validator = Arc<dyn Fn(&Request) -> Result<(), ApiError> + Send + Sync>;

/// JSON bodies above this are refused with 413, as today.
pub const DEFAULT_MAX_BODY_BYTES: usize = 1024 * 1024;

/// The methods a route answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Methods {
    One(Method),
    /// Every method (a proxy such as the host facade).
    Any,
}

impl fmt::Display for Methods {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Methods::One(m) => m.fmt(f),
            Methods::Any => f.write_str("*"),
        }
    }
}

/// One route: method, path pattern, access rule, handler.
///
/// Patterns are literal segments, `{name}` (or `:name`, as the contract
/// route table writes it) for one segment and a final `{*name}` for the rest
/// of the path (at least one character): `/workers/{id}/btw`,
/// `/fs/raw/{*path}`. A literal segment wins over a
/// parameter, so `/workers/archived` and `/workers/{id}` coexist in any order.
///
/// ```
/// use eos_runtime::access::{Access, Tier};
/// use eos_runtime::http::{Request, Response};
/// use eos_runtime::router::RouteDef;
///
/// let route = RouteDef::get("/workers/{id}/queue", |req: Request| async move {
///     Ok(Response::json(200, &serde_json::json!({ "worker": req.param("id") })))
/// })
/// .access(Access::open().phone(Tier::Read));
/// # let _ = route;
/// ```
#[derive(Clone)]
pub struct RouteDef {
    pub(crate) methods: Methods,
    pub(crate) pattern: String,
    pub(crate) access: Option<Access>,
    pub(crate) handler: Arc<dyn Handler>,
    pub(crate) plugin: Option<Arc<str>>,
    pub(crate) owner: Arc<str>,
    pub(crate) max_body: usize,
    pub(crate) validate: Option<Validator>,
}

impl RouteDef {
    pub fn new(methods: Methods, pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self {
            methods,
            pattern: pattern.into(),
            access: None,
            handler: Arc::new(handler),
            plugin: None,
            owner: Arc::from("kernel"),
            max_body: DEFAULT_MAX_BODY_BYTES,
            validate: None,
        }
    }

    pub fn get(pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self::new(Methods::One(Method::Get), pattern, handler)
    }

    pub fn post(pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self::new(Methods::One(Method::Post), pattern, handler)
    }

    pub fn put(pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self::new(Methods::One(Method::Put), pattern, handler)
    }

    pub fn delete(pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self::new(Methods::One(Method::Delete), pattern, handler)
    }

    pub fn any(pattern: impl Into<String>, handler: impl Handler) -> Self {
        Self::new(Methods::Any, pattern, handler)
    }

    /// Who may call it. A route without a rule is refused to every caller
    /// outside the app, and [`RouterBuilder::build`](super::RouterBuilder::build) reports it.
    pub fn access(mut self, access: Access) -> Self {
        self.access = Some(access);
        self
    }

    /// The largest body it accepts (uploads raise it; the default is 1 MiB).
    pub fn max_body(mut self, bytes: usize) -> Self {
        self.max_body = bytes;
        self
    }

    /// A check that runs before the handler: typically "the body parses as
    /// this route's request type".
    pub fn validate(mut self, check: impl Fn(&Request) -> Result<(), ApiError> + Send + Sync + 'static) -> Self {
        self.validate = Some(Arc::new(check));
        self
    }

    /// The built-in plugin that switches this route on and off. A module's
    /// routes get its plugin when modules are composed.
    pub fn plugin(mut self, id: impl Into<Arc<str>>) -> Self {
        self.plugin = Some(id.into());
        self
    }

    pub(crate) fn owned_by(mut self, owner: &Arc<str>) -> Self {
        self.owner = owner.clone();
        self
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    pub fn methods(&self) -> Methods {
        self.methods
    }
}

impl fmt::Debug for RouteDef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RouteDef")
            .field("methods", &self.methods)
            .field("pattern", &self.pattern)
            .field("access", &self.access)
            .field("plugin", &self.plugin)
            .finish_non_exhaustive()
    }
}

/// What the router keeps of a route besides its handler.
#[derive(Debug)]
pub struct RouteMeta {
    pub methods: Methods,
    pub pattern: Box<str>,
    /// Parameter names in path order.
    pub params: Box<[Box<str>]>,
    pub access: Option<Access>,
    pub plugin: Option<Arc<str>>,
    /// The module that declared it.
    pub owner: Arc<str>,
    pub max_body: usize,
}
