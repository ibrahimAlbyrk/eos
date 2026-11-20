//! Arming, Settings › Remote, and what the recorded sessions cannot show: a
//! link that falls behind, phones that vanish, answers too large to carry.

mod common;

use std::time::Duration;

use common::{Harness, NOW, RELAY_URL, ROOM, base_routes, enabled};
use std::sync::Arc;

use eos_core::net::relay::{PhonePush, PushKind, PushOutcome, PushResult, RelayClientId, RoomEvent};
use eos_core::store::{ConfigSource, RemoteStore};
use eos_mod_remote::{GatewayOptions, RemoteModule, RemoteParts};
use eos_relay::RelayClient;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_store_files::remote::RemoteFiles;
use eos_testkit::fixtures::recorded_response;
use eos_testkit::relay::{FakeKeepAwake, FakeRelay, FakeRelayPort, PushVia, inner_json};
use eos_testkit::{FakeClock, FakeConfig, SeqIds};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const PHONE: RelayClientId = [0xa1; 16];

fn frames(h: &Harness, client: RelayClientId) -> Vec<Value> {
    h.room().sent(client).iter().map(|p| serde_json::from_str(&inner_json(p).0).expect("a frame")).collect()
}

fn kinds(h: &Harness, client: RelayClientId) -> Vec<String> {
    frames(h, client).iter().map(|f| f["t"].as_str().unwrap_or_default().to_owned()).collect()
}

async fn joined(h: &Harness, client: RelayClientId) {
    h.room().push(RoomEvent::Joined(client));
    h.room().wait_sent(client, 1).await;
}

fn send(h: &Harness, client: RelayClientId, frame: Value) {
    h.room().data(client, frame.to_string());
}

fn control(n: u32, method: &str, path: &str) -> Value {
    json!({ "t": "control", "correlationId": format!("00000000-0000-4000-8000-{n:012}"), "method": method, "path": path })
}

