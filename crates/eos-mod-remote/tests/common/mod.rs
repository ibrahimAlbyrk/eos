//! What the gateway's tests share: scripted routes behind a real router, the
//! module armed on a relay room held in memory.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use eos_mod_remote::{GatewayOptions, RemoteModule, RemoteParts};
use eos_runtime::access::{Access, Tier};
use eos_runtime::bus::BusOptions;
use eos_runtime::http::{Body, Request, Response};
use eos_runtime::router::{AllPluginsOn, RouteDef};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::relay::{FakeKeepAwake, FakeRelayPort, FakeRemoteStore, FakeRoom};
use eos_testkit::{FakeClock, FakeConfig, SeqIds};
use serde_json::{Value, json};

pub(crate) const NOW: i64 = 1_731_400_000_000;
pub(crate) const ROOM: &str = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4";
pub(crate) const RELAY_URL: &str = "wss://relay.example.test/";

/// The scripted routes: what each exact request answers, and what was asked.
pub(crate) struct Script {
    pub(crate) answers: Mutex<HashMap<String, Value>>,
    seen: Mutex<HashMap<String, usize>>,
    /// Every request: `METHOD target`, and whether it carried the user's authority.
    pub(crate) calls: Mutex<Vec<(String, bool)>>,
}

impl Script {
    pub(crate) fn set(&self, key: &str, answer: Value) {
        self.answers.lock().expect("lock").insert(key.to_owned(), answer);
    }

    /// How often `key` (`METHOD target`) was asked.
    pub(crate) fn asked(&self, key: &str) -> usize {
        self.calls.lock().expect("lock").iter().filter(|(call, _)| call == key).count()
    }

    async fn answer(&self, req: &Request) -> Response {
        let query = req.query().raw();
        let target = if query.is_empty() { req.path().to_owned() } else { format!("{}?{query}", req.path()) };
        let key = format!("{} {target}", req.method);
        self.calls.lock().expect("lock").push((key.clone(), req.speaks_for_user()));
        let Some(answer) = self.answers.lock().expect("lock").get(&key).cloned() else {
            return Response::json(404, &json!({ "error": "not found", "path": target }));
        };
        let count = {
            let mut seen = self.seen.lock().expect("lock");
            let count = seen.entry(key).or_insert(0);
            *count += 1;
            *count
        };
        if let (Some(ms), 1) = (answer["slowFirstMs"].as_u64(), count) {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        let status = answer["status"].as_u64().expect("a status") as u16;
        if let Some(encoded) = answer["base64"].as_str() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).expect("base64");
            return Response::bytes(status, answer["type"].as_str().expect("a type").to_owned(), bytes);
        }
        if let Some(text) = answer["text"].as_str() {
            let body = if text.is_empty() { Body::Empty } else { Body::from(bytes::Bytes::from(text.to_owned())) };
            let kind = answer["type"].as_str().expect("a type").to_owned();
            return Response::new(status).header("content-type", kind).body(body);
        }
        Response::json(status, &answer["body"])
    }
}
/// The routes the sessions call, each with today's phone rule.
pub(crate) fn routes(script: &Arc<Script>) -> Vec<RouteDef> {
    let read = Access::open().phone(Tier::Read);
    let low = Access::open().phone(Tier::Low);
    let high = Access::open().phone(Tier::High);
    let user_read = Access::ui_token().phone_user(Tier::Read);
    let user_high = Access::ui_token().phone_user(Tier::High);
    let table: Vec<(&str, &str, Access)> = vec![
        ("GET", "/workers", read),
        ("GET", "/workers/{id}", read),
        ("GET", "/workers/{id}/events", read),
        ("POST", "/workers/{id}/message", low),
        ("POST", "/workers/{id}/interrupt", low),
        ("PUT", "/workers/{id}/permission", high),
        ("GET", "/pending", read),
        ("GET", "/api/ui-config", read),
        ("GET", "/health", read),
        ("GET", "/fs/image", read),
        ("GET", "/fs/read", read),
        ("GET", "/pty", user_read),
        ("GET", "/pty/{id}/buffer", user_read),
        ("POST", "/pty", user_high),
        ("POST", "/pty/{id}/input", user_high),
        // Never for the phone: the worker plane (and the kernel's own event stream).
        ("POST", "/policy/decide", Access::open()),
    ];
    table
        .into_iter()
        .map(|(method, pattern, access)| {
            let script = script.clone();
            let handler = move |req: Request| {
                let script = script.clone();
                async move { Ok(script.answer(&req).await) }
            };
            let route = match method {
                "GET" => RouteDef::get(pattern, handler),
                "POST" => RouteDef::post(pattern, handler),
                "PUT" => RouteDef::put(pattern, handler),
                _ => RouteDef::delete(pattern, handler),
            };
            route.access(access)
        })
        .collect()
}

