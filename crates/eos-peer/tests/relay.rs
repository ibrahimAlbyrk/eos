//! The relay leg for real: the link rides the relay adapter (`eos-relay`)
//! through a relay server on loopback, between two computers.

#[path = "support/mac.rs"]
mod mac;

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
