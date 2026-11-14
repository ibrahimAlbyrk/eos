use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::access::{Caller, LocalCaller, Refusal, Tier};
use crate::http::Body;

async fn ok(_req: Request) -> Result<Response, ApiError> {
    Ok(Response::json(200, &json!({ "ok": true })))
}

async fn echo_params(req: Request) -> Result<Response, ApiError> {
    Ok(Response::json(
        200,
        &json!({ "route": req.route(), "id": req.param("id"), "rest": req.param("rest"), "user": req.speaks_for_user(), "q": req.query().get("q") }),
    ))
}

fn peer(human: bool) -> Caller {
    Caller::Peer { device: "ab".repeat(32).into(), human }
}
const PHONE: Caller = Caller::Phone { grant: Tier::High, mutate: true };

async fn call(router: &Router, method: Method, target: &str, caller: Caller) -> (u16, Value, Response) {
    let mut res = router.handle(Request::new(method, target, caller)).await;
    let body = std::mem::replace(&mut res.body, Body::Empty).collect().await.expect("in memory");
    let value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).expect("json body") };
    (res.status, value, res)
}

struct Switch(AtomicBool);
impl PluginSwitch for Switch {
    fn is_on(&self, _plugin: &str) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    fn name(&self, plugin: &str) -> String {
        if plugin == "eos.pages" { "Pages".into() } else { plugin.into() }
    }
}

fn sample() -> Router {
    Router::builder()
        .route(RouteDef::get("/workers", ok).access(Access::open().phone(Tier::Read)))
        .route(RouteDef::get("/workers/archived", ok).access(Access::open().phone(Tier::Read)))
        .route(RouteDef::get("/workers/{id}", echo_params).access(Access::open().phone(Tier::Read)))
        .route(RouteDef::post("/workers/{id}/events", ok).access(Access::open().local_only()))
        .route(RouteDef::post("/policy/decide", ok).access(Access::open().local_only()))
        .route(RouteDef::post("/fs/write", ok).access(Access::ui_token().phone_user(Tier::High)))
        .route(RouteDef::put("/api/settings", ok).access(Access::ui_token().phone(Tier::High)))
        .route(RouteDef::get("/api/host", ok).access(Access::open().peer_open()))
        .route(RouteDef::get("/ui/{*rest}", echo_params).access(Access::open().peer_open()))
        .route(RouteDef::get("/api/plugins", echo_params).access(Access::open()))
        .route(RouteDef::any("/h/{id}/{*rest}", echo_params).access(Access::open().local_only()))
        .build()
        .expect("valid routes")
}

#[tokio::test]
async fn matches_routes_and_hands_over_parameters() {
    let r = sample();
    let (status, body, _) = call(&r, Method::Get, "/workers/w-1?q=a%20b", Caller::DASHBOARD).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "route": "/workers/{id}", "id": "w-1", "rest": null, "user": true, "q": "a b" }));
    assert_eq!(call(&r, Method::Get, "/workers/archived", Caller::DASHBOARD).await.1, json!({ "ok": true }));
    let (_, body, _) = call(&r, Method::Delete, "/h/abc/workers/w1", Caller::DASHBOARD).await;
    assert_eq!((body["id"].as_str(), body["rest"].as_str()), (Some("abc"), Some("workers/w1")));
}

#[tokio::test]
async fn answers_404_with_the_resolved_path() {
    let r = sample();
    let (status, body, _) = call(&r, Method::Get, "/nope/../missing?x=1", Caller::DASHBOARD).await;
    assert_eq!((status, body), (404, json!({ "error": "not found", "path": "/missing" })));
    // A known path under another method is not a route either.
    assert_eq!(call(&r, Method::Delete, "/workers", Caller::DASHBOARD).await.0, 404);
}

