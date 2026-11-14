//! Arming, Settings › Remote, and what the recorded sessions cannot show: a
//! link that falls behind, phones that vanish, answers too large to carry.

mod common;

use std::time::Duration;

use common::{Harness, NOW, RELAY_URL, ROOM, base_routes, enabled};
use eos_core::net::relay::{RelayClientId, RoomEvent};
use eos_mod_remote::GatewayOptions;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_testkit::fixtures::recorded_response;
use eos_testkit::relay::inner_json;
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
