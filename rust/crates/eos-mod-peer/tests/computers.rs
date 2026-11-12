//! Two whole computers on loopback — each the feature over the real link, on
//! the real router with the real event stream — driven only through their
//! routes, as their dashboards drive them.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_config::ConfigFile;
use eos_core::SystemClock;
use eos_core::net::peer::PeerHosting;
use eos_core::store::ConfigSource;
use eos_domain::config::Env;
use eos_domain::peer::ViewTokens;
use eos_mod_peer::{BusEvents, PeerModule, PeerParts, RouterApi, api_stamp};
use eos_peer::{Peering, PeeringOptions};
use eos_runtime::access::{Access, Caller, LocalCaller, Tier};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::http::{Body, Method, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::{AllPluginsOn, RouteDef, Router};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::TempHome;
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(20);
const TICK: Topic<Value> = Topic::new("test:tick");

/// The rest of an app, as far as these tests need it: a read, a write that
/// needs the user, a route of the local plane.
struct OtherFeatures;

impl Module for OtherFeatures {
    fn id(&self) -> &'static str {
        "other"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let echo = |req: Request| async move {
            let caller = format!("{:?}", req.caller);
            Ok(Response::json(
                200,
                &json!({
                    "path": req.path(),
                    "query": req.query().raw(),
                    "user": req.speaks_for_user(),
                    "peer": req.caller.peer_device(),
                    "caller": caller,
                    "range": req.headers.get("range"),
                    "body": String::from_utf8_lossy(&req.body),
                }),
            ))
        };
        vec![
            RouteDef::get("/workers", echo).access(Access::open().phone(Tier::Read)),
            RouteDef::post("/fs/write", echo).access(Access::ui_token()),
            RouteDef::post("/policy/decide", echo).access(Access::open().local_only()),
        ]
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![TICK.decl()]
    }
}

struct Computer {
    home: Arc<TempHome>,
    runtime: Arc<Runtime>,
    /// Held here: the peering holds the routers weakly.
    _raw: Arc<Router>,
    peering: Arc<Peering>,
    config: Arc<ConfigFile>,
    id: String,
}

impl Drop for Computer {
    fn drop(&mut self) {
        // No listener and no link outlives a test.
        self.peering.stop();
    }
}

struct Setup {
    name: &'static str,
    hosting: bool,
    dashboard: Option<PathBuf>,
}

async fn computer(setup: Setup) -> Computer {
    let home = Arc::new(TempHome::new());
    let env = Env::new([
        ("EOS_PEER_ENABLED".to_owned(), if setup.hosting { "1" } else { "0" }.to_owned()),
        // Any free port: two computers share this machine.
        ("EOS_PEER_PORT".to_owned(), "0".to_owned()),
    ]);
    let config = Arc::new(ConfigFile::load(home.path(), env, true));
    config.patch("peer", json!({ "name": setup.name }).as_object().expect("object").clone()).expect("written");

    let kernel = Kernel::new(KernelOptions::default());
    let read = config.clone();
    let mut options = PeeringOptions::new(
        home.join("peer"),
        Arc::new(SystemClock),
        Arc::new(move || read.current().peer.clone()),
        Arc::new(BusEvents::new(kernel.bus.clone())),
    );
    options.home = "/Users/test".into();
    options.api_stamp = api_stamp();
    options.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
    options.addresses = Some(Arc::new(|port| vec![format!("127.0.0.1:{port}")]));
    options.keep_awake = Arc::new(|| None);
    options.ping_interval = Duration::from_millis(200);
    let bundle = setup.dashboard.clone();
    options.serves_ui = Arc::new(move || bundle.is_some());
    let peering = Peering::open(options).expect("peering opens");

    let module = Arc::new(PeerModule::new(PeerParts {
        hosting: peering.clone(),
        links: peering.clone(),
        lifecycle: peering.clone(),
        config: config.clone(),
        view_tokens: Arc::new(ViewTokens::new("t".repeat(48))),
        ui_root: setup.dashboard,
    }));
    let raw = Router::builder()
        .routes(module.raw_routes())
        .route(
            RouteDef::get("/fs/raw/{*rest}", |req: Request| async move {
                Ok(Response::bytes(200, "text/plain", format!("raw:{}", req.path())))
            })
            .access(Access::open()),
        )
        .build()
        .expect("the raw router builds");
    let runtime = Arc::new(
        Runtime::build(kernel, vec![module, Arc::new(OtherFeatures)], Arc::new(AllPluginsOn)).expect("the app builds"),
    );
    let raw = Arc::new(raw);
    peering.serve(Arc::new(RouterApi::new(&runtime.router, &raw)));
    runtime.lifecycle.start().await.expect("starts");
    runtime.lifecycle.ready().await.expect("ready");
    let id = peering.fingerprint().to_owned();
    Computer { home, runtime, _raw: raw, peering, config, id }
}