#[tokio::test]
async fn judges_access_on_the_resolved_path() {
    let r = sample();
    let (status, body, res) = call(&r, Method::Post, "/ui/../policy/decide", peer(true)).await;
    assert_eq!(status, 403);
    assert_eq!(body, json!({ "error": "not available from another device", "path": "/policy/decide" }));
    assert_eq!(res.refusal, Some(Refusal::LocalOnly));
    assert_eq!(call(&r, Method::Post, "/ui/%2e%2e/policy/decide", peer(false)).await.0, 403);
    assert!(r.is_peer_open(Method::Get, "/ui/assets/app.js"));
    assert!(!r.is_peer_open(Method::Post, "/ui/../policy/decide"));
}

#[tokio::test]
async fn a_paired_computer_crosses_only_as_its_dashboard() {
    let r = sample();
    let (status, body, _) = call(&r, Method::Get, "/workers", peer(false)).await;
    assert_eq!(status, 403);
    assert_eq!(
        body,
        json!({ "error": "only the Eos window can do this on another computer", "code": "needs-human", "path": "/workers" })
    );
    assert_eq!(call(&r, Method::Get, "/workers", peer(true)).await.0, 200);
    assert_eq!(call(&r, Method::Post, "/fs/write", peer(true)).await.0, 200);
    assert_eq!(call(&r, Method::Get, "/api/host", peer(false)).await.0, 200);
    assert_eq!(call(&r, Method::Get, "/h/abc/x", peer(true)).await.0, 403);
}

#[tokio::test]
async fn the_ui_token_gate_answers_as_today() {
    let r = sample();
    let (status, body, res) = call(&r, Method::Post, "/fs/write", Caller::UNTRUSTED).await;
    assert_eq!((status, body), (403, json!({ "error": "ui token required" })));
    assert_eq!(res.refusal, Some(Refusal::UiToken));
    let view = Caller::Local(LocalCaller::HostView { host: "h".into() });
    assert_eq!(call(&r, Method::Post, "/fs/write", view).await.0, 403);
    assert_eq!(call(&r, Method::Post, "/fs/write", Caller::DASHBOARD).await.0, 200);
    // A route that only shows more to the user asks the request.
    assert_eq!(call(&r, Method::Get, "/api/plugins", Caller::UNTRUSTED).await.1["user"], json!(false));
    assert_eq!(call(&r, Method::Get, "/api/plugins", Caller::DASHBOARD).await.1["user"], json!(true));
}

#[tokio::test]
async fn the_phone_reaches_only_routes_with_a_tier() {
    let r = sample();
    assert_eq!(call(&r, Method::Get, "/workers", PHONE).await.0, 200);
    assert_eq!(call(&r, Method::Post, "/fs/write", PHONE).await.0, 200);
    let (status, _, res) = call(&r, Method::Post, "/workers/w1/events", PHONE).await;
    assert_eq!((status, res.refusal), (403, Some(Refusal::PhoneRefused)));
    let (status, _, res) = call(&r, Method::Get, "/api/host", PHONE).await;
    assert_eq!((status, res.refusal), (403, Some(Refusal::PhoneRefused)));
    let (status, body, _) = call(&r, Method::Put, "/api/settings", PHONE).await;
    assert_eq!((status, body), (403, json!({ "error": "ui token required" })));
}

#[tokio::test]
async fn a_switched_off_plugin_answers_plugin_off_before_the_token_gate() {
    let switch = Arc::new(Switch(AtomicBool::new(false)));
    let r = Router::builder()
        .plugins(switch.clone())
        .route(RouteDef::get("/api/pages", ok).access(Access::ui_token()).plugin("eos.pages"))
        .route(RouteDef::get("/health", ok).access(Access::open()))
        .build()
        .expect("valid");
    let (status, body, _) = call(&r, Method::Get, "/api/pages", Caller::UNTRUSTED).await;
    assert_eq!(
        (status, body),
        (404, json!({ "error": "Pages is turned off (Settings › Plugins)", "code": "plugin_off" }))
    );
    assert_eq!(call(&r, Method::Get, "/health", Caller::UNTRUSTED).await.0, 200);
    // A caller the route never crosses for is refused first, as the gateways do today.
    let local = Router::builder()
        .plugins(switch.clone())
        .route(RouteDef::get("/api/sync", ok).access(Access::open().local_only()).plugin("eos.sync"))
        .build()
        .expect("valid");
    assert_eq!(call(&local, Method::Get, "/api/sync", peer(true)).await.0, 403);

    switch.0.store(true, Ordering::Relaxed);
    assert_eq!(call(&r, Method::Get, "/api/pages", Caller::UNTRUSTED).await.0, 403);
    assert_eq!(call(&r, Method::Get, "/api/pages", Caller::DASHBOARD).await.0, 200);
}