async fn call(h: &Harness, method: Method, path: &str, caller: Caller, body: &str) -> (u16, Value) {
    let res = h.runtime.router.handle(Request::new(method, path, caller).body(body.to_owned())).await;
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn arming_claims_the_room_with_the_bearers_hash_and_holds_the_computer_awake() {
    let h = Harness::new(&base_routes(), enabled(), GatewayOptions::default(), true);
    assert!(!h.module.is_armed(), "nothing dials before the module starts");
    h.module.start().await.expect("starts");
    assert!(h.module.is_armed());
    let claim = h.relay.claims().pop().expect("a claim");
    assert_eq!((claim.url.as_str(), claim.room.as_str()), (RELAY_URL, ROOM));
    let hash: String = Sha256::digest(h.store.bearer().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!((claim.allow)(), [hash], "the relay is given the hash, never the bearer");
    assert_eq!((h.awake.taken(), h.awake.held()), (1, 1));

    // Arming again tears down first: one room, one hold.
    assert!(h.module.reconcile().armed);
    assert_eq!((h.relay.claims().len(), h.relay.open_rooms()), (2, 1));
    assert_eq!((h.awake.taken(), h.awake.held()), (2, 1));

    h.module.stop().await;
    assert!(!h.module.is_armed());
    assert_eq!((h.relay.open_rooms(), h.awake.held()), (0, 0), "the room is given up and the computer may sleep");
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_armed_when_switched_off_without_a_url_or_without_a_relay() {
    let off = Harness::new(&base_routes(), json!({ "remote": { "enabled": false } }), GatewayOptions::default(), true);
    off.module.start().await.expect("starts");
    assert!(!off.module.is_armed());
    assert_eq!((off.relay.claims().len(), off.awake.taken()), (0, 0));

    // An app that was given no relay never dials, whatever the configuration says.
    let no_relay = Harness::new(&base_routes(), enabled(), GatewayOptions::default(), false);
    no_relay.module.start().await.expect("starts");
    assert!(!no_relay.module.is_armed());
    assert_eq!(no_relay.awake.taken(), 0);
    // Switched on and set: it says why, not that a setting is missing.
    let (_, status) = call(&no_relay, Method::Get, "/api/remote/status", Caller::DASHBOARD, "").await;
    assert_eq!(status, json!({ "enabled": true, "armed": false, "relayUrl": RELAY_URL, "off": "off-network" }));
    let (code, refused) = call(&no_relay, Method::Post, "/api/remote/pair", Caller::DASHBOARD, "").await;
    let why = json!({ "error": "The phone link runs only in the installed Eos on your own data folder" });
    assert_eq!((code, refused), (409, why));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_routes_answer_as_recorded() {
    let h = Harness::new(&base_routes(), json!({}), GatewayOptions::default(), true);
    h.module.start().await.expect("starts");
    let recorded = |step: &str| recorded_response("16-services", step);

    let (status, body) = call(&h, Method::Get, "/api/remote/status", Caller::DASHBOARD, "").await;
    assert_eq!(status, 200);
    assert_eq!(body, recorded("remote-status")["json"]);
    let (status, body) = call(&h, Method::Get, "/api/remote/status", Caller::UNTRUSTED, "").await;
    assert_eq!((status, &body), (403, &recorded("remote-status-without-token")["json"]));
    let (status, body) = call(&h, Method::Post, "/api/remote/pair", Caller::DASHBOARD, "").await;
    assert_eq!((status, &body), (409, &recorded("remote-pair-not-armed")["json"]));
    let (status, body) = call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, r#"{"enabled":"yes"}"#).await;
    assert_eq!((status, &body), (400, &recorded("remote-config-bad-body")["json"]));
    let (status, body) = call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, r#"{"enabled":false}"#).await;
    assert_eq!((status, &body), (200, &recorded("remote-config-save")["json"]));

    // A key Settings may not write is refused instead of landing in config.json.
    let (status, _) = call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, r#"{"rateLimit":{}}"#).await;
    assert_eq!(status, 400);
    let (status, _) =
        call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, r#"{"relay":{"url":"nope"}}"#).await;
    assert_eq!(status, 400);

    // The phone itself, and a paired computer, never reach these.
    let phone = Caller::Phone { grant: eos_runtime::access::Tier::High, mutate: true };
    assert_eq!(call(&h, Method::Post, "/api/remote/arm", phone, "").await.0, 403);
    let peer = Caller::Peer { device: "ab".repeat(32).into(), human: true };
    assert_eq!(call(&h, Method::Post, "/api/remote/pair", peer, "").await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_then_arming_goes_live_and_the_pairing_code_is_todays() {
    let h = Harness::new(&base_routes(), json!({}), GatewayOptions::default(), true);
    h.module.start().await.expect("starts");
    let save = json!({ "enabled": true, "relay": { "url": RELAY_URL } }).to_string();
    let (status, saved) = call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, &save).await;
    assert_eq!(
        (status, &saved["remote"]["enabled"], &saved["remote"]["relay"]["url"]),
        (200, &json!(true), &json!(RELAY_URL))
    );
    assert_eq!(h.config.file()["remote"], json!({ "enabled": true, "relay": { "url": RELAY_URL } }));
    assert!(!h.module.is_armed(), "saving alone arms nothing");

    let (_, armed) = call(&h, Method::Post, "/api/remote/arm", Caller::DASHBOARD, "").await;
    assert_eq!(armed, json!({ "enabled": true, "armed": true }));

    // The code as today's `generatePairing` writes it (fixtures/relay/frames.json).
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/relay/frames.json"))
            .expect("the corpus"),
    )
    .expect("JSON");
    let vector = &corpus["pairing"][0];
    assert_eq!((vector["args"]["now"].as_i64(), vector["args"]["relayUrl"].as_str()), (Some(NOW), Some(RELAY_URL)));
    let res = h.runtime.router.handle(Request::new(Method::Post, "/api/remote/pair", Caller::DASHBOARD)).await;
    let text = res.body.collect().await.expect("a body");
    assert_eq!(std::str::from_utf8(&text).expect("utf-8"), vector["json"].as_str().expect("json"));

    // Switching it off and arming again disarms.
    call(&h, Method::Put, "/api/remote/config", Caller::DASHBOARD, r#"{"enabled":false}"#).await;
    let (_, disarmed) = call(&h, Method::Post, "/api/remote/arm", Caller::DASHBOARD, "").await;
    assert_eq!(disarmed, json!({ "enabled": false, "armed": false }));
    assert_eq!((h.relay.open_rooms(), h.awake.held()), (0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_behind_gets_a_fresh_snapshot_and_the_rows_it_missed_once_there_is_room() {
    let mut routes = base_routes();
    routes["GET /workers/w1/events?afterId=5&limit=500"] = json!({ "status": 200, "body": [{ "id": 6 }, { "id": 7 }] });
    routes["GET /workers/w1/events?afterId=7&limit=500"] = json!({ "status": 200, "body": [] });
    routes["GET /workers/w1"] = json!({ "status": 200, "body": { "id": "w1" } });
    let h = Harness::armed(&routes);
    joined(&h, PHONE).await;
    send(&h, PHONE, json!({ "t": "hello", "caps": ["focus", "rows"] }));
    h.settle().await;
    assert_eq!(kinds(&h, PHONE), ["snapshot"]);

    // The queue towards the relay is full.
    h.room().set_behind(true);
    h.publish("fs:change", json!({ "dir": "/x" }));
    send(&h, PHONE, json!({ "t": "focus", "active": true, "worker": "w1", "afterId": 5 }));
    h.settle().await;
    h.publish(
        "agent:delta",
        json!({ "workerId": "w1", "blockId": "b1", "channel": "text", "phase": "start", "text": "hi" }),
    );
    h.publish("pty:session", json!({ "sessionId": "pty1" }));
    // A control is still answered: its reply waits for room instead of being dropped.
    send(&h, PHONE, control(1, "GET", "/workers/w1"));
    h.settle().await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(kinds(&h, PHONE), ["snapshot"], "nothing is queued while the link is behind");
    assert_eq!(h.script.asked("GET /workers/w1"), 1, "the control ran");

    h.room().set_behind(false);
    h.room().wait_sent(PHONE, 5).await;
    h.settle().await;
    let got = frames(&h, PHONE);
    let mut seen: Vec<&str> = got[1..].iter().map(|f| f["t"].as_str().expect("a kind")).collect();
    seen.sort_unstable();
    assert_eq!(seen, ["ka", "reply", "rows", "snapshot"], "{got:?}");
    let snapshot = got[1..].iter().find(|f| f["t"] == "snapshot").expect("a snapshot");
    assert_eq!(snapshot["ptys"], json!([{ "sessionId": "pty1" }]), "seeded as on join: the terminal list too");
    assert_eq!(snapshot["live"][0]["text"], "hi", "and the text streamed meanwhile");
    assert_eq!(snapshot["seq"], 3, "the cursor moved past the three events it missed");
    let rows = got.iter().find(|f| f["t"] == "rows").expect("rows");
    assert_eq!(rows["rows"], json!([{ "id": 6 }, { "id": 7 }]), "rows are not lost: they count as sent once queued");
    let position = |kind: &str| got.iter().rposition(|f| f["t"] == kind).expect("there");
    assert!(position("snapshot") < position("rows"), "the snapshot comes first");

    // Back in step: the next event arrives as usual.
    h.publish("pty:exit", json!({ "sessionId": "pty1" }));
    h.room().wait_sent(PHONE, 6).await;
    assert_eq!(frames(&h, PHONE)[5]["reason"], "pty:exit");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_of_rows_larger_than_one_message_travels_in_several_frames() {
    let big = "x".repeat(1_500_000);
    let page: Vec<Value> = (11..=15).map(|id| json!({ "id": id, "payload": big })).collect();
    let mut routes = base_routes();
    routes["GET /workers/w1/events?afterId=10&limit=500"] = json!({ "status": 200, "body": page });
    routes["GET /workers/w1/events?afterId=15&limit=500"] = json!({ "status": 200, "body": [] });
    let h = Harness::armed(&routes);
    joined(&h, PHONE).await;
    send(&h, PHONE, json!({ "t": "hello", "caps": ["focus", "rows"] }));
    send(&h, PHONE, json!({ "t": "focus", "active": true, "worker": "w1", "afterId": 10 }));
    let sent = h.room().wait_sent(PHONE, 4).await;
    assert!(sent.iter().all(|payload| payload.len() < 5 * 1024 * 1024), "every frame fits the relay's limit");
    let ids: Vec<i64> = frames(&h, PHONE)[1..]
        .iter()
        .flat_map(|f| f["rows"].as_array().expect("rows").iter().map(|row| row["id"].as_i64().expect("an id")))
        .collect();
    assert_eq!(ids, [11, 12, 13, 14, 15], "all of them, in order");

    // The next change reads on from the last row sent.
    h.publish("worker:change", json!({ "workerId": "w1" }));
    h.settle().await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(h.script.asked("GET /workers/w1/events?afterId=15&limit=500"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_too_large_to_carry_is_refused_with_its_reason() {
    let mut routes = base_routes();
    let image = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, vec![7u8; 4 * 1024 * 1024]);
    routes["GET /fs/image?path=/big.png"] = json!({ "status": 200, "base64": image, "type": "image/png" });
    routes["GET /fs/read?path=/big.txt"] = json!({ "status": 200, "body": { "content": "y".repeat(5 * 1024 * 1024) } });
    let h = Harness::armed(&routes);
    joined(&h, PHONE).await;
    send(&h, PHONE, control(1, "GET", "/fs/image?path=/big.png"));
    send(&h, PHONE, control(2, "GET", "/fs/read?path=/big.txt"));
    h.room().wait_sent(PHONE, 3).await;
    let mut errors: Vec<(String, String)> = frames(&h, PHONE)[1..]
        .iter()
        .map(|f| {
            assert_eq!((f["t"].as_str(), f["code"].as_str()), (Some("error"), Some("FRAME_TOO_LARGE")));
            (
                f["correlationId"].as_str().expect("an id")[35..].to_owned(),
                f["message"].as_str().expect("why").to_owned(),
            )
        })
        .collect();
    errors.sort();
    assert_eq!(
        errors,
        [
            ("1".to_owned(), "asset exceeds relay envelope limit".to_owned()),
            ("2".to_owned(), "reply exceeds relay envelope limit".to_owned()),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn phones_of_a_dead_connection_and_silent_phones_are_forgotten() {
    let options = GatewayOptions {
        idle_ttl: Duration::from_secs(90),
        sweep_interval: Duration::from_millis(20),
        ..GatewayOptions::default()
    };
    let h = Harness::new(&base_routes(), enabled(), options, true);
    assert!(h.module.reconcile().armed);
    let other: RelayClientId = [0xb2; 16];
    joined(&h, PHONE).await;
    joined(&h, other).await;
    assert_eq!(h.module.devices(), 2);

    // A frame from a device that never joined is nobody's.
    send(&h, [9; 16], control(1, "GET", "/workers"));
    h.settle().await;
    assert!(h.room().sent([9; 16]).is_empty());

    // 91 s without a word from one of them; the other sent its keepalive.
    h.clock.advance(60_000);
    send(&h, other, json!({ "t": "ka", "ts": 0 }));
    h.settle().await;
    h.clock.advance(31_000);
    for _ in 0..200 {
        if h.module.devices() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.module.devices(), 1, "the silent phone is pruned, the other kept");
    h.publish("fs:change", json!({ "dir": "/x" }));
    h.room().wait_sent(other, 2).await;
    assert_eq!(kinds(&h, PHONE), ["snapshot"], "nothing more goes to the pruned phone");

    // A fresh relay connection: every phone of the old one is gone.
    h.room().push(RoomEvent::Registered);
    h.settle().await;
    assert_eq!(h.module.devices(), 0);
}

// ---- pushes to the phone (07 §4.6, G38) ----------------------------------------

async fn push_test(h: &Harness) -> (u16, Value) {
    call(h, Method::Post, "/api/remote/push-test", Caller::DASHBOARD, "").await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_goes_on_the_room_s_connection_while_armed_and_over_http_otherwise() {
    let h = Harness::armed(&base_routes());
    assert_eq!(push_test(&h).await, (200, json!({ "sent": 1, "failed": 0 })));
    assert_eq!(h.room().phone_pushes(), [PhonePush { kind: PushKind::Test, count: 1 }]);
    assert!(h.relay.http_pushes().is_empty());

    // The room's connection is down: the relay is still reached over HTTP.
    h.room().set_online(false);
    let notify = h.module.phone_notify();
    let push = PhonePush { kind: PushKind::NeedsYou, count: 3 };
    assert_eq!(notify.push(push).await, Ok(PushOutcome::Sent { devices: 1, failed: 0 }));
    let (target, sent) = h.relay.http_pushes().pop().expect("an HTTP push");
    assert_eq!((target.url.as_str(), target.room.as_str(), target.owner.as_str()), (RELAY_URL, ROOM, h.store.owner()));
    assert_eq!(sent, push);

    // Switched off but set: no socket, no keep-awake, and no push at all.
    let off = Harness::new(
        &base_routes(),
        json!({ "remote": { "enabled": false, "relay": { "url": RELAY_URL } } }),
        GatewayOptions::default(),
        true,
    );
    off.module.start().await.expect("starts");
    assert_eq!(push_test(&off).await, (200, json!({ "sent": 0, "failed": 0, "reason": "link-off" })));
    assert_eq!((off.relay.http_pushes().len(), off.relay.claims().len(), off.awake.taken()), (0, 0, 0));
}

/// The module over the room's real files in `home/remote`, not armed.
fn on_files(home: &std::path::Path, config: Value, relay: &Arc<FakeRelayPort>) -> RemoteModule {
    let clock = Arc::new(FakeClock::at(NOW));
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    RemoteModule::new(RemoteParts {
        config: Arc::new(FakeConfig::new(config)),
        store: Arc::new(RemoteFiles::new(home.join("remote"))),
        relay: Some(relay.clone()),
        keep_awake: Arc::new(FakeKeepAwake::new()),
        kernel,
        clock,
        ids: Arc::new(SeqIds::new()),
        options: GatewayOptions::default(),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_switched_off_or_never_set_up_dials_nothing_and_writes_no_secrets() {
    let push = PhonePush { kind: PushKind::NeedsYou, count: 2 };
    let off = json!({ "remote": { "enabled": false, "relay": { "url": RELAY_URL } } });
    for config in [off, json!({ "remote": { "enabled": true } }), enabled()] {
        let home = tempfile::tempdir().expect("a folder");
        let relay = Arc::new(FakeRelayPort::new());
        let module = on_files(home.path(), config.clone(), &relay);
        assert_eq!(module.phone_notify().push(push).await, Ok(PushOutcome::LinkOff), "{config}");
        assert!(relay.http_pushes().is_empty(), "nothing reached the relay: {config}");
        assert!(!home.path().join("remote").exists(), "no secrets were made: {config}");
    }

    // On, and its room set up when it was armed: the push goes as before.
    let home = tempfile::tempdir().expect("a folder");
    let room = RemoteFiles::new(home.path().join("remote")).secrets().expect("minted");
    let relay = Arc::new(FakeRelayPort::new());
    let module = on_files(home.path(), enabled(), &relay);
    assert_eq!(module.phone_notify().push(push).await, Ok(PushOutcome::Sent { devices: 1, failed: 0 }));
    let (target, sent) = relay.http_pushes().pop().expect("an HTTP push");
    assert_eq!((target.room, target.owner, sent), (room.room, room.owner, push));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_push_test_answers_each_reason() {
    // Switched on, not armed: every push goes over HTTP.
    let h = Harness::new(&base_routes(), enabled(), GatewayOptions::default(), true);
    let answers = [
        (Ok(PushResult::default()), json!({ "sent": 0, "failed": 0, "reason": "no-devices" })),
        (
            Ok(PushResult { reason: Some("throttled".into()), ..PushResult::default() }),
            json!({ "sent": 0, "failed": 0, "reason": "throttled" }),
        ),
        (
            Ok(PushResult { failed: 2, reason: Some("not-configured".into()), ..PushResult::default() }),
            json!({ "sent": 0, "failed": 2, "reason": "not-configured" }),
        ),
        (Ok(PushResult { sent: 1, failed: 1, gone: 1, reason: None }), json!({ "sent": 1, "failed": 2 })),
        (Err(eos_core::Error::not_found("relay room", "x")), json!({ "sent": 0, "failed": 0, "reason": "link-off" })),
    ];
    for (answer, expected) in answers {
        h.relay.answer_http_pushes(answer);
        assert_eq!(push_test(&h).await, (200, expected));
    }
    h.relay.answer_http_pushes(Err(eos_core::Error::Unreachable("relay".into())));
    assert_eq!(push_test(&h).await.0, 502, "a relay that does not answer is an error: banners take over");

    // This app reaches no relay: no phone can be woken from it.
    let no_relay = Harness::new(&base_routes(), enabled(), GatewayOptions::default(), false);
    assert_eq!(push_test(&no_relay).await, (200, json!({ "sent": 0, "failed": 0, "reason": "link-off" })));
    assert!(no_relay.relay.http_pushes().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_reaches_the_test_relay_over_the_socket_while_armed_and_over_http_when_not() {
    let server = FakeRelay::start().await;
    server.set_push_tokens(2);
    let client = RelayClient::new(Arc::new(eos_core::SystemClock));
    let url = server.url();
    let h = Harness::on(
        &base_routes(),
        json!({ "remote": { "enabled": true, "relay": { "url": url } } }),
        GatewayOptions::default(),
        Arc::new(FakeRelayPort::new()),
        Some(Arc::new(client)),
    );
    h.module.start().await.expect("starts");
    for _ in 0..500 {
        if server.room_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(push_test(&h).await, (200, json!({ "sent": 2, "failed": 0 })));

    // The room let go, the link still on: the relay is reached over HTTP.
    h.module.stop().await;
    assert!(!h.module.is_armed());
    server.set_push_configured(false);
    assert_eq!(push_test(&h).await, (200, json!({ "sent": 0, "failed": 2, "reason": "not-configured" })));
    server.set_push_throttled(true);
    assert_eq!(push_test(&h).await, (200, json!({ "sent": 0, "failed": 0, "reason": "throttled" })));
    let via: Vec<PushVia> = server.pushes().iter().map(|p| p.via).collect();
    assert_eq!(via, [PushVia::Socket, PushVia::Http, PushVia::Http]);
    assert!(server.pushes().iter().all(|p| p.kind == "test" && p.count == 1));

    // Switched off: the relay hears nothing.
    let off = json!({ "enabled": false }).as_object().cloned().expect("an object");
    h.config.patch("remote", off).expect("saved");
    assert_eq!(push_test(&h).await, (200, json!({ "sent": 0, "failed": 0, "reason": "link-off" })));
    assert_eq!(server.pushes().len(), 3);
}
