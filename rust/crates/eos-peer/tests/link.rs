//! Two computers on loopback, both Rust: pairing, requests through the link,
//! streams, the reverse tunnel, refusals. What `manager/peer/__tests__`
//! pins (peer-link, invites, peer-mutual, peer-relay, dial-failure).

#[path = "support/mac.rs"]
mod mac;

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{LinkRoute, LinkState};
use eos_core::net::machines::{Machines, PeerCallError, PeerRequest};
use eos_core::net::peer::{HostLinks, LinkError, LinkRequest, PeerHosting};
use eos_domain::peer::{decode_invite, encode_invite};
use eos_testkit::{InMemoryRelay, TempHome};
use mac::{Mac, MacOptions, eventually, wait_for};
use serde_json::json;

async fn paired() -> (Mac, Mac) {
    let host = Mac::new("Office iMac").await;
    let device = Mac::new("Test MacBook").await;
    let (view, mutual) = device.peering.pair(&host.invite(), Some("Office"), false).await.expect("pairs");
    assert_eq!(view.id.0, host.id());
    assert!(!mutual);
    device.link_is(&host.id(), LinkState::Live).await;
    // Live on the device as soon as the channel is up; the host lists the
    // session once it has let it in.
    eventually(|| host.peering.status().devices[0].connected).await;
    (host, device)
}