impl Computer {
    async fn ask(&self, method: Method, target: &str, caller: Caller, body: Option<Value>) -> Response {
        let mut request = Request::new(method, target, caller);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        self.runtime.router.handle(request).await
    }

    /// A request by this computer's own dashboard, its answer as JSON.
    async fn json(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        json_of(self.ask(method, target, Caller::DASHBOARD, body).await).await
    }

    async fn invite(&self) -> String {
        let (status, body) = self.json(Method::Post, "/api/peer/invite", None).await;
        assert_eq!(status, 200, "{body}");
        body["link"].as_str().expect("a link").to_owned()
    }

    /// Waits until this computer's link to `host` satisfies `check`.
    async fn link_until(&self, host: &str, check: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let (_, body) = self.json(Method::Get, "/api/hosts", None).await;
            let found = body["hosts"].as_array().and_then(|hosts| hosts.iter().find(|h| h["id"] == host)).cloned();
            if let Some(view) = found.filter(|view| check(view)) {
                return view;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out; hosts: {body}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn live(&self, host: &str) -> Value {
        self.link_until(host, |view| view["link"]["state"] == "live").await
    }
}

async fn json_of(response: Response) -> (u16, Value) {
    let status = response.status;
    let bytes = response.body.collect().await.expect("a whole body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Pairs `device` with `host` through the routes and waits for the link.
async fn pair(device: &Computer, host: &Computer, extra: Value) -> Value {
    let mut body = json!({ "invite": host.invite().await });
    for (key, value) in extra.as_object().into_iter().flatten() {
        body[key] = value.clone();
    }
    let (status, view) = device.json(Method::Post, "/api/hosts", Some(body)).await;
    assert_eq!(status, 200, "{view}");
    device.live(&host.id).await;
    // The host lists the session once it has let it in.
    let deadline = tokio::time::Instant::now() + WAIT;
    while host.peering.status().devices.iter().all(|d| !(d.fp.0 == device.id && d.connected)) {
        assert!(tokio::time::Instant::now() < deadline, "the host never listed the device");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    view
}

fn named(name: &'static str) -> Setup {
    Setup { name, hosting: true, dashboard: None }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_settings_and_the_machines_menu_work_through_their_routes() {
    let office = computer(named("Office iMac")).await;
    let laptop = computer(named("MacBook")).await;

    // Who each app is: an open read.
    let (status, info) = json_of(office.ask(Method::Get, "/api/host", Caller::UNTRUSTED, None).await).await;
    assert_eq!(status, 200);
    assert_eq!(
        info,
        json!({ "id": office.id, "deviceId": info["deviceId"], "name": "Office iMac", "platform": info["platform"], "home": "/Users/test", "apiStamp": api_stamp(), "servesUi": false })
    );
    // The settings are the user's own.
    for (method, target) in
        [(Method::Get, "/api/peer"), (Method::Post, "/api/peer/invite"), (Method::Get, "/api/hosts")]
    {
        let (status, body) = json_of(office.ask(method, target, Caller::UNTRUSTED, None).await).await;
        assert_eq!((status, body), (403, json!({ "error": "ui token required" })), "{target}");
    }
    let (_, status) = office.json(Method::Get, "/api/peer", None).await;
    assert_eq!(status["enabled"], true);
    assert_eq!(status["listening"], true);
    assert_eq!(status["port"], 0);
    assert_eq!(status["addrs"].as_array().map(Vec::len), Some(1));
    assert_eq!(status["relay"], Value::Null);
    assert_eq!((status["openInvites"].as_i64(), status["devices"].as_array().map(Vec::len)), (Some(0), Some(0)));

    let view = pair(&laptop, &office, json!({ "alias": "Office" })).await;
    assert_eq!(
        (view["id"].as_str(), view["name"].as_str(), view["alias"].as_str()),
        (Some(office.id.as_str()), Some("Office iMac"), Some("Office"))
    );
    assert_eq!(view["mutual"], false);
    assert_eq!(view["hasRelay"], false);
    assert!(view.get("relay").is_none(), "secrets never leave through the list");
    let live = laptop.live(&office.id).await;
    assert_eq!(live["link"]["route"], "direct");
    let (_, status) = office.json(Method::Get, "/api/peer", None).await;
    assert_eq!(status["devices"][0]["name"], "MacBook");
    assert_eq!(status["devices"][0]["connected"], true);
    assert_eq!(status["openInvites"], 0);

    // A bad invite, an unknown computer, a malformed id.
    let (status, body) =
        laptop.json(Method::Post, "/api/hosts", Some(json!({ "invite": "eos://pair/not-a-real-invite-link" }))).await;
    assert_eq!((status, body), (400, json!({ "error": "invite link is damaged — copy it again" })));
    let unknown = "0".repeat(64);
    for (method, target) in [
        (Method::Put, format!("/api/hosts/{unknown}")),
        (Method::Delete, format!("/api/hosts/{unknown}")),
        (Method::Post, format!("/api/hosts/{unknown}/view-token")),
        (Method::Post, format!("/api/hosts/{unknown}/reconnect")),
    ] {
        let (status, body) = laptop.json(method, &target, Some(json!({}))).await;
        assert_eq!((status, body), (404, json!({ "error": "unknown computer" })), "{target}");
    }
    let (status, body) = laptop.json(Method::Post, "/api/hosts/not-an-id/reconnect", None).await;
    assert_eq!((status, body), (404, json!({ "error": "not found", "path": "/api/hosts/not-an-id/reconnect" })));

    // Rename, reconnect, a view token, disconnect, revoke, forget.
    let (status, renamed) =
        laptop.json(Method::Put, &format!("/api/hosts/{}", office.id), Some(json!({ "alias": " Desk " }))).await;
    assert_eq!((status, renamed["alias"].as_str()), (200, Some("Desk")));
    let (status, again) = laptop.json(Method::Post, &format!("/api/hosts/{}/reconnect", office.id), None).await;
    assert_eq!((status, again["id"].as_str()), (200, Some(office.id.as_str())));
    let (_, token) = laptop.json(Method::Post, &format!("/api/hosts/{}/view-token", office.id), None).await;
    assert_eq!(token["token"], eos_domain::peer::view_token(&"t".repeat(48), &office.id));
    let (_, dropped) = office.json(Method::Post, &format!("/api/peer/devices/{}/disconnect", laptop.id), None).await;
    assert_eq!(dropped, json!({ "disconnected": 1 }));
    laptop.live(&office.id).await;
    let (_, revoked) = office.json(Method::Delete, &format!("/api/peer/devices/{}", laptop.id), None).await;
    assert_eq!(revoked, json!({ "ok": true }));
    let (status, gone) = office.json(Method::Delete, &format!("/api/peer/devices/{}", laptop.id), None).await;
    assert_eq!((status, gone), (404, json!({ "error": "no such device" })));
    let refused = laptop.link_until(&office.id, |view| view["link"]["state"] == "unauthorized").await;
    assert_eq!(refused["link"]["error"], "not-paired");
    let (_, forgotten) = laptop.json(Method::Delete, &format!("/api/hosts/{}", office.id), None).await;
    assert_eq!(forgotten, json!({ "ok": true }));
    assert_eq!(laptop.json(Method::Get, "/api/hosts", None).await.1, json!({ "hosts": [] }));
}

#[tokio::test(flavor = "multi_thread")]
async fn hosting_is_switched_in_the_configuration_file_and_applied_at_once() {
    let office = computer(Setup { hosting: false, ..named("Office iMac") }).await;
    let (_, status) = office.json(Method::Get, "/api/peer", None).await;
    assert_eq!((status["enabled"].as_bool(), status["listening"].as_bool()), (Some(false), Some(false)));
    let (code, body) = office.json(Method::Post, "/api/peer/invite", None).await;
    assert_eq!((code, body), (409, json!({ "error": "turn on remote access first" })));
    let (code, body) = office.json(Method::Put, "/api/peer", Some(json!({ "port": "x" }))).await;
    assert_eq!(code, 400);
    assert_eq!(body["error"], "invalid request: port: Expected number, received string");
    let (code, _) = office.json(Method::Put, "/api/peer", Some(json!({ "nope": true }))).await;
    assert_eq!(code, 400, "an unknown key is refused");

    let (code, on) = office.json(Method::Put, "/api/peer", Some(json!({ "enabled": true }))).await;
    assert_eq!(code, 200);
    assert_eq!((on["enabled"].as_bool(), on["listening"].as_bool()), (Some(true), Some(true)));
    assert!(
        office.home.read("config.json").contains("\"enabled\":true")
            || office.home.read("config.json").contains("\"enabled\": true")
    );
    assert!(office.config.current().peer.enabled);
    office.invite().await;
    office.invite().await;
    let (_, cancelled) = office.json(Method::Delete, "/api/peer/invite", None).await;
    assert_eq!(cancelled, json!({ "cancelled": 2 }));

    let (_, direct_off) = office.json(Method::Put, "/api/peer", Some(json!({ "direct": false }))).await;
    assert_eq!((direct_off["enabled"].as_bool(), direct_off["listening"].as_bool()), (Some(true), Some(false)));
    assert_eq!(direct_off["addrs"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_facade_is_the_hosts_app_for_the_dashboard_and_its_public_face_for_everyone_else() {
    let office = computer(named("Office iMac")).await;
    let laptop = computer(named("MacBook")).await;
    pair(&laptop, &office, json!({})).await;
    let through = |path: &str| format!("/h/{}{path}", office.id);

    // The dashboard here drives the host: the host's routes see a paired computer whose user asks.
    let (status, seen) = laptop.json(Method::Get, &through("/workers?limit=3"), None).await;
    assert_eq!(status, 200, "{seen}");
    assert_eq!((seen["path"].as_str(), seen["query"].as_str()), (Some("/workers"), Some("limit=3")));
    assert_eq!(seen["peer"], laptop.id, "the gateway names the device from its certificate");
    assert_eq!(seen["user"], true, "the device vouched for its dashboard");
    let (status, written) = laptop.json(Method::Post, &through("/fs/write"), Some(json!({ "path": "/tmp/x" }))).await;
    assert_eq!((status, written["body"].as_str()), (200, Some("{\"path\":\"/tmp/x\"}")));

    // Any other page in this window reaches the host's public face only.
    let (status, body) = json_of(laptop.ask(Method::Get, &through("/workers"), Caller::UNTRUSTED, None).await).await;
    assert_eq!(
        (status, body),
        (403, json!({ "error": "only the Eos window can do this on another computer", "code": "needs-human" }))
    );
    let (status, info) = json_of(laptop.ask(Method::Get, &through("/api/host"), Caller::UNTRUSTED, None).await).await;
    assert_eq!(
        (status, info["id"].as_str(), info["name"].as_str()),
        (200, Some(office.id.as_str()), Some("Office iMac"))
    );

    // The local plane never crosses, the dashboard included; dot segments do not disguise a path.
    let (status, body) = laptop.json(Method::Post, &through("/policy/decide"), Some(json!({}))).await;
    assert_eq!(
        (status, body),
        (403, json!({ "error": "not available from another device", "path": "/policy/decide" }))
    );
    let (status, body) = laptop.json(Method::Get, &through("/api/peer"), None).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("not available from another device")));
    let (status, _) = laptop.json(Method::Get, &through(&format!("/h/{}/workers", laptop.id)), None).await;
    assert_eq!(status, 403, "a host is never a way to a third computer");
    let (status, body) =
        json_of(laptop.ask(Method::Post, &through("/ui/../policy/decide"), Caller::UNTRUSTED, Some(json!({}))).await)
            .await;
    assert_eq!((status, body["code"].as_str()), (403, Some("needs-human")), "judged on the resolved path");
    // Pairing and tunnels belong to the link itself.
    let (status, body) = laptop.json(Method::Post, &through("/peer/pair"), Some(json!({}))).await;
    assert_eq!((status, body), (404, json!({ "error": "not an API route" })));
    assert_eq!(laptop.json(Method::Post, &through("/peer/reverse"), None).await.0, 404);

    // A view that controls the host is its user under that host's prefix — and only there.
    let view = Caller::Local(LocalCaller::HostView { host: office.id.as_str().into() });
    assert_eq!(laptop.ask(Method::Get, &through("/workers"), view.clone(), None).await.status, 200);
    let other = Caller::Local(LocalCaller::HostView { host: "f".repeat(64).into() });
    assert_eq!(laptop.ask(Method::Get, &through("/workers"), other, None).await.status, 403);
    assert_eq!(
        laptop.ask(Method::Get, "/api/hosts", view, None).await.status,
        403,
        "never this computer's own settings"
    );

    // The raw-content origin crosses to the host's raw-content router.
    let (status, _) = laptop.json(Method::Get, &through("/fs/raw/Users/me/a.txt"), None).await;
    assert_eq!(status, 200);
    let raw = laptop.ask(Method::Get, &through("/fs/raw/Users/me/a.txt"), Caller::DASHBOARD, None).await;
    assert_eq!(raw.body.collect().await.expect("whole").as_ref(), b"raw:/fs/raw/Users/me/a.txt");

    // An unknown computer, and a HEAD, which never carries a body.
    let stranger = format!("/h/{}/workers", "0".repeat(64));
    let (status, body) = json_of(laptop.ask(Method::Get, &stranger, Caller::UNTRUSTED, None).await).await;
    assert_eq!((status, body), (404, json!({ "error": "unknown computer", "code": "unknown-host" })));
    let head = laptop.ask(Method::Head, &stranger, Caller::DASHBOARD, None).await;
    assert_eq!(head.status, 404);
    assert!(matches!(head.body, Body::Empty));
}

/// Reads frames from a stream body until `enough` says so; returns them.
async fn frames_until(body: &mut eos_runtime::http::BodyStream, text: &mut String, enough: impl Fn(&str) -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !enough(text) {
        let chunk = tokio::time::timeout_at(deadline, body.next()).await.expect("frames arrive in time");
        text.push_str(&String::from_utf8_lossy(&chunk.expect("the stream is open").expect("a whole chunk")));
    }
}

fn ticks(text: &str) -> Vec<i64> {
    text.split("\n\n")
        .filter(|frame| frame.contains("event: change") && frame.contains("\"test:tick\""))
        .filter_map(|frame| frame.lines().find_map(|line| line.strip_prefix("data: ")))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok()?["payload"]["n"].as_i64())
        .collect()
}

fn last_id(text: &str) -> String {
    text.lines().rev().find_map(|line| line.strip_prefix("id: ")).expect("an id").to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hosts_event_stream_crosses_the_facade_and_resumes_from_its_last_id() {
    let office = computer(named("Office iMac")).await;
    let laptop = computer(named("MacBook")).await;
    pair(&laptop, &office, json!({})).await;
    let tick = |n: i64| office.runtime.kernel.bus.publish(&TICK, &json!({ "n": n }));

    let opened =
        laptop.ask(Method::Get, &format!("/h/{}/stream?topics=test:tick", office.id), Caller::DASHBOARD, None).await;
    assert_eq!(opened.status, 200);
    assert_eq!(opened.header_value("content-type"), Some("text/event-stream"));
    assert_eq!(opened.header_value("content-encoding"), None, "the link's gzip is unpacked before the page sees it");
    let Body::Stream(mut stream) = opened.body else { panic!("a streamed body") };
    let mut text = String::new();
    frames_until(&mut stream, &mut text, |t| t.contains("event: hello")).await;
    assert!(text.starts_with("retry: 2000\n\n:connected\n\n"), "today's opening frames: {text:?}");
    tick(1);
    tick(2);
    frames_until(&mut stream, &mut text, |t| ticks(t) == [1, 2]).await;
    let resume_from = last_id(&text);

    // The link drops; events keep happening on the host meanwhile.
    let (_, dropped) = office.json(Method::Post, &format!("/api/peer/devices/{}/disconnect", laptop.id), None).await;
    assert_eq!(dropped, json!({ "disconnected": 1 }));
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await.expect("the stream ends when the link drops") {
            None | Some(Err(_)) => break,
            Some(Ok(_)) => {}
        }
    }
    tick(3);
    tick(4);

    // The dashboard reconnects from the last id it saw: nothing is missed, nothing comes twice.
    laptop.live(&office.id).await;
    let target = format!("/h/{}/stream?topics=test:tick&since={resume_from}", office.id);
    let again = laptop.ask(Method::Get, &target, Caller::DASHBOARD, None).await;
    let Body::Stream(mut stream) = again.body else { panic!("a streamed body") };
    let mut rest = String::new();
    frames_until(&mut stream, &mut rest, |t| ticks(t).len() >= 2).await;
    tick(5);
    frames_until(&mut stream, &mut rest, |t| ticks(t).len() >= 3).await;
    assert_eq!(ticks(&rest), [3, 4, 5]);
    assert!(!rest.contains("event: resync") && !rest.contains("event: hello"), "a replay, not a fresh start: {rest:?}");

    // A resume point the host no longer knows gets one resync.
    let stale =
        laptop.ask(Method::Get, &format!("/h/{}/stream?since=nope-7", office.id), Caller::DASHBOARD, None).await;
    let Body::Stream(mut stream) = stale.body else { panic!("a streamed body") };
    let mut resync = String::new();
    frames_until(&mut stream, &mut resync, |t| t.contains("event: resync")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hosts_notification_is_raised_on_the_controlling_computer_and_the_bus_says_who_is_connected() {
    let office = computer(named("Office iMac")).await;
    let laptop = computer(named("MacBook")).await;
    let mut raised = laptop.runtime.kernel.bus.subscribe("notification:fire", 8);
    let mut presence = office.runtime.kernel.bus.subscribe("peer:presence", 32);
    let mut changes = laptop.runtime.kernel.bus.subscribe("hosts:change", 64);
    pair(&laptop, &office, json!({ "alias": "Desk" })).await;

    // The link watches the host's stream from the moment it is live; give the watcher its stream.
    let deadline = tokio::time::Instant::now() + WAIT;
    let note = loop {
        office.runtime.kernel.bus.publish_raw(
            "notification:fire",
            None,
            json!({ "title": "Build finished", "body": "all green", "workerId": "w9" }).to_string().into(),
        );
        match tokio::time::timeout(Duration::from_millis(200), raised.recv()).await {
            Ok(Ok(event)) => break event.payload_as::<Value>().expect("json"),
            _ => assert!(tokio::time::Instant::now() < deadline, "the notification never crossed"),
        }
    };
    assert_eq!(
        note,
        json!({ "title": "Desk · Build finished", "body": "all green", "workerId": "w9", "host": { "id": office.id, "name": "Desk" } })
    );

    let connected = tokio::time::timeout(WAIT, async {
        loop {
            let event = presence.recv().await.expect("the bus is open").payload_as::<Value>().expect("json");
            if event["devices"].as_array().is_some_and(|d| !d.is_empty()) {
                break event;
            }
        }
    })
    .await
    .expect("presence is announced");
    assert_eq!(connected["devices"][0]["fp"], laptop.id);
    assert_eq!(connected["devices"][0]["name"], "MacBook");
    assert!(connected["devices"][0]["deviceId"].as_str().is_some_and(|id| id.len() == 19));
    let change = changes.recv().await.expect("the bus is open").payload_as::<Value>().expect("json");
    assert_eq!(change, json!({ "id": office.id }));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_controlling_computer_loads_the_hosts_own_dashboard() {
    let bundle = TempHome::new();
    bundle.write("index.html", "<!doctype html><title>Eos</title>");
    bundle.write("assets/app-1a2b.js", "console.log('eos')");
    let office = computer(Setup { dashboard: Some(bundle.path().to_owned()), ..named("Office iMac") }).await;
    let laptop = computer(named("MacBook")).await;
    pair(&laptop, &office, json!({})).await;
    assert_eq!(laptop.live(&office.id).await["id"], office.id);
    let (_, info) =
        json_of(laptop.ask(Method::Get, &format!("/h/{}/api/host", office.id), Caller::UNTRUSTED, None).await).await;
    assert_eq!(info["servesUi"], true);

    // The view that loads it has vouched for nothing yet: the bundle is public by design.
    let index = laptop.ask(Method::Get, &format!("/h/{}/ui/", office.id), Caller::UNTRUSTED, None).await;
    assert_eq!(
        (index.status, index.header_value("content-type"), index.header_value("cache-control")),
        (200, Some("text/html; charset=utf-8"), Some("no-cache"))
    );
    assert_eq!(index.body.collect().await.expect("whole").as_ref(), b"<!doctype html><title>Eos</title>");
    let asset =
        laptop.ask(Method::Get, &format!("/h/{}/ui/assets/app-1a2b.js", office.id), Caller::UNTRUSTED, None).await;
    assert_eq!(asset.header_value("cache-control"), Some("public, max-age=31536000, immutable"));
    assert_eq!(asset.body.collect().await.expect("whole").as_ref(), b"console.log('eos')");
    let (status, missing) =
        json_of(laptop.ask(Method::Get, &format!("/h/{}/ui/assets/nope.js", office.id), Caller::UNTRUSTED, None).await)
            .await;
    assert_eq!((status, missing), (404, json!({ "error": "not found", "path": "/ui/assets/nope.js" })));
    let (status, _) = json_of(office.ask(Method::Get, "/ui/%2e%2e/config.json", Caller::UNTRUSTED, None).await).await;
    assert_eq!(status, 404, "nothing outside the bundle");

    // A computer without a bundle serves none, in the router's own words.
    let (status, none) = json_of(laptop.ask(Method::Get, "/ui", Caller::UNTRUSTED, None).await).await;
    assert_eq!((status, none), (404, json!({ "error": "not found", "path": "/ui/index.html" })));
}

#[tokio::test(flavor = "multi_thread")]
async fn connecting_with_let_it_control_this_mac_too_turns_hosting_on_and_pairs_both_ways() {
    let office = computer(named("Office iMac")).await;
    let laptop = computer(Setup { hosting: false, ..named("MacBook") }).await;
    let view = pair(&laptop, &office, json!({ "mutual": true })).await;
    assert_eq!(view["mutual"], true);
    assert!(laptop.config.current().peer.enabled, "the person just asked for it");
    let (_, status) = laptop.json(Method::Get, "/api/peer", None).await;
    assert_eq!(status["devices"][0]["fp"], office.id);
    let back = office.live(&laptop.id).await;
    assert_eq!(back["name"], "MacBook");
    let (status, seen) = office.json(Method::Get, &format!("/h/{}/workers", laptop.id), None).await;
    assert_eq!((status, seen["peer"].as_str()), (200, Some(office.id.as_str())));
}