/// The module armed on a room held in memory, over the scripted routes.
pub(crate) struct Harness {
    pub(crate) runtime: Runtime,
    pub(crate) relay: Arc<FakeRelayPort>,
    pub(crate) store: Arc<FakeRemoteStore>,
    pub(crate) script: Arc<Script>,
    pub(crate) module: Arc<RemoteModule>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) awake: Arc<FakeKeepAwake>,
    pub(crate) config: Arc<FakeConfig>,
}

struct Feature(Vec<RouteDef>);

impl eos_runtime::module::Module for Feature {
    fn id(&self) -> &'static str {
        "scripted"
    }
    fn routes(&self) -> Vec<RouteDef> {
        self.0.clone()
    }
}

/// What every session's first reads need.
pub(crate) fn base_routes() -> Value {
    json!({
        "GET /workers": { "status": 200, "body": [{ "id": "w1", "state": "IDLE" }] },
        "GET /pending": { "status": 200, "body": [] },
        "GET /pty": { "status": 200, "body": { "sessions": [{ "sessionId": "pty1" }] } },
        "GET /api/ui-config": { "status": 200, "body": { "theme": "dark" } },
    })
}

pub(crate) fn enabled() -> Value {
    json!({ "remote": { "enabled": true, "relay": { "url": RELAY_URL } } })
}

impl Harness {
    /// Builds the app's routes and the module; nothing is armed yet.
    pub(crate) fn new(routes_json: &Value, config: Value, options: GatewayOptions, with_relay: bool) -> Self {
        let clock = Arc::new(FakeClock::at(NOW));
        let kernel = Kernel::new(KernelOptions {
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            // Today's test bus delivers every delta as published.
            bus: BusOptions { delta_window: None },
            ..KernelOptions::default()
        });
        let answers = routes_json.as_object().expect("routes").iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let script = Arc::new(Script { answers: Mutex::new(answers), seen: Mutex::default(), calls: Mutex::default() });
        let relay = Arc::new(FakeRelayPort::new());
        let store = Arc::new(FakeRemoteStore::new(ROOM));
        let awake = Arc::new(FakeKeepAwake::new());
        let config = Arc::new(FakeConfig::new(config));
        let module = Arc::new(RemoteModule::new(RemoteParts {
            config: config.clone(),
            store: store.clone(),
            relay: with_relay.then(|| relay.clone() as Arc<dyn eos_core::net::relay::Relay>),
            keep_awake: awake.clone(),
            kernel: kernel.clone(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            options,
        }));
        let modules: Vec<Arc<dyn eos_runtime::module::Module>> =
            vec![Arc::new(Feature(routes(&script))), module.clone()];
        let runtime = Runtime::build(kernel, modules, Arc::new(AllPluginsOn)).expect("a runtime");
        module.attach_router(&runtime.router);
        Self { runtime, relay, store, script, module, clock, awake, config }
    }

    /// Armed, with the quick patch debounce the recorded sessions use.
    pub(crate) fn armed(routes_json: &Value) -> Self {
        let options = GatewayOptions { patch_debounce: Duration::from_millis(5), ..GatewayOptions::default() };
        let harness = Self::new(routes_json, enabled(), options, true);
        assert!(harness.module.reconcile().armed);
        harness
    }

    pub(crate) fn room(&self) -> Arc<FakeRoom> {
        self.relay.room()
    }

    /// Everything a step set in motion on the room and the bus is under way.
    pub(crate) async fn settle(&self) {
        self.room().idle().await;
        self.runtime.kernel.bus.flush().await;
    }

    pub(crate) fn publish(&self, topic: &'static str, payload: Value) {
        self.runtime.kernel.bus.publish_raw(topic, None, payload.to_string().into());
    }
}
