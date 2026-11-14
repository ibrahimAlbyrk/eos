//! The snapshot over routes that stand in for the real parts: what each answers is
//! carried as written, what cannot be carried is left out, and only the user's
//! dashboard gets it.

use std::sync::Arc;

use eos_contracts::{BOOT_PARTS, BootSnapshot, boot_page_target};
use eos_mod_boot::{BootModule, PART_MAX_BYTES};
use eos_runtime::access::{Access, Caller, Tier};
use eos_runtime::http::{ApiError, Body, Method, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::{AllPluginsOn, RouteDef};
use eos_runtime::{Kernel, KernelOptions, Runtime};

/// Answers each part's route in a way the snapshot has to handle.
struct Parts;

impl Module for Parts {
    fn id(&self) -> &'static str {
        "parts"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let json = |body: &'static str| {
            move |_req: Request| async move { Ok::<_, ApiError>(Response::json_bytes(200, body.into())) }
        };
        let open = Access::open().phone(Tier::Read);
        vec![
            // Bytes kept as written, spacing included.
            RouteDef::get("/workers", json(r#"[ {"id":"w-1"} ]"#)).access(open),
            RouteDef::get("/api/ui-config", json(r#"{"features":{}}"#)).access(open),
            // A streamed answer is gathered.
            RouteDef::get("/api/settings", |_req: Request| async {
                let (tx, body) = Body::channel(4);
                tokio::spawn(async move {
                    for chunk in [&b"{\"settings\":"[..], b"{\"a\":1}", b"}"] {
                        let _ = tx.send(chunk).await;
                    }
                });
                Ok::<_, ApiError>(Response::new(200).header("content-type", "application/json").body(body))
            })
            .access(open),
            // Too large to carry.
            RouteDef::get("/api/settings/compaction", |_req: Request| async {
                let big = format!("[\"{}\"]", "x".repeat(PART_MAX_BYTES));
                Ok::<_, ApiError>(Response::json_bytes(200, big.into()))
            })
            .access(Access::open()),
            // An error is an answer too.
            RouteDef::get("/pending", |_req: Request| async { Err::<Response, _>(ApiError::NotFound("gone".into())) })
                .access(open),
            // Not JSON.
            RouteDef::get("/fs/recents", |_req: Request| async {
                Ok::<_, ApiError>(Response::bytes(200, "text/plain", "recents"))
            })
            .access(open),
            RouteDef::get("/projects", json(r#"{"projects":[]}"#)).access(Access::open()),
            RouteDef::get("/api/profile", json(r#"{"rev":3}"#)).access(Access::open()),
            RouteDef::get("/api/accounts", json(r#"{"providers":[]}"#)).access(Access::ui_token()),
            // The snapshot's caller is the part's caller.
            RouteDef::get("/api/plugins", |req: Request| async move {
                let body = format!(r#"{{"user":{}}}"#, req.speaks_for_user());
                Ok::<_, ApiError>(Response::json_bytes(200, body.into()))
            })
            .access(Access::open()),
            RouteDef::get("/workers/{id}/events", |req: Request| async move {
                let body = format!(
                    r#"[{{"worker":"{}","q":"{}"}}]"#,
                    req.param("id").unwrap_or(""),
                    req.query().get("limit").unwrap_or_default()
                );
                Ok::<_, ApiError>(Response::json_bytes(200, body.into()))
            })
            .access(open),
        ]
    }
}

fn runtime(attach: bool) -> Runtime {
    let kernel = Kernel::new(KernelOptions::default());
    let boot = Arc::new(BootModule::new(kernel.stream.clone()));
    let runtime =
        Runtime::build(kernel, vec![boot.clone(), Arc::new(Parts)], Arc::new(AllPluginsOn)).expect("composes");
    if attach {
        boot.attach_router(&runtime.router);
    }
    runtime
}

async fn boot(runtime: &Runtime, target: &str, caller: Caller) -> (u16, Vec<u8>) {
    let res = runtime.router.handle(Request::new(Method::Get, target, caller)).await;
    (res.status, res.body.collect().await.expect("a body").to_vec())
}

fn parts(snapshot: &BootSnapshot) -> Vec<(&str, u16, &str)> {
    snapshot.parts.iter().map(|(target, answer)| (target.as_str(), answer.status, answer.body.get())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn each_part_is_carried_as_its_route_wrote_it_and_the_rest_is_left_out() {
    let runtime = runtime(true);
    let (status, body) = boot(&runtime, "/api/boot?focus=w-5et13g7r", Caller::DASHBOARD).await;
    assert_eq!(status, 200);
    let snapshot: BootSnapshot = serde_json::from_slice(&body).expect("the snapshot shape");
    let page = boot_page_target("w-5et13g7r");
    assert_eq!(
        parts(&snapshot),
        [
            (BOOT_PARTS[0], 200, r#"[ {"id":"w-1"} ]"#),
            (BOOT_PARTS[1], 200, r#"{"features":{}}"#),
            (BOOT_PARTS[2], 200, r#"{"settings":{"a":1}}"#),
            (BOOT_PARTS[4], 404, r#"{"error":"gone"}"#),
            (BOOT_PARTS[6], 200, r#"{"projects":[]}"#),
            (BOOT_PARTS[7], 200, r#"{"rev":3}"#),
            (BOOT_PARTS[8], 200, r#"{"providers":[]}"#),
            (BOOT_PARTS[9], 200, r#"{"user":true}"#),
            (page.as_str(), 200, r#"[{"worker":"w-5et13g7r","q":"500"}]"#),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_focused_chat_is_named_by_a_plain_id_only() {
    let runtime = runtime(true);
    for target in ["/api/boot", "/api/boot?focus=", "/api/boot?focus=..%2Fapi%2Faccounts", "/api/boot?focus=w-1%3Fx"] {
        let (status, body) = boot(&runtime, target, Caller::DASHBOARD).await;
        let snapshot: BootSnapshot = serde_json::from_slice(&body).expect("the snapshot shape");
        assert_eq!((status, snapshot.parts.len()), (200, 8), "{target}: no page");
        assert!(snapshot.parts.keys().all(|k| BOOT_PARTS.contains(&k.as_str())), "{target}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_is_the_stream_position_before_the_parts_were_read() {
    let runtime = runtime(true);
    let bus = runtime.kernel.bus.clone();
    bus.publish_raw("test:tick", None, "{}".into());
    bus.publish_raw("test:tick", None, "{}".into());
    bus.flush().await;
    let (_, body) = boot(&runtime, "/api/boot", Caller::DASHBOARD).await;
    let snapshot: BootSnapshot = serde_json::from_slice(&body).expect("the snapshot shape");
    let hello: serde_json::Value = serde_json::from_str(snapshot.hello.get()).expect("json");
    assert_eq!(hello["seq"], 2);
    assert_eq!(snapshot.hello.get(), runtime.kernel.stream.hello());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_users_dashboard_gets_it() {
    let runtime = runtime(true);
    assert_eq!(boot(&runtime, "/api/boot", Caller::UNTRUSTED).await.0, 403);
    assert_eq!(boot(&runtime, "/api/boot", Caller::Phone { grant: Tier::High, mutate: true }).await.0, 403);
    let peer = Caller::Peer { device: "ab".into(), human: true };
    assert_eq!(boot(&runtime, "/api/boot", peer).await.0, 200, "a paired computer's dashboard");
}

#[tokio::test(flavor = "multi_thread")]
async fn before_the_router_is_handed_over_it_says_so() {
    let runtime = runtime(false);
    assert_eq!(boot(&runtime, "/api/boot", Caller::DASHBOARD).await.0, 503);
}
