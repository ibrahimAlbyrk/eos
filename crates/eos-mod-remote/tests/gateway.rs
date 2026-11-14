//! The gateway against today's: `fixtures/relay/gateway.json` holds whole
//! sessions run through the TypeScript gateway, bridge, patcher and live text
//! (frozen from the TypeScript, see `fixtures/README.md`). The same steps here — the same
//! phones, bus events and route answers — must hand each phone the same
//! frames: the same JSON text, in the same order, packed for the same ones.

mod common;

use std::collections::HashMap;

use common::Harness;
use eos_core::net::relay::{RelayClientId, RoomEvent};
use eos_core::store::RemoteAuditEntry;
use eos_testkit::relay::inner_json;
use serde_json::{Value, json};

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/relay/gateway.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("JSON")
}

fn client(corpus: &Value, device: &str) -> RelayClientId {
    let hex = corpus["devices"][device].as_str().expect("a device");
    let bytes: Vec<u8> = (0..32).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect();
    bytes.try_into().expect("16 bytes")
}

async fn replay(corpus: &Value, scenario: &Value) {
    let name = scenario["name"].as_str().expect("a name");
    assert_eq!((corpus["now"].as_i64(), corpus["room"].as_str()), (Some(common::NOW), Some(common::ROOM)));
    assert_eq!(corpus["patchDebounceMs"], 5);
    let s = Harness::armed(&scenario["routes"]);
    let room = s.room();
    let bus = &s.runtime.kernel.bus;
    let devices: Vec<&str> = corpus["devices"].as_object().expect("devices").keys().map(String::as_str).collect();
    let mut expected: HashMap<&str, Vec<(String, bool)>> = HashMap::new();
    let mut epoch: Option<String> = None;

    for (index, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let at = format!(
            "{name}, step {index}: {}",
            serde_json::to_string(&json!({
                "join": step["join"], "leave": step["leave"], "publish": step["publish"], "frame": step["frame"],
            }))
            .expect("text")
        );
        if let Some(device) = step["join"].as_str() {
            room.push(RoomEvent::Joined(client(corpus, device)));
        } else if let Some(device) = step["leave"].as_str() {
            room.push(RoomEvent::Left(client(corpus, device)));
        } else if let Some(device) = step["phone"].as_str() {
            let payload = match step["raw"].as_str() {
                Some(raw) => raw.to_owned(),
                None => step["frame"].to_string(),
            };
            room.data(client(corpus, device), payload);
        } else if let Some(topic) = step["publish"].as_str() {
            let topic: &'static str = Box::leak(topic.to_owned().into_boxed_str());
            bus.publish_raw(topic, None, step["payload"].to_string().into());
        } else if let Some(key) = step["route"].as_str() {
            s.script.set(key, step["answer"].clone());
        }
        // What the step set in motion is under way before the next one starts.
        room.idle().await;
        bus.flush().await;

        for device in &devices {
            let fresh = step["frames"][device].as_array().cloned().unwrap_or_default();
            let wanted = expected.entry(device).or_default();
            wanted.extend(fresh.iter().map(|f| (f["json"].as_str().expect("json").to_owned(), f["deflated"] == true)));
            if fresh.is_empty() {
                continue;
            }
            let got = room.wait_sent(client(corpus, device), wanted.len()).await;
            for (n, (payload, (json, deflated))) in got.iter().zip(wanted.iter()).enumerate() {
                let (text, packed) = inner_json(payload);
                if epoch.is_none() {
                    epoch =
                        serde_json::from_str::<Value>(&text).ok().and_then(|f| Some(f["epoch"].as_str()?.to_owned()));
                }
                let json = json.replace("<epoch>", epoch.as_deref().unwrap_or("<epoch>"));
                assert_eq!(text, json, "{at}: frame {n} for {device}");
                assert_eq!(packed, *deflated, "{at}: frame {n} for {device} travels packed or plain as today");
            }
        }
    }

    // Nothing more than today's frames went out.
    room.idle().await;
    bus.flush().await;
    for device in &devices {
        let sent = room.sent(client(corpus, device)).len();
        assert_eq!(sent, expected.get(device).map_or(0, Vec::len), "{name}: frames for {device}");
    }
    if let Some(epoch) = &epoch {
        assert!(
            epoch.len() == 16 && epoch.bytes().all(|b| b.is_ascii_hexdigit()),
            "{name}: the epoch is 16 hex characters"
        );
    }

    let audit: Vec<RemoteAuditEntry> = s.store.audited();
    let audited: Vec<Value> = audit.iter().map(|entry| serde_json::to_value(entry).expect("an entry")).collect();
    assert_eq!(Value::Array(audited), scenario["audit"], "{name}: the audit log");

    // The same route reads, each with or without the user's authority. The
    // order of reads made at once is not promised. (The join snapshot's
    // ui-config read carried the token today; that route never looked at it.)
    let mut calls: Vec<(String, bool)> = s.script.calls.lock().expect("lock").clone();
    let mut wanted: Vec<(String, bool)> = scenario["calls"]
        .as_array()
        .expect("calls")
        .iter()
        .map(|c| (c["call"].as_str().expect("a call").to_owned(), c["user"] == true))
        .collect();
    for list in [&mut calls, &mut wanted] {
        for call in list.iter_mut().filter(|(call, _)| call == "GET /api/ui-config") {
            call.1 = false;
        }
        list.sort();
    }
    assert_eq!(calls, wanted, "{name}: the route reads");
}

async fn scenario(name: &str) {
    let corpus = corpus();
    let found = corpus["scenarios"].as_array().expect("scenarios").iter().find(|s| s["name"] == name);
    replay(&corpus, found.unwrap_or_else(|| panic!("no session named {name}"))).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn join_hello_and_controls() {
    scenario("join, hello and controls").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn events_focus_and_pushed_rows() {
    scenario("events, focus and pushed rows").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn row_patches() {
    scenario("row patches").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn two_phones() {
    scenario("two phones").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_input_keeps_its_order() {
    scenario("terminal input keeps its order").await;
}

#[test]
fn every_recorded_session_is_replayed() {
    assert_eq!(corpus()["scenarios"].as_array().expect("scenarios").len(), 5);
}
