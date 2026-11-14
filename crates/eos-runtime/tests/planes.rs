//! Today's three tables — the local-only plane, the phone's tiers and the
//! per-handler ui-token checks — are one `Access` per route here. This replays
//! what the TypeScript tests pin against a slice of the real table declared the
//! new way.

use eos_runtime::Error;
use eos_runtime::access::{Access, Caller, PeerRule, Refusal, Tier};
use eos_runtime::http::{ApiError, Method, Request, Response};
use eos_runtime::router::{RouteDef, Router};

async fn ok(_req: Request) -> Result<Response, ApiError> {
    Ok(Response::new(204))
}

fn route(method: &str, pattern: &str, access: Access) -> RouteDef {
    let def = match method {
        "GET" => RouteDef::get(pattern, ok),
        "POST" => RouteDef::post(pattern, ok),
        "PUT" => RouteDef::put(pattern, ok),
        "DELETE" => RouteDef::delete(pattern, ok),
        _ => RouteDef::any(pattern, ok),
    };
    def.access(access)
}

fn table() -> Router {
    let read = Access::open().phone(Tier::Read);
    let low = Access::open().phone(Tier::Low);
    let high = Access::open().phone(Tier::High);
    let user_read = Access::ui_token().phone_user(Tier::Read);
    let user_high = Access::ui_token().phone_user(Tier::High);
    let local = Access::open().local_only();
    Router::builder()
        .local_only_under("/api/peer")
        .local_only_under("/api/hosts")
        .local_only_under("/h")
        // reads
        .route(route("GET", "/workers", read))
        .route(route("GET", "/workers/archived", read))
        .route(route("GET", "/workers/{id}", read))
        .route(route("GET", "/workers/{id}/events", read))
        .route(route("GET", "/workers/{id}/changes/file", read))
        .route(route("GET", "/fs/read", read))
        .route(route("GET", "/fs/raw/{*path}", read))
        .route(route("GET", "/api/backends/{name}/models", read))
        .route(route("GET", "/workers/{id}/workflow-runs/{callId}/agents/{agentId}", read))
        // low
        .route(route("POST", "/workers/{id}/message", low))
        .route(route("POST", "/workers/{id}/archive", low))
        .route(route("POST", "/workers/{id}/restore", low))
        .route(route("POST", "/workers/{id}/workflow-runs/{callId}/stop", Access::ui_token().phone_user(Tier::Low)))
        // high
        .route(route("POST", "/workers", high))
        .route(route("DELETE", "/workers/{id}", high))
        .route(route("POST", "/pending/{id}/decision", high))
        .route(route("POST", "/workers/{id}/terminal", user_high))
        .route(route("POST", "/fs/write", user_high))
        .route(route("POST", "/fs/paste-b64", user_high))
        // Code-view terminals: the phone never resizes one.
        .route(route("GET", "/pty", user_read))
        .route(route("GET", "/pty/{id}/buffer", user_read))
        .route(route("GET", "/pty/{id}/conversation", user_read))
        .route(route("POST", "/pty", user_high))
        .route(route("POST", "/pty/{id}/input", user_high))
        .route(route("POST", "/pty/{id}/resize", Access::ui_token()))
        .route(route("DELETE", "/pty/{id}", user_high))
        // the local plane
        .route(route("POST", "/workers/{id}/events", local))
        .route(route("POST", "/policy/decide", local))
        .route(route("POST", "/workers/{id}/peer-request", local))
        .route(route("POST", "/workers/{id}/report", local))
        .route(route("GET", "/pick-file", local))
        .route(route("GET", "/api/hosts", Access::ui_token().local_only()))
        .route(route("POST", "/api/update/restart", Access::ui_token().local_only()))
        .route(route("GET", "/api/transfers", Access::ui_token().local_only()))
        .route(route("*", "/h/{hostId}/{*rest}", local))
        // crosses to a paired computer; not for the phone
        .route(route("GET", "/stream", Access::open()))
        .route(route("GET", "/metrics", Access::open()))
        .route(route("PUT", "/api/settings/archive", Access::ui_token()))
        .route(route("GET", "/transfer/list", Access::ui_token()))
        .route(route("PUT", "/api/genui/views/{id}/state", Access::ui_token()))
        // public by design
        .route(route("GET", "/api/host", Access::open().peer_open()))
        .route(route("GET", "/ui/{*file}", Access::open().peer_open()))
        .build()
        .expect("a valid table")
}

/// The phone's tier for a call, and whether the gateway vouches for the user
/// — what `classifyTier` answered. `None` is today's REFUSED.
fn classify(router: &Router, method: Method, target: &str) -> Option<(Tier, bool)> {
    router.access_of(method, target).and_then(|a| a.phone).map(|p| (p.tier, p.ui_token))
}

#[test]
fn classifies_reads_low_high_and_token_routes() {
    let r = table();
    assert_eq!(classify(&r, Method::Get, "/workers"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Get, "/workers/abc/events"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Post, "/workers/abc/message"), Some((Tier::Low, false)));
    assert_eq!(classify(&r, Method::Delete, "/workers/abc"), Some((Tier::High, false)));
    assert_eq!(classify(&r, Method::Post, "/pending/p1/decision"), Some((Tier::High, false)));
    assert_eq!(classify(&r, Method::Post, "/workers/abc/terminal"), Some((Tier::High, true)));
    assert_eq!(classify(&r, Method::Post, "/fs/write"), Some((Tier::High, true)));
    assert_eq!(classify(&r, Method::Post, "/workers/abc/archive"), Some((Tier::Low, false)));
    assert_eq!(classify(&r, Method::Get, "/workers/archived"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Post, "/fs/paste-b64"), Some((Tier::High, true)));
    assert_eq!(classify(&r, Method::Get, "/api/backends/deepseek/models"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Get, "/workers/w1/workflow-runs/c1/agents/a1"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Post, "/workers/w1/workflow-runs/c1/stop"), Some((Tier::Low, true)));
}

