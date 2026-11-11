//! The router: one call per request, whoever sent it.
//!
//! `handle` never fails and never panics: a missing route, a refused caller, a
//! switched-off plugin, an oversized body, a handler's error and a handler's
//! panic all come back as today's status code and JSON body.

mod catch;
pub mod route;
#[cfg(test)]
mod tests;
mod tree;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::access::{Access, PeerRule, check_plane, check_user, speaks_for_user};
use crate::error::{Conflict, Error, panic_message};
use crate::http::error::refusal_response;
use crate::http::request::Matched;
use crate::http::response::ErrorBody;
use crate::http::{ApiError, Method, Request, Response, normalize_path, split_target};
use crate::seams::{Ids, RandomIds};
use catch::CatchUnwind;
pub use route::{BoxFuture, DEFAULT_MAX_BODY_BYTES, Handler, Methods, RouteDef, RouteMeta, Validator};
use tree::{Spans, Tree, parse_pattern};

/// Which built-in plugins are switched on. A route of a plugin that is off
/// answers 404 `plugin_off`.
pub trait PluginSwitch: Send + Sync + 'static {
    fn is_on(&self, plugin: &str) -> bool;
    /// The name the user knows the plugin by, for the refusal message.
    fn name(&self, plugin: &str) -> String {
        plugin.to_string()
    }
}

/// Every plugin on: the switch of a router that has no plugin host.
#[derive(Debug, Default, Clone, Copy)]
pub struct AllPluginsOn;

impl PluginSwitch for AllPluginsOn {
    fn is_on(&self, _plugin: &str) -> bool {
        true
    }
}

struct Route {
    meta: Arc<RouteMeta>,
    handler: Arc<dyn Handler>,
    validate: Option<Validator>,
}

/// Counters since start-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterStats {
    pub requests: u64,
    pub body_too_large: u64,
    pub panics: u64,
}

#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    body_too_large: AtomicU64,
    panics: AtomicU64,
}

pub struct RouterBuilder {
    routes: Vec<RouteDef>,
    plugins: Arc<dyn PluginSwitch>,
    ids: Arc<dyn Ids>,
    tolerate_undeclared: bool,
    local_only_under: Vec<String>,
}

impl std::fmt::Debug for RouterBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouterBuilder").field("routes", &self.routes).finish_non_exhaustive()
    }
}

impl Default for RouterBuilder {
    fn default() -> Self {
        Self {
            routes: Vec::new(),
            plugins: Arc::new(AllPluginsOn),
            ids: Arc::new(RandomIds::default()),
            tolerate_undeclared: false,
            local_only_under: Vec::new(),
        }
    }
}

impl RouterBuilder {
    pub fn route(mut self, route: RouteDef) -> Self {
        self.routes.push(route);
        self
    }

    pub fn routes(mut self, routes: impl IntoIterator<Item = RouteDef>) -> Self {
        self.routes.extend(routes);
        self
    }

    pub fn plugins(mut self, switch: Arc<dyn PluginSwitch>) -> Self {
        self.plugins = switch;
        self
    }

    pub fn ids(mut self, ids: Arc<dyn Ids>) -> Self {
        self.ids = ids;
        self
    }

    /// Lets routes without an access rule in (they still refuse every caller
    /// outside the app, and [`Router::undeclared`] lists them). For porting
    /// work in progress; a shipped router is built without this.
    pub fn tolerate_undeclared(mut self) -> Self {
        self.tolerate_undeclared = true;
        self
    }

    /// Every route at `prefix` or below it must be local-only, or the build
    /// fails. Today's local plane names whole areas (`/api/peer/*`,
    /// `/api/hosts/*`, `/h/*`, …): this keeps a route added there later from
    /// crossing to a paired computer because its author forgot to say so.
    pub fn local_only_under(mut self, prefix: impl Into<String>) -> Self {
        self.local_only_under.push(prefix.into());
        self
    }

