//! The relay leg for real: the link rides the relay adapter (`eos-relay`)
//! through a relay server on loopback — between two Rust computers, and
//! between a Rust computer and a TypeScript-era one that dials the same
//! relay with today's code.

#[path = "support/mac.rs"]
mod mac;
mod support;

use std::sync::Arc;

use eos_contracts::{LinkRoute, LinkState};
use eos_core::SystemClock;
use eos_core::net::peer::{HostLinks, PeerHosting};
use eos_core::net::relay::Relay;
use eos_domain::peer::{decode_invite, encode_invite};
use eos_relay::RelayClient;
use eos_testkit::TempHome;
use eos_testkit::relay::FakeRelay;
use mac::{Mac, MacOptions, wait_for};
use serde_json::{Value, json};
use support::Node;

fn through(relay: &FakeRelay, name: &'static str, direct: bool) -> MacOptions {
    let client: Arc<dyn Relay> = Arc::new(RelayClient::new(Arc::new(SystemClock)));
    MacOptions { relay: Some(client), relay_url: Some(relay.url()), direct, ..MacOptions::named(name) }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_rust_computers_pair_and_talk_through_a_relay_server() {
    let relay = FakeRelay::start().await;
    // Neither listens: the relay is the only way.
    let host = Mac::on(Arc::new(TempHome::new()), through(&relay, "Office", false)).await;
    let device = Mac::on(Arc::new(TempHome::new()), through(&relay, "Laptop", false)).await;
    wait_for(|| host.peering.status().relay.filter(|r| r.online)).await;
    let invite = decode_invite(&host.invite()).expect("a link");
    assert!(invite.addrs.is_empty());
    assert_eq!(invite.relay.as_ref().map(|r| r.url.clone()), Some(relay.url()));

    let (view, _) = device.peering.pair(&encode_invite(&invite), None, false).await.expect("pairs through the relay");
    assert!(view.has_relay);
    let live = device.link_is(&host.id(), LinkState::Live).await;
    assert_eq!(live.link.route, Some(LinkRoute::Relay));
    assert_eq!(device.get(&host.id(), "/workers?via=relay", true).await.0, 200);
    assert_eq!(device.get(&host.id(), "/big", true).await.2.len(), 3 * 1024 * 1024);
    assert_eq!(host.app.saw("/workers?via=relay").expect("reached").device, device.id());

    // Revoked: the relay no longer admits the device's bearer, and the link says so.
    assert!(host.peering.revoke(&device.id()));
    let refused = device.link_is(&host.id(), LinkState::Unauthorized).await;
    assert_eq!(refused.link.error.as_deref(), Some("not-paired"));
    drop((host, device));
    relay.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_device_reaches_a_typescript_host_through_the_relay() {
    let Some(mut node) = Node::start().await else { return };
    let relay = FakeRelay::start().await;
    let home = TempHome::new();
    let started = node
        .call(
            "mac.start",
            json!({ "name": "Old iMac", "dir": home.join("peer"), "direct": false, "relayUrl": relay.url() }),
        )
        .await;
    let host_id = started["fingerprint"].as_str().expect("an id").to_owned();
    // The old host's room is up once its connector registered.
    let deadline = tokio::time::Instant::now() + mac::WAIT;
    loop {
        let status = node.call("mac.status", json!({ "name": "Old iMac" })).await["status"].clone();
        if status["relay"]["online"] == true {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the old host never registered its room");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let device = Mac::on(Arc::new(TempHome::new()), through(&relay, "New MacBook", false)).await;
    let invite =
        node.call("mac.invite", json!({ "name": "Old iMac" })).await["link"].as_str().expect("a link").to_owned();
    assert!(decode_invite(&invite).expect("a link").addrs.is_empty(), "the relay is the only way in");

    let (view, _) = device.peering.pair(&invite, None, false).await.expect("pairs through the relay");
    assert!(view.has_relay, "the old host granted this computer its own bearer");
    let live = device.link_is(&host_id, LinkState::Live).await;
    assert_eq!(live.link.route, Some(LinkRoute::Relay));
    let (status, _, body) = device.get(&host_id, "/workers?via=relay", true).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).expect("json")["path"], "/workers?via=relay");
    assert_eq!(device.get(&host_id, "/big", true).await.2.len(), 3 * 1024 * 1024);
    drop(device);
    node.call("mac.stop", json!({ "name": "Old iMac" })).await;
    relay.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_device_reaches_a_rust_host_through_the_relay() {
    let Some(mut node) = Node::start().await else { return };
    let relay = FakeRelay::start().await;
    let host = Mac::on(Arc::new(TempHome::new()), through(&relay, "Office iMac", false)).await;
    wait_for(|| host.peering.status().relay.filter(|r| r.online)).await;
    let home = TempHome::new();
    node.call("mac.start", json!({ "name": "Old MacBook", "dir": home.join("peer") })).await;

    let paired = node.call("mac.pair", json!({ "name": "Old MacBook", "invite": host.invite() })).await;
    assert_eq!(paired["view"]["hasRelay"], true);
    let deadline = tokio::time::Instant::now() + mac::WAIT;
    let link = loop {
        let view = node.call("mac.host", json!({ "name": "Old MacBook", "id": host.id() })).await["host"].clone();
        if view["link"]["state"] == "live" {
            break view["link"].clone();
        }
        assert!(tokio::time::Instant::now() < deadline, "the old device's link never came up: {view}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(link["route"], "relay");
    let answer = node
        .call(
            "mac.fetch",
            json!({ "name": "Old MacBook", "path": format!("/h/{}/workers?via=relay", host.id()), "human": true }),
        )
        .await["response"]
        .clone();
    assert_eq!(answer["status"], 200);
    assert!(host.app.saw("/workers?via=relay").is_some_and(|seen| seen.human));
    let big = node
        .call("mac.fetch", json!({ "name": "Old MacBook", "path": format!("/h/{}/big", host.id()), "human": true }))
        .await["response"]
        .clone();
    assert_eq!(big["bytes"], 3 * 1024 * 1024);
    node.call("mac.stop", json!({ "name": "Old MacBook" })).await;
    drop(host);
    relay.stop().await;
}