#[tokio::test]
async fn refuses_bodies_over_the_routes_limit() {
    let r = Router::builder()
        .route(RouteDef::post("/small", ok).access(Access::open()).max_body(8))
        .route(RouteDef::post("/default", ok).access(Access::open()))
        .build()
        .expect("valid");
    let res = r.handle(Request::new(Method::Post, "/small", Caller::DASHBOARD).body("123456789")).await;
    assert_eq!(res.status, 413);
    let body: Value = serde_json::from_slice(&res.body.collect().await.expect("bytes")).expect("json");
    assert_eq!(body, json!({ "error": "request body too large (limit 8 bytes)", "limit": 8 }));
    assert_eq!(r.handle(Request::new(Method::Post, "/small", Caller::DASHBOARD).body("12345678")).await.status, 200);
    assert_eq!(r.body_limit(Method::Post, "/small"), 8);
    assert_eq!(r.body_limit(Method::Post, "/default"), 1024 * 1024);
    assert_eq!(r.stats().body_too_large, 1);
}

#[tokio::test]
async fn runs_the_validation_hook_before_the_handler() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Body {
        name: String,
    }
    let r = Router::builder()
        .route(RouteDef::post("/things", ok).access(Access::open()).validate(|req| req.json::<Body>().map(drop)))
        .build()
        .expect("valid");
    let bad = r.handle(Request::new(Method::Post, "/things", Caller::DASHBOARD).body("{}")).await;
    assert_eq!(bad.status, 400);
    let good = r.handle(Request::new(Method::Post, "/things", Caller::DASHBOARD).body(r#"{"name":"a"}"#)).await;
    assert_eq!(good.status, 200);
}

#[tokio::test]
async fn a_failing_or_panicking_handler_fails_only_its_request() {
    async fn fails(_req: Request) -> Result<Response, ApiError> {
        Err(ApiError::Conflict("stale revision".into()))
    }
    async fn panics_late(_req: Request) -> Result<Response, ApiError> {
        tokio::task::yield_now().await;
        panic!("boom at poll");
    }
    fn panics_early(_req: Request) -> std::future::Ready<Result<Response, ApiError>> {
        panic!("boom at call");
    }
    let r = Router::builder()
        .route(RouteDef::get("/fails", fails).access(Access::open()))
        .route(RouteDef::get("/late", panics_late).access(Access::open()))
        .route(RouteDef::get("/early", panics_early).access(Access::open()))
        .route(RouteDef::get("/fine", ok).access(Access::open()))
        .build()
        .expect("valid");
    assert_eq!(call(&r, Method::Get, "/fails", Caller::DASHBOARD).await.1, json!({ "error": "stale revision" }));
    let (status, body, _) = call(&r, Method::Get, "/late", Caller::DASHBOARD).await;
    assert_eq!((status, body), (500, json!({ "error": "boom at poll" })));
    let (status, body, _) = call(&r, Method::Get, "/early", Caller::DASHBOARD).await;
    assert_eq!((status, body), (500, json!({ "error": "boom at call" })));
    assert_eq!(call(&r, Method::Get, "/fine", Caller::DASHBOARD).await.0, 200);
    assert_eq!(r.stats().panics, 2);
    assert_eq!(r.stats().requests, 4);
}

#[tokio::test]
async fn echoes_the_callers_request_id_or_mints_one() {
    let r = sample();
    let res = r.handle(Request::new(Method::Get, "/workers", Caller::DASHBOARD).header("X-Request-Id", "abc")).await;
    assert_eq!(res.header_value("x-request-id"), Some("abc"));
    let res = r.handle(Request::new(Method::Get, "/missing", Caller::DASHBOARD)).await;
    let minted = res.header_value("x-request-id").expect("minted");
    assert!(minted.starts_with("r-") && minted.len() == 10, "{minted}");
}

#[tokio::test]
async fn revalidates_large_json_answers() {
    async fn rows(_req: Request) -> Result<Response, ApiError> {
        Ok(Response::json(200, &json!({ "rows": "x".repeat(2000) })))
    }
    let r = Router::builder().route(RouteDef::get("/rows", rows).access(Access::open())).build().expect("valid");
    let first = r.handle(Request::new(Method::Get, "/rows", Caller::DASHBOARD)).await;
    let etag = first.header_value("etag").expect("tagged").to_owned();
    let again = r.handle(Request::new(Method::Get, "/rows", Caller::DASHBOARD).header("if-none-match", &etag)).await;
    assert_eq!(again.status, 304);
    assert!(again.header_value("x-request-id").is_some());
}

#[tokio::test]
async fn a_route_without_an_access_rule_is_reported_and_refused() {
    let strict = Router::builder()
        .route(RouteDef::get("/declared", ok).access(Access::open()))
        .route(RouteDef::get("/forgot", ok))
        .build();
    match strict {
        Err(Error::UndeclaredAccess(routes)) => assert_eq!(routes, ["GET /forgot"]),
        other => panic!("expected the undeclared route to be reported, got {other:?}"),
    }
    let r = Router::builder()
        .tolerate_undeclared()
        .route(RouteDef::get("/declared", ok).access(Access::open()))
        .route(RouteDef::get("/forgot", ok))
        .build()
        .expect("tolerated");
    assert_eq!(r.undeclared(), ["GET /forgot"]);
    for caller in [Caller::DASHBOARD, Caller::UNTRUSTED, peer(true), PHONE] {
        let (status, _, res) = call(&r, Method::Get, "/forgot", caller).await;
        assert_eq!((status, res.refusal), (403, Some(Refusal::Undeclared)));
    }
    assert_eq!(call(&r, Method::Get, "/forgot", Caller::Internal).await.0, 200);
}

#[test]
fn every_declared_route_of_a_router_has_a_rule() {
    // The check `eos-app` repeats over the real route table.
    let r = sample();
    assert_eq!(r.undeclared(), Vec::<String>::new());
    assert!(r.routes().all(|m| m.access.is_some()));
    assert_eq!(r.routes().count(), 11);
}

#[test]
fn two_routes_of_one_shape_are_a_build_error() {
    let clash = Router::builder()
        .route(RouteDef::get("/workers/{id}", ok).access(Access::open()))
        .route(RouteDef::get("/workers/{name}", ok).access(Access::open()))
        .route(RouteDef::any("/h/{*rest}", ok).access(Access::open()))
        .route(RouteDef::post("/h/{*path}", ok).access(Access::open()))
        .build();
    match clash {
        Err(Error::Conflicts(list)) => {
            assert_eq!(list.len(), 2);
            assert_eq!(list[0].name, "GET /workers/{name}");
            assert_eq!(list[1].name, "POST /h/{*path}");
        }
        other => panic!("expected conflicts, got {other:?}"),
    }
    let bad = Router::builder().route(RouteDef::get("workers", ok).access(Access::open())).build();
    assert!(matches!(bad, Err(Error::BadRoute { .. })));
}

#[tokio::test]
async fn error_bodies_keep_todays_key_order() {
    let r = sample();
    let raw = |res: Response| async move {
        String::from_utf8(res.body.collect().await.expect("bytes").to_vec()).expect("utf-8")
    };
    let res = r.handle(Request::new(Method::Get, "/missing", Caller::DASHBOARD)).await;
    assert_eq!(raw(res).await, r#"{"error":"not found","path":"/missing"}"#);
    let res = r.handle(Request::new(Method::Get, "/workers", peer(false))).await;
    assert_eq!(
        raw(res).await,
        r#"{"error":"only the Eos window can do this on another computer","code":"needs-human","path":"/workers"}"#
    );
}