#[tokio::test(flavor = "multi_thread")]
async fn pairs_through_a_single_use_invite_and_brings_the_link_up() {
    let host = Mac::new("Office iMac").await;
    let device = Mac::new("Test MacBook").await;
    let invite = host.peering.create_invite().expect("hosting is on");
    assert_eq!(decode_invite(&invite.link).expect("a link").exp, None, "carries no expiry");
    assert_eq!(host.peering.status().open_invites, 1);

    let (view, _) = device.peering.pair(&invite.link, Some("Office"), false).await.expect("pairs");
    assert_eq!(view.alias.as_deref(), Some("Office"));
    assert_eq!(view.name, "Office iMac");
    assert_eq!(view.device_id, invite.device_id);
    let live = device.link_is(&host.id(), LinkState::Live).await;
    assert_eq!(live.link.route, Some(LinkRoute::Direct));
    assert_eq!(host.peering.status().devices[0].name, "Test MacBook");
    assert_eq!(host.peering.status().open_invites, 0);

    let again = device.peering.pair(&invite.link, None, false).await.expect_err("the invite works once");
    assert_eq!(again.status, 403);
    assert!(again.message.contains("already used or cancelled"), "{}", again.message);

    // The link learns who the host is, shows its latency and tells the app.
    let known = wait_for(|| device.host_view(&host.id()).filter(|v| v.info.is_some() && v.link.rtt_ms.is_some())).await;
    assert_eq!(known.info.expect("info").api_stamp, "test-stamp");
    assert!(device.events.host_changes().contains(&host.id()));
    eventually(|| host.events.connected().iter().any(|d| d.fp == device.id())).await;
    assert!(host.peering.status().devices[0].connected);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invite_outlives_a_restart_and_cancelling_stops_every_open_one() {
    let first = Mac::on(Arc::new(TempHome::new()), MacOptions::named("Office")).await;
    let link = first.invite();
    let stored = first.home.read("peer/invites.json");
    assert!(!stored.contains(&decode_invite(&link).expect("a link").sec), "only hashes are kept");
    let home = first.home.clone();
    drop(first);

    let host = Mac::on(home, MacOptions::named("Office")).await;
    assert_eq!(host.peering.status().open_invites, 1, "the open invite was kept on disk");
    // The address inside the old link went with the old listener.
    let mut invite = decode_invite(&link).expect("a link");
    invite.addrs = host.peering.status().addrs;
    let relinked = encode_invite(&invite);
    let laptop = Mac::new("Laptop").await;
    laptop.peering.pair(&relinked, None, false).await.expect("yesterday's invite still pairs");
    assert_eq!(host.peering.status().open_invites, 0);

    let mut fresh = decode_invite(&host.invite()).expect("a link");
    fresh.addrs = host.peering.status().addrs;
    assert_eq!(host.peering.cancel_invites(), 1);
    let late = Mac::new("Late").await;
    assert!(late.peering.pair(&encode_invite(&fresh), None, false).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn five_wrong_secrets_burn_the_open_invites() {
    let host = Mac::new("Office").await;
    let real = decode_invite(&host.invite()).expect("a link");
    let intruder = Mac::new("Intruder").await;
    let mut forged = real.clone();
    forged.sec = "x".repeat(24);
    for _ in 0..5 {
        let refused = intruder.peering.pair(&encode_invite(&forged), None, false).await.expect_err("wrong secret");
        assert_eq!(refused.status, 403);
    }
    assert_eq!(host.peering.status().open_invites, 0, "burned");
    let honest = Mac::new("Honest").await;
    let refused = honest.peering.pair(&encode_invite(&real), None, false).await.expect_err("the real one is gone too");
    assert_eq!(refused.status, 403);
    assert!(refused.message.contains("already used or cancelled"), "{}", refused.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_says_why_it_failed() {
    let device = Mac::new("Laptop").await;
    let bad = device.peering.pair("eos://pair/not-a-real-invite-link", None, false).await.expect_err("damaged");
    assert_eq!((bad.status, bad.message.as_str()), (400, "invite link is damaged — copy it again"));
    let own = device.peering.pair(&device.invite(), None, false).await.expect_err("its own");
    assert_eq!((own.status, own.message.as_str()), (400, "that invite is from this Mac"));

    // A port nothing listens on: the connect is refused.
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).expect("a free port").port();
    let host = Mac::new("Office").await;
    let mut invite = decode_invite(&host.invite()).expect("a link");
    invite.addrs = vec![format!("127.0.0.1:{port}")];
    let unreachable = device.peering.pair(&encode_invite(&invite), None, false).await.expect_err("nothing there");
    assert_eq!(unreachable.status, 502);
    assert!(
        unreachable.message.starts_with("couldn't reach that Mac: nothing answered at its address"),
        "{}",
        unreachable.message
    );

    // Another computer answers at the invite's address: not the one that made it.
    let other = Mac::new("Other").await;
    invite.addrs = other.peering.status().addrs;
    let impostor = device.peering.pair(&encode_invite(&invite), None, false).await.expect_err("wrong identity");
    assert_eq!(impostor.status, 403);
    assert_eq!(impostor.message, "the Mac at that address is not the one that made the invite");

    invite.addrs = vec![];
    let no_way = device.peering.pair(&encode_invite(&invite), None, false).await.expect_err("no route named");
    assert_eq!(no_way.status, 502);
    assert!(no_way.message.starts_with("that Mac offers no way in"), "{}", no_way.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dashboards_requests_cross_and_nobody_elses_do() {
    let (host, device) = paired().await;
    let (status, _, body) = device.get(&host.id(), "/workers?limit=3", true).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).expect("json"),
        json!({ "path": "/workers?limit=3", "method": "GET", "body": "" })
    );
    let seen = host.app.saw("/workers?limit=3").expect("reached the host");
    assert!(seen.human);
    assert_eq!(seen.device, device.id(), "the gateway names the device from its certificate");

    let (status, _, body) = device.request(&host.id(), "POST", "/pty", r#"{"cols":80}"#, true).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).expect("json")["body"], r#"{"cols":80}"#);

    // Anything on the device that is not its dashboard gets the host's public face only.
    let (status, _, body) = device.get(&host.id(), "/fs/read?path=/etc/hosts", false).await;
    assert_eq!(status, 403);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).expect("json")["code"], "needs-human");
    assert!(host.app.saw("/fs/read?path=/etc/hosts").is_none());
    assert_eq!(device.get(&host.id(), "/api/host", false).await.0, 200);

    // The local plane never crosses, whoever asks; dot segments do not disguise a path.
    assert_eq!(device.request(&host.id(), "POST", "/policy/decide", "{}", true).await.0, 403);
    assert_eq!(device.get(&host.id(), "/ui/../fs/open", false).await.0, 403);
    assert_eq!(device.request(&host.id(), "POST", "/ui/../policy/decide", "{}", true).await.0, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_headers_are_the_gateways_never_the_devices() {
    let (host, device) = paired().await;
    let request = LinkRequest {
        method: "GET".into(),
        target: "/spoof".into(),
        headers: vec![
            ("x-eos-peer-device".into(), "spoofed".into()),
            ("x-eos-ui-token".into(), "stolen".into()),
            ("x-eos-agent-id".into(), "w-1".into()),
            ("x-eos-peer-human".into(), "1".into()),
            ("range".into(), "bytes=0-9".into()),
        ],
        body: bytes::Bytes::new(),
        human: false,
    };
    // The device sets the mark itself here, as an older or a modified device could:
    // the mark is what the host goes by, so the request passes — as that device's.
    let answer = device.peering.forward(&host.id(), request).await.expect("carried");
    assert_eq!(answer.status, 200);
    let seen = host.app.saw("/spoof").expect("reached");
    assert_eq!(seen.device, device.id());
    let names: Vec<&str> = seen.headers.iter().map(|(n, _)| n.as_str()).collect();
    for dropped in ["x-eos-peer-device", "x-eos-ui-token", "x-eos-agent-id", "x-eos-peer-human"] {
        assert!(!names.contains(&dropped), "{dropped} never reaches a route");
    }
    assert!(seen.headers.contains(&("range".into(), "bytes=0-9".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn bodies_cross_whole_and_a_too_large_one_is_cut_at_the_routes_limit() {
    let (host, device) = paired().await;
    let (status, headers, body) = device.get(&host.id(), "/big", true).await;
    assert_eq!(status, 200);
    assert_eq!(body.len(), 3 * 1024 * 1024);
    assert!(headers.contains(&("content-type".into(), "application/octet-stream".into())));

    let (status, _, _) = device.request(&host.id(), "POST", "/small/upload", &"x".repeat(200_000), true).await;
    assert_eq!(status, 413);
    let seen = host.app.saw("/small/upload").expect("reached");
    assert_eq!(seen.body.len(), 9, "one byte past the limit, never the whole body");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_event_stream_crosses_as_it_is_written_gzipped_on_the_wire() {
    let (host, device) = paired().await;
    let request = LinkRequest {
        method: "GET".into(),
        target: "/stream?since=e-0&gated=1".into(),
        headers: vec![("last-event-id".into(), "e-0".into())],
        body: bytes::Bytes::new(),
        human: true,
    };
    let mut answer = device.peering.forward(&host.id(), request).await.expect("carried");
    assert_eq!(answer.status, 200);
    let header = |name: &str| answer.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    assert_eq!(header("content-type").as_deref(), Some("text/event-stream"));
    assert_eq!(header("content-encoding"), None, "unpacked before it reaches the caller here");
    // The host writes its second event only after the first was read here:
    // a frame crosses when it is written, not when the stream ends.
    let first = answer.body.next().await.expect("a frame").expect("whole");
    let mut text = String::from_utf8_lossy(&first).into_owned();
    assert_eq!(text, "id: e-1\nevent: change\ndata: {\"n\":1}\n\n");
    host.app.gate.notify_one();
    while let Some(chunk) = answer.body.next().await {
        text.push_str(&String::from_utf8_lossy(&chunk.expect("whole")));
    }
    assert_eq!(text.matches("event: change").count(), 3);
    assert_eq!(
        host.app
            .saw("/stream?since=e-0&gated=1")
            .expect("reached")
            .headers
            .iter()
            .filter(|(n, _)| n == "last-event-id")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dashboard_bundle_crosses_gzipped_and_arrives_whole() {
    let (host, device) = paired().await;
    // Public by design: no dashboard has vouched for anything yet.
    let (status, headers, body) = device.get(&host.id(), "/ui/assets/app.js", false).await;
    assert_eq!(status, 200);
    assert_eq!(body, "console.log('eos');\n".repeat(20_000));
    assert!(headers.contains(&("content-type".into(), "text/javascript; charset=utf-8".into())));
    assert!(headers.contains(&("vary".into(), "accept-encoding".into())), "it was packed on the wire: {headers:?}");
    assert!(!headers.iter().any(|(name, _)| name == "content-encoding"), "and unpacked before the page");
    // Anything else crosses as it is.
    let (_, headers, _) = device.get(&host.id(), "/workers", true).await;
    assert!(!headers.iter().any(|(name, _)| name == "vary"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_the_caller_drops_is_released_on_the_host() {
    let (host, device) = paired().await;
    host.app.notify.lock().expect("lock").push(json!({ "title": "one" }));
    let request = LinkRequest {
        method: "GET".into(),
        target: "/stream?topics=notification:fire&mine=1".into(),
        headers: vec![],
        body: bytes::Bytes::new(),
        human: true,
    };
    let mut answer = device.peering.forward(&host.id(), request).await.expect("carried");
    answer.body.next().await.expect("a frame").expect("whole");
    // The link's own watcher holds one stream; this caller holds the second.
    eventually(|| *host.app.streaming.lock().expect("lock") == 2).await;
    drop(answer);
    eventually(|| *host.app.streaming.lock().expect("lock") == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hosts_notifications_are_raised_here_tagged_with_the_host() {
    let host = Mac::new("Office iMac").await;
    // One the host itself relayed from another computer must not bounce on.
    host.app.notify.lock().expect("lock").extend([
        json!({ "title": "Build finished", "workerId": "w9" }),
        json!({ "title": "Relayed", "host": { "id": "x", "name": "Elsewhere" } }),
    ]);
    let device = Mac::new("Test MacBook").await;
    device.peering.pair(&host.invite(), Some("Office"), false).await.expect("pairs");
    let notes = wait_for(|| Some(device.events.notifications()).filter(|n| !n.is_empty())).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(device.events.notifications().len(), 1, "never a notification the host itself relayed");
    assert_eq!(
        notes[0],
        json!({ "title": "Office · Build finished", "workerId": "w9", "host": { "id": host.id(), "name": "Office" } })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_link_reconnects_by_itself_after_it_drops() {
    let (host, device) = paired().await;
    let before = device.host_view(&host.id()).expect("known").link.since;
    assert_eq!(host.peering.disconnect(&device.id()), 1);
    eventually(|| {
        device.host_view(&host.id()).is_some_and(|v| v.link.state == LinkState::Live && v.link.since != before)
            && host.peering.status().devices[0].connected
    })
    .await;
    assert_eq!(device.get(&host.id(), "/after-drop", true).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_device_is_told_so_and_stops_retrying() {
    let (host, device) = paired().await;
    assert!(host.peering.revoke(&device.id()));
    assert!(!host.peering.revoke(&device.id()));
    let refused = device.link_is(&host.id(), LinkState::Unauthorized).await;
    assert_eq!(refused.link.error.as_deref(), Some("not-paired"));
    let request = LinkRequest {
        method: "GET".into(),
        target: "/workers".into(),
        headers: vec![],
        body: bytes::Bytes::new(),
        human: true,
    };
    let failed = device.peering.forward(&host.id(), request).await.expect_err("no link");
    assert_eq!(failed, LinkError::Unavailable { code: "not-paired".into() });
    assert!(host.events.connected().is_empty());

    // Pairing again (a new invite) brings it back; Reconnect alone does not.
    assert!(device.peering.reconnect(&host.id()));
    device.link_is(&host.id(), LinkState::Unauthorized).await;
    device.peering.pair(&host.invite(), None, false).await.expect("pairs again");
    let live = device.link_is(&host.id(), LinkState::Live).await;
    assert_eq!(live.alias.as_deref(), Some("Office"), "what the person set before is kept");
}

#[tokio::test(flavor = "multi_thread")]
async fn hosting_switched_off_is_said_in_the_refusal_and_comes_back_when_switched_on() {
    let (host, device) = paired().await;
    // Switched off, and a connection that arrives before the listener is gone
    // (as one through a tunnel or the relay would): it is told why.
    host.config.lock().expect("lock").enabled = false;
    assert_eq!(host.peering.disconnect(&device.id()), 1);
    let waiting =
        wait_for(|| device.host_view(&host.id()).filter(|v| v.link.error.as_deref() == Some("remote-access-off")))
            .await;
    assert_eq!(waiting.link.state, LinkState::Reconnecting, "it checks back now and then instead of giving up");
    assert!(host.peering.create_invite().is_err());

    // Applying the switch closes the listener and every session.
    host.peering.reconcile().await;
    assert!(!host.peering.status().listening);
    assert!(host.peering.status().addrs.is_empty());

    host.set_config(|c| c.enabled = true).await;
    // The listener came back on another port: tell the device, as the person would.
    let patch = eos_contracts::UpdateHostRequest { alias: None, addrs: Some(host.peering.status().addrs) };
    device.peering.update(&host.id(), &patch).expect("known");
    assert!(device.peering.reconnect(&host.id()));
    device.link_is(&host.id(), LinkState::Live).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn forgetting_a_host_drops_its_link_and_an_unknown_one_is_not_a_host() {
    let (host, device) = paired().await;
    assert!(device.peering.forget(&host.id()));
    assert!(!device.peering.forget(&host.id()));
    assert!(device.host_view(&host.id()).is_none());
    let request = LinkRequest {
        method: "GET".into(),
        target: "/workers".into(),
        headers: vec![],
        body: bytes::Bytes::new(),
        human: true,
    };
    assert_eq!(device.peering.forward(&host.id(), request).await.expect_err("gone"), LinkError::UnknownHost);
    assert!(!device.peering.reconnect(&host.id()));
    eventually(|| host.events.connected().is_empty()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_with_no_route_says_so_and_a_waiting_request_fails_with_its_code() {
    let device = Mac::new("Laptop").await;
    let host = Mac::new("Office").await;
    device.peering.pair(&host.invite(), None, false).await.expect("pairs");
    device.link_is(&host.id(), LinkState::Live).await;
    // The host goes away for good.
    host.peering.stop();
    let down =
        wait_for(|| device.host_view(&host.id()).filter(|v| v.link.error.as_deref() == Some("unreachable"))).await;
    assert_eq!(down.link.state, LinkState::Reconnecting);
    assert_eq!(down.link.route, None);
    assert!(down.link.attempt >= 1);

    let call = PeerRequest {
        method: "GET",
        target: "/transfer/list".into(),
        content_type: None,
        body: bytes::Bytes::new(),
        ready_ms: 300,
        timeout_ms: 1000,
    };
    assert_eq!(device.peering.call(&host.id(), call.clone()).await, Err(PeerCallError::NotReady));
    assert_eq!(device.peering.call(&"0".repeat(64), call).await, Err(PeerCallError::NotPaired));
}

/// The same data folder, opened by a run that keeps off the network (a copy,
/// a build from source): a transfer to a paired computer is told so, not that
/// the computer is out of reach.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_keeps_off_the_network_says_so_to_a_call() {
    let host = Mac::new("Office").await;
    let device = Mac::new("Laptop").await;
    device.peering.pair(&host.invite(), None, false).await.expect("pairs");
    let home = device.home.clone();
    drop(device);
    let away = Mac::on(home, MacOptions { network: false, ..MacOptions::named("Laptop") }).await;

    let link = away.host_view(&host.id()).expect("still paired").link;
    assert_eq!((link.state, link.error.as_deref()), (LinkState::Offline, Some("off-network")));
    let call = PeerRequest {
        method: "GET",
        target: "/transfer/list".into(),
        content_type: None,
        body: bytes::Bytes::new(),
        ready_ms: 300,
        timeout_ms: 1000,
    };
    assert_eq!(away.peering.call(&host.id(), call).await, Err(PeerCallError::OffNetwork));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_transfer_engine_reaches_a_paired_computer_as_the_user() {
    let (host, device) = paired().await;
    assert_eq!(device.peering.local_name(), "Test MacBook");
    assert_eq!(Machines::list(device.peering.as_ref()).len(), 1);
    let call = PeerRequest {
        method: "POST",
        target: "/transfer/scan".into(),
        content_type: Some("application/json"),
        body: bytes::Bytes::from_static(br#"{"paths":["/tmp/x"]}"#),
        ready_ms: 5_000,
        timeout_ms: 5_000,
    };
    let answer = device.peering.call(&host.id(), call).await.expect("answered");
    assert_eq!(answer.status, 200);
    let seen = host.app.saw("/transfer/scan").expect("reached");
    assert!(seen.human, "the engine acts for the user of this computer");
    assert_eq!(seen.body.as_ref(), br#"{"paths":["/tmp/x"]}"#);
    assert!(seen.headers.contains(&("content-type".into(), "application/json".into())));
}

// ---- both ways (peer-mutual.test.ts) ------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn one_pairing_can_let_each_computer_control_the_other() {
    let office = Mac::new("Office").await;
    let laptop = Mac::new("Laptop").await;
    let (view, mutual) = laptop.peering.pair(&office.invite(), None, true).await.expect("pairs");
    assert!(mutual, "the host took the offer");
    assert_eq!(view.id.0, office.id());

    // The office now controls the laptop too, without an invite of its own.
    let back = office.link_is(&laptop.id(), LinkState::Live).await;
    assert_eq!(back.name, "Laptop");
    assert_eq!(laptop.peering.status().devices.iter().map(|d| d.fp.0.clone()).collect::<Vec<_>>(), [office.id()]);
    assert_eq!(office.get(&laptop.id(), "/workers", true).await.0, 200);
    assert_eq!(laptop.get(&office.id(), "/workers", true).await.0, 200);
    assert_eq!(laptop.app.saw("/workers").expect("reached the laptop").device, office.id());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_cannot_dial_back_is_given_a_tunnel_through_the_live_link() {
    let office = Mac::new("Office").await;
    // The laptop lets the office in, but offers no address the office could dial.
    let laptop = Mac::on(Arc::new(TempHome::new()), MacOptions { direct: false, ..MacOptions::named("Laptop") }).await;
    assert!(laptop.peering.status().addrs.is_empty());
    laptop.peering.pair(&office.invite(), None, true).await.expect("pairs");

    let back = office.link_is(&laptop.id(), LinkState::Live).await;
    assert_eq!(back.link.route, Some(LinkRoute::Reverse), "through the tunnel the laptop offered");
    let (status, _, body) = office.get(&laptop.id(), "/workers?via=tunnel", true).await;
    assert_eq!(status, 200);
    assert!(body.contains("/workers?via=tunnel"));
    assert_eq!(office.get(&laptop.id(), "/big", true).await.2.len(), 3 * 1024 * 1024);
    // The tunnel is inside the laptop's own link; the laptop's link is direct.
    assert_eq!(laptop.host_view(&office.id()).expect("known").link.route, Some(LinkRoute::Direct));

    // The office's link drops with the laptop's; a new tunnel brings it back.
    let before = office.host_view(&laptop.id()).expect("known").link.since;
    assert_eq!(office.peering.disconnect(&laptop.id()), 1);
    eventually(|| {
        office.host_view(&laptop.id()).is_some_and(|v| v.link.state == LinkState::Live && v.link.since != before)
            && laptop.host_view(&office.id()).is_some_and(|v| v.link.state == LinkState::Live)
    })
    .await;
    assert_eq!(office.get(&laptop.id(), "/after", true).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tunnel_is_refused_from_a_computer_this_one_does_not_control() {
    // The device pairs one way only: the host does not control it, so the
    // host has no use for a tunnel from it and the device offers none.
    let (host, device) = paired().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(host.host_view(&device.id()).is_none());
    assert!(host.app.saw("/peer/reverse").is_none(), "pairing and tunnels never reach the app's routes");
}

// ---- through the relay (peer-relay.test.ts) -----------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn pairing_and_the_link_work_through_the_relay_alone_then_move_to_a_direct_path() {
    let relay = InMemoryRelay::new();
    let options = |name| MacOptions { relay: Some(relay.clone() as _), ..MacOptions::named(name) };
    // The host listens directly too, but the invite the device gets names only the relay.
    let host = Mac::on(Arc::new(TempHome::new()), options("Office")).await;
    let device = Mac::on(Arc::new(TempHome::new()), options("Laptop")).await;
    let status = host.peering.status();
    assert_eq!(status.relay.map(|r| (r.url, r.online)), Some(("wss://relay.invalid/ws".into(), true)));
    let mut invite = decode_invite(&host.invite()).expect("a link");
    let room = invite.relay.clone().expect("the invite names the relay room");
    assert_eq!(room.room.len(), 43);
    assert!(relay.owner_of(&room.room).is_some());
    let direct = std::mem::take(&mut invite.addrs);

    let (view, _) = device.peering.pair(&encode_invite(&invite), None, false).await.expect("pairs through the relay");
    assert!(view.has_relay, "the host granted this device its own bearer");
    let live = device.link_is(&host.id(), LinkState::Live).await;
    assert_eq!(live.link.route, Some(LinkRoute::Relay));
    assert_eq!(device.get(&host.id(), "/workers", true).await.0, 200);
    assert_eq!(device.get(&host.id(), "/big", true).await.2.len(), 3 * 1024 * 1024);
    let stored = device.home.read("peer/hosts.json");
    assert!(stored.contains("\"bearer\""), "the device keeps its bearer");
    let bearer = device.peering_host(&host.id()).relay.expect("granted").bearer;
    let devices = host.home.read("peer/devices.json");
    assert!(
        devices.contains("\"relayBearerHash\"") && !devices.contains(&bearer),
        "the host keeps only the bearer's hash"
    );

    // The host has direct addresses after all: once the device learns them, the link moves there.
    let patch = eos_contracts::UpdateHostRequest { alias: None, addrs: Some(direct) };
    device.peering.update(&host.id(), &patch).expect("known");
    let moved = wait_for(|| device.host_view(&host.id()).filter(|v| v.link.route == Some(LinkRoute::Direct))).await;
    assert_eq!(moved.link.state, LinkState::Live);
    assert_eq!(device.get(&host.id(), "/after-move", true).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_closes_the_relay_to_that_device_alone() {
    let relay = InMemoryRelay::new();
    let options = |name| MacOptions { relay: Some(relay.clone() as _), direct: false, ..MacOptions::named(name) };
    let host = Mac::on(Arc::new(TempHome::new()), options("Office")).await;
    let (one, two) = (
        Mac::on(Arc::new(TempHome::new()), options("One")).await,
        Mac::on(Arc::new(TempHome::new()), options("Two")).await,
    );
    one.peering.pair(&host.invite(), None, false).await.expect("pairs");
    two.peering.pair(&host.invite(), None, false).await.expect("pairs");
    one.link_is(&host.id(), LinkState::Live).await;
    two.link_is(&host.id(), LinkState::Live).await;

    assert!(host.peering.revoke(&one.id()));
    let refused = one.link_is(&host.id(), LinkState::Unauthorized).await;
    assert_eq!(refused.link.error.as_deref(), Some("not-paired"));
    assert_eq!(two.get(&host.id(), "/workers", true).await.0, 200, "the other device is untouched");

    // Even a fresh dial is turned away at the relay: the bearer is off the list.
    assert!(one.peering.reconnect(&host.id()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(one.link_is(&host.id(), LinkState::Unauthorized).await.link.error.as_deref(), Some("not-paired"));
}