    /// Fails on a malformed pattern, on two routes of the same method and
    /// shape (order never decides which one answers), and on a route without
    /// an access rule.
    pub fn build(self) -> Result<Router, Error> {
        let mut trees: [Tree; Method::COUNT] = Default::default();
        let mut routes: Vec<Route> = Vec::with_capacity(self.routes.len());
        let mut conflicts = Vec::new();
        for def in self.routes {
            let label = format!("{} {}", def.methods, def.pattern);
            let segments =
                parse_pattern(&def.pattern).map_err(|reason| Error::BadRoute { route: label.clone(), reason })?;
            let params = segments
                .iter()
                .filter_map(|s| match s {
                    tree::Segment::Param(n) | tree::Segment::Rest(n) => Some(n.clone()),
                    tree::Segment::Literal(_) => None,
                })
                .collect();
            let in_local_area = self.local_only_under.iter().any(|prefix| {
                def.pattern.strip_prefix(prefix.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
            });
            if in_local_area && def.access.is_some_and(|a| a.peer != PeerRule::LocalOnly) {
                return Err(Error::BadRoute { route: label, reason: "routes in this area must be local-only" });
            }
            let index = routes.len();
            let methods: &[Method] = match def.methods {
                Methods::One(ref m) => std::slice::from_ref(m),
                Methods::Any => &[Method::Get, Method::Post, Method::Put, Method::Delete, Method::Patch, Method::Head],
            };
            let mut clash = None;
            for m in methods {
                if let Err(existing) = trees[m.index()].insert(&segments, index) {
                    clash.get_or_insert(existing);
                }
            }
            if let Some(existing) = clash {
                let first = &routes[existing].meta;
                conflicts.push(Conflict {
                    what: "route",
                    name: label,
                    first: format!("{} ({} {})", first.owner, first.methods, first.pattern),
                    second: def.owner.to_string(),
                });
            }
            routes.push(Route {
                meta: Arc::new(RouteMeta {
                    methods: def.methods,
                    pattern: def.pattern.into(),
                    params,
                    access: def.access,
                    plugin: def.plugin,
                    owner: def.owner,
                    max_body: def.max_body,
                }),
                handler: def.handler,
                validate: def.validate,
            });
        }
        if !conflicts.is_empty() {
            return Err(Error::Conflicts(conflicts));
        }
        let router = Router { trees, routes, plugins: self.plugins, ids: self.ids, counters: Counters::default() };
        let undeclared = router.undeclared();
        if !undeclared.is_empty() && !self.tolerate_undeclared {
            return Err(Error::UndeclaredAccess(undeclared));
        }
        Ok(router)
    }
}

pub struct Router {
    trees: [Tree; Method::COUNT],
    routes: Vec<Route>,
    plugins: Arc<dyn PluginSwitch>,
    ids: Arc<dyn Ids>,
    counters: Counters,
}

impl std::fmt::Debug for Router {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Router").field("routes", &self.routes.len()).finish_non_exhaustive()
    }
}

impl Router {
    pub fn builder() -> RouterBuilder {
        RouterBuilder::default()
    }

    /// Answers one request. Dropping the returned future cancels the handler;
    /// dropping a streamed body cancels its producer.
    pub async fn handle(&self, mut req: Request) -> Response {
        let started = Instant::now();
        self.counters.requests.fetch_add(1, Ordering::Relaxed);
        req.id = match req.headers.get("x-request-id") {
            Some(given) if !given.is_empty() => given.to_owned(),
            _ => self.ids.request_id(),
        };
        let id = req.id.clone();
        let method = req.method;
        let caller = req.caller.kind();
        let if_none_match = req.headers.get("if-none-match").map(str::to_owned);

        let (res, route) = self.dispatch(req).await;
        let res = res.revalidated(method, if_none_match.as_deref());
        tracing::debug!(
            target: "eos::request",
            request_id = %id,
            %method,
            route = route.as_ref().map_or("-", |r| r.pattern.as_ref()),
            status = res.status,
            micros = started.elapsed().as_micros() as u64,
            caller,
        );
        res.header("x-request-id", id)
    }