#[test]
fn refuses_the_worker_plane_raw_and_picker_surfaces_to_the_phone() {
    let r = table();
    for (method, target) in [
        (Method::Post, "/workers/abc/events"),
        (Method::Post, "/policy/decide"),
        (Method::Post, "/workers/abc/peer-request"),
        (Method::Post, "/workers/abc/report"),
        (Method::Get, "/stream"),
        (Method::Get, "/metrics"),
        (Method::Get, "/fs/raw"),
        (Method::Get, "/pick-file"),
        (Method::Get, "/api/transfers"),
        (Method::Post, "/pty/s1/resize"),
    ] {
        assert_eq!(classify(&r, method, target), None, "{method} {target}");
    }
}

#[test]
fn exposes_code_view_terminals_with_the_token() {
    let r = table();
    for target in ["/pty", "/pty/s1/buffer", "/pty/s1/conversation?afterId=3"] {
        assert_eq!(classify(&r, Method::Get, target), Some((Tier::Read, true)), "{target}");
    }
    for (method, target) in [(Method::Post, "/pty"), (Method::Post, "/pty/s1/input"), (Method::Delete, "/pty/s1")] {
        assert_eq!(classify(&r, method, target), Some((Tier::High, true)), "{method} {target}");
    }
}

#[test]
fn classifies_on_the_path_and_fails_closed_on_the_unknown() {
    let r = table();
    assert_eq!(classify(&r, Method::Get, "/fs/read?path=/a/b.txt"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Get, "/workers/abc/changes/file?p=x&y=1"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Get, "/fs/raw/Users/me/x.png"), Some((Tier::Read, false)));
    assert_eq!(classify(&r, Method::Get, "/nope/nope"), None);
    assert_eq!(classify(&r, Method::Post, "/workers"), Some((Tier::High, false)));
    assert_eq!(classify(&r, Method::Delete, "/workers"), None, "DELETE /workers is no route");
    assert_eq!(classify(&r, Method::Get, "/workers/abc/message"), None, "the method must match");
}

#[test]
fn keeps_the_local_plane_local_and_lets_the_rest_cross() {
    let r = table();
    let local_only = |method, target| r.access_of(method, target).map(|a| a.peer == PeerRule::LocalOnly);
    for (method, target) in [
        (Method::Post, "/workers/w1/events"),
        (Method::Get, "/api/hosts"),
        (Method::Post, "/api/update/restart"),
        (Method::Get, "/api/transfers"),
        (Method::Put, "/h/abc/api/settings"),
    ] {
        assert_eq!(local_only(method, target), Some(true), "{method} {target}");
    }
    for (method, target) in [
        (Method::Put, "/api/settings/archive"),
        (Method::Get, "/transfer/list?path=/Users"),
        (Method::Put, "/api/genui/views/v_7Hq2abcdEFGH/state"),
    ] {
        assert_eq!(local_only(method, target), Some(false), "{method} {target}");
    }
    assert!(r.is_peer_open(Method::Get, "/api/host"));
    assert!(r.is_peer_open(Method::Get, "/ui/index.html"));
    assert!(!r.is_peer_open(Method::Get, "/workers"));
}

#[tokio::test]
async fn the_router_enforces_what_the_tables_say() {
    let r = table();
    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    let agent_on_peer = Caller::Peer { device: "ab".repeat(32).into(), human: false };
    let refused = |res: Response| res.refusal;
    assert_eq!(
        refused(r.handle(Request::new(Method::Get, "/stream", phone.clone())).await),
        Some(Refusal::PhoneRefused)
    );
    assert_eq!(refused(r.handle(Request::new(Method::Get, "/workers", phone)).await), None);
    assert_eq!(
        refused(r.handle(Request::new(Method::Get, "/workers", agent_on_peer.clone())).await),
        Some(Refusal::NeedsHuman)
    );
    assert_eq!(refused(r.handle(Request::new(Method::Get, "/api/host", agent_on_peer.clone())).await), None);
    assert_eq!(
        refused(r.handle(Request::new(Method::Get, "/api/hosts", agent_on_peer)).await),
        Some(Refusal::LocalOnly)
    );
}

#[test]
fn a_route_added_to_a_local_only_area_must_say_so() {
    let forgot = Router::builder()
        .local_only_under("/api/peer")
        .route(route("POST", "/api/peer/invites", Access::ui_token()))
        .build();
    assert!(
        matches!(forgot, Err(Error::BadRoute { reason: "routes in this area must be local-only", .. })),
        "{forgot:?}"
    );
    let fine = Router::builder()
        .local_only_under("/api/peer")
        .route(route("POST", "/api/peer/invites", Access::ui_token().local_only()))
        .route(route("GET", "/api/peering-help", Access::open()))
        .build();
    assert!(fine.is_ok(), "a sibling that only shares the prefix's letters is not in the area");
}