    async fn dispatch(&self, mut req: Request) -> (Response, Option<Arc<RouteMeta>>) {
        let Some((index, spans)) = self.trees[req.method.index()].find(req.path()) else {
            let body = ErrorBody { error: "not found", path: Some(req.path()), ..ErrorBody::default() };
            return (Response::json(404, &body), None);
        };
        let route = &self.routes[index];
        let meta = &route.meta;
        let rule = meta.access.as_ref();
        let done = |res: Response| (res, Some(meta.clone()));

        if let Err(refusal) = check_plane(rule, &req.caller) {
            return done(refusal_response(refusal, req.path()));
        }
        if let Some(plugin) = meta.plugin.as_deref()
            && !self.plugins.is_on(plugin)
        {
            let message = format!("{} is turned off (Settings › Plugins)", self.plugins.name(plugin));
            return done(ApiError::coded(404, message, "plugin_off").into_response());
        }
        if let Err(refusal) = check_user(rule, &req.caller) {
            return done(refusal_response(refusal, req.path()));
        }
        if req.body.len() > meta.max_body {
            self.counters.body_too_large.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(request_id = %req.id, method = %req.method, path = req.path(), limit = meta.max_body, "body too large rejected");
            return done(ApiError::BodyTooLarge { limit: meta.max_body }.into_response());
        }
        req.user = speaks_for_user(rule, &req.caller);
        req.matched = Some(Matched { route: meta.clone(), spans });
        if let Some(validate) = &route.validate
            && let Err(e) = validate(&req)
        {
            return done(e.into_response());
        }

        let (id, method, path) = (req.id.clone(), req.method, req.path().to_owned());
        // The handler runs twice behind the boundary: once to build its
        // future, then on every poll.
        let outcome = match catch_unwind(AssertUnwindSafe(|| route.handler.call(req))) {
            Ok(future) => CatchUnwind(future).await,
            Err(payload) => Err(payload),
        };
        let res = match outcome {
            Ok(Ok(res)) => res,
            Ok(Err(e)) => {
                if e.status() >= 500 {
                    tracing::error!(request_id = %id, %method, path, error = %e, "request failed");
                }
                e.into_response()
            }
            Err(payload) => {
                self.counters.panics.fetch_add(1, Ordering::Relaxed);
                let message = panic_message(payload.as_ref());
                tracing::error!(request_id = %id, %method, path, panic = %message, "request handler panicked");
                Response::error(500, message)
            }
        };
        done(res)
    }

    fn lookup(&self, method: Method, target: &str) -> Option<(&Route, Spans)> {
        let (path, _) = split_target(target);
        let (index, spans) = self.trees[method.index()].find(&normalize_path(path))?;
        Some((&self.routes[index], spans))
    }

    /// The route `target` resolves to, if any. For gateways that decide
    /// something before they hand the request over (and for benchmarks).
    pub fn find(&self, method: Method, target: &str) -> Option<&RouteMeta> {
        self.lookup(method, target).map(|(r, _)| r.meta.as_ref())
    }

    /// The access rule of the route `target` resolves to.
    pub fn access_of(&self, method: Method, target: &str) -> Option<Access> {
        self.find(method, target).and_then(|m| m.access)
    }

    /// Whether `target` is one of the routes that are public by design, on a
    /// paired computer too. The host facade asks this about a host's path
    /// before it forwards a request nobody vouched for.
    pub fn is_peer_open(&self, method: Method, target: &str) -> bool {
        self.access_of(method, target).is_some_and(|a| a.peer == PeerRule::Open)
    }

    /// How many body bytes to accept for `target` before giving up: lets a
    /// transport stop reading early instead of buffering what will be refused.
    pub fn body_limit(&self, method: Method, target: &str) -> usize {
        self.find(method, target).map_or(DEFAULT_MAX_BODY_BYTES, |m| m.max_body)
    }

    /// Every route, in declaration order.
    pub fn routes(&self) -> impl Iterator<Item = &RouteMeta> {
        self.routes.iter().map(|r| r.meta.as_ref())
    }

    /// Routes without an access rule (`METHOD /pattern`).
    pub fn undeclared(&self) -> Vec<String> {
        self.routes().filter(|m| m.access.is_none()).map(|m| format!("{} {}", m.methods, m.pattern)).collect()
    }

    pub fn stats(&self) -> RouterStats {
        RouterStats {
            requests: self.counters.requests.load(Ordering::Relaxed),
            body_too_large: self.counters.body_too_large.load(Ordering::Relaxed),
            panics: self.counters.panics.load(Ordering::Relaxed),
        }
    }
}
