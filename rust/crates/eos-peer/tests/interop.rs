//! A Rust computer and a TypeScript-era one, in every pairing of roles: what
//! guarantees that a computer that was not updated keeps working with one
//! that was. The TypeScript side is today's `manager/peer` code from this
//! checkout, run by `node` (tests/node); everything is on loopback, on
//! identities made for the test.

#[path = "support/mac.rs"]
mod mac;
mod support;

use std::sync::Arc;

use bytes::Bytes;
use eos_contracts::{LinkRoute, LinkState};
use eos_core::net::peer::{HostLinks, LinkRequest, PeerHosting};
use eos_testkit::TempHome;
use mac::{Mac, MacOptions, eventually, wait_for};
use serde_json::{Value, json};
use support::Node;

/// What the TypeScript daemon of this checkout stamps its route surface with.
const TS_STAMP_LEN: usize = 16;

struct NodeMac {
    name: &'static str,
    id: String,
    // Its data folder, removed with it.
    _home: TempHome,
}

impl NodeMac {
    async fn start(node: &mut Node, name: &'static str, extra: Value) -> Self {
        let home = TempHome::new();
        let mut args = json!({ "name": name, "dir": home.join("peer") });
        for (key, value) in extra.as_object().into_iter().flatten() {
            args[key] = value.clone();
        }
        let started = node.call("mac.start", args).await;
        Self { name, id: started["fingerprint"].as_str().expect("an id").to_owned(), _home: home }
    }

    async fn call(&self, node: &mut Node, cmd: &str, mut args: Value) -> Value {
        args["name"] = json!(self.name);
        node.call(cmd, args).await
    }

    /// This computer's view of a host it controls.
    async fn host(&self, node: &mut Node, id: &str) -> Value {
        self.call(node, "mac.host", json!({ "id": id })).await["host"].clone()
    }

    /// Polls until its link to `id` satisfies `check`.
    async fn link_until(&self, node: &mut Node, id: &str, check: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + mac::WAIT;
        loop {
            let host = self.host(node, id).await;
            if check(&host["link"]) {
                return host;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out; the link is {}", host["link"]);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    async fn live(&self, node: &mut Node, id: &str) -> Value {
        self.link_until(node, id, |link| link["state"] == "live").await
    }

    /// A request to this computer's own facade for the host `id`.
    async fn fetch(&self, node: &mut Node, id: &str, path: &str, extra: Value) -> Value {
        let mut args = json!({ "path": format!("/h/{id}{path}") });
        for (key, value) in extra.as_object().into_iter().flatten() {
            args[key] = value.clone();
        }
        self.call(node, "mac.fetch", args).await["response"].clone()
    }

    async fn seen(&self, node: &mut Node, path: &str) -> Option<Value> {
        let seen = self.call(node, "mac.seen", json!({})).await["seen"].clone();
        seen.as_array().and_then(|all| all.iter().rev().find(|s| s["path"] == path).cloned())
    }
}

fn json_body(response: &Value) -> Value {
    serde_json::from_str(response["body"].as_str().expect("a body")).expect("a JSON body")
}

async fn rust_get(
    mac: &Mac,
    host: &str,
    target: &str,
    headers: Vec<(String, String)>,
) -> eos_core::net::peer::PeerAnswer {
    let request = LinkRequest { method: "GET".into(), target: target.into(), headers, body: Bytes::new(), human: true };
    mac.peering.forward(host, request).await.expect("the link carried it")
}

// ---- a Rust host, a TypeScript device ------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_device_pairs_with_a_rust_host_and_drives_it() {
    let Some(mut node) = Node::start().await else { return };
    let host = Mac::new("Office iMac").await;
    let device = NodeMac::start(&mut node, "Old MacBook", json!({})).await;

    let invite = host.invite();
    let paired = device.call(&mut node, "mac.pair", json!({ "invite": invite, "alias": "Office" })).await;
    assert_eq!(paired["view"]["id"], host.id());
    assert_eq!(paired["view"]["name"], "Office iMac");
    assert_eq!(paired["view"]["alias"], "Office");
    assert_eq!(paired["view"]["mutual"], false);
    let live = device.live(&mut node, &host.id()).await;
    assert_eq!(live["link"]["route"], "direct");
    let listed = &host.peering.status().devices[0];
    assert_eq!(
        (listed.fp.0.as_str(), listed.name.as_str(), listed.platform.as_str()),
        (device.id.as_str(), "Old MacBook", "darwin")
    );
    // The device's link read who the host is and measured its latency: PING and `/api/host` cross.
    device.link_until(&mut node, &host.id(), |link| link["rttMs"].is_number()).await;
    let deadline = tokio::time::Instant::now() + mac::WAIT;
    let info = loop {
        let info = device.host(&mut node, &host.id()).await["info"].clone();
        if !info.is_null() {
            break info;
        }
        assert!(tokio::time::Instant::now() < deadline, "the device never learned who the host is");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(info["apiStamp"], "test-stamp");
    assert_eq!(info["id"], host.id());

    // The invite worked once: the device itself is told so by the pairing route…
    let again = node.call_err("mac.pair", json!({ "name": "Old MacBook", "invite": invite })).await;
    assert_eq!(again["status"], 403);
    assert!(again["error"].as_str().is_some_and(|e| e.contains("already used or cancelled")), "{again}");
    // …and a stranger is turned away before any request: the GOAWAY this host writes by hand is one today's dialer reads.
    let stranger = NodeMac::start(&mut node, "Stranger", json!({})).await;
    let refused = node.call_err("mac.pair", json!({ "name": stranger.name, "invite": invite })).await;
    assert_eq!(refused["status"], 403);
    assert!(refused["error"].as_str().is_some_and(|e| e.starts_with("that Mac isn't taking this invite")), "{refused}");

    // Requests through the TypeScript facade, answered by the Rust host's app.
    let dash = device.fetch(&mut node, &host.id(), "/workers?limit=3", json!({ "human": true })).await;
    assert_eq!(dash["status"], 200);
    assert_eq!(json_body(&dash), json!({ "path": "/workers?limit=3", "method": "GET", "body": "" }));
    let seen = host.app.saw("/workers?limit=3").expect("reached the host");
    assert!(seen.human, "the device's daemon vouched for its dashboard");
    assert_eq!(seen.device, device.id);
    let posted = device
        .fetch(&mut node, &host.id(), "/pty", json!({ "human": true, "method": "POST", "body": "{\"cols\":80}", "headers": { "content-type": "application/json", "x-eos-peer-device": "spoofed" } }))
        .await;
    assert_eq!(json_body(&posted)["body"], "{\"cols\":80}");
    assert_eq!(
        host.app.saw("/pty").expect("reached").device,
        device.id,
        "identity is the gateway's, never the device's"
    );
    let big = device.fetch(&mut node, &host.id(), "/big", json!({ "human": true })).await;
    assert_eq!(big["bytes"], 3 * 1024 * 1024);

    // A process on the device that is not its dashboard gets the host's public face only.
    let agent = device.fetch(&mut node, &host.id(), "/fs/read?path=/etc/hosts", json!({})).await;
    assert_eq!((agent["status"].as_u64(), json_body(&agent)["code"].as_str()), (Some(403), Some("needs-human")));
    assert_eq!(device.fetch(&mut node, &host.id(), "/api/host", json!({})).await["status"], 200);
    assert!(host.app.saw("/fs/read?path=/etc/hosts").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_device_resumes_a_stream_from_a_rust_host_after_the_link_drops() {
    let Some(mut node) = Node::start().await else { return };
    let host = Mac::new("Office iMac").await;
    let device = NodeMac::start(&mut node, "Old MacBook", json!({})).await;
    device.call(&mut node, "mac.pair", json!({ "invite": host.invite() })).await;
    device.live(&mut node, &host.id()).await;
    eventually(|| host.peering.status().devices[0].connected).await;

    // The stream stops after its first event and stays open; the page asked for gzip, as a browser does.
    let path = format!("/h/{}/stream?since=e-0&hold=1", host.id());
    let pending = node
        .send(
            "mac.fetch",
            json!({ "name": device.name, "path": path, "human": true, "headers": { "accept-encoding": "gzip" } }),
        )
        .await;
    eventually(|| host.app.saw("/stream?since=e-0&hold=1").is_some()).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // The link drops under it: the facade's answer ends with what had arrived.
    assert_eq!(host.peering.disconnect(&device.id), 1);
    let cut = node.answer(pending).await["response"].clone();
    assert_eq!(cut["status"], 200);
    assert_eq!(cut["headers"]["content-encoding"], "gzip", "event frames are gzipped for a caller that accepts it");
    assert_eq!(cut["body"], "id: e-1\nevent: change\ndata: {\"n\":1}\n\n", "the frame arrived when it was written");

    // The dashboard reconnects from its last event id; the link is back by itself.
    let rest = device
        .fetch(
            &mut node,
            &host.id(),
            "/stream?since=e-1",
            json!({ "human": true, "headers": { "last-event-id": "e-1" } }),
        )
        .await;
    assert_eq!(rest["status"], 200);
    assert_eq!(
        rest["headers"]["content-encoding"],
        Value::Null,
        "a caller that never asked for gzip gets plain frames"
    );
    assert_eq!(rest["body"], "id: e-2\nevent: change\ndata: {\"n\":2}\n\nid: e-3\nevent: change\ndata: {\"n\":3}\n\n");
    let resumed = host.app.saw("/stream?since=e-1").expect("reached");
    assert!(resumed.headers.contains(&("last-event-id".into(), "e-1".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_host_tells_a_typescript_device_why_it_is_turned_away() {
    let Some(mut node) = Node::start().await else { return };
    let host = Mac::new("Office iMac").await;
    let device = NodeMac::start(&mut node, "Old MacBook", json!({})).await;
    device.call(&mut node, "mac.pair", json!({ "invite": host.invite() })).await;
    device.live(&mut node, &host.id()).await;
    eventually(|| host.peering.status().devices[0].connected).await;

    // Remote access switched off: the device checks back now and then.
    host.config.lock().expect("lock").enabled = false;
    assert_eq!(host.peering.disconnect(&device.id), 1);
    let off = device.link_until(&mut node, &host.id(), |link| link["error"] == "remote-access-off").await;
    assert_eq!(off["link"]["state"], "reconnecting");
    host.config.lock().expect("lock").enabled = true;
    assert_eq!(device.call(&mut node, "mac.reconnect", json!({ "id": host.id() })).await["known"], true);
    device.live(&mut node, &host.id()).await;
    eventually(|| host.peering.status().devices[0].connected).await;

    // Revoked: the device stops retrying, and its facade says why.
    assert!(host.peering.revoke(&device.id));
    let revoked = device.link_until(&mut node, &host.id(), |link| link["state"] == "unauthorized").await;
    assert_eq!(revoked["link"]["error"], "not-paired");
    let refused = device.fetch(&mut node, &host.id(), "/workers", json!({ "human": true })).await;
    assert_eq!((refused["status"].as_u64(), json_body(&refused)["code"].as_str()), (Some(503), Some("not-paired")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_host_reaches_a_typescript_device_through_the_tunnel_it_offers() {
    let Some(mut node) = Node::start().await else { return };
    let host = Mac::new("Office iMac").await;
    // The device lets the host control it too, but has no address the host could dial.
    let device = NodeMac::start(&mut node, "Old MacBook", json!({ "direct": false })).await;
    let paired = device.call(&mut node, "mac.pair", json!({ "invite": host.invite(), "mutual": true })).await;
    assert_eq!(paired["view"]["mutual"], true, "the Rust host took the offer");

    let back = host.link_is(&device.id, LinkState::Live).await;
    assert_eq!(back.link.route, Some(LinkRoute::Reverse), "through the stream the device offered on its own link");
    assert_eq!(back.name, "Old MacBook");
    let (status, _, body) = host.get(&device.id, "/workers?via=tunnel", true).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).expect("json")["path"], "/workers?via=tunnel");
    let seen = device.seen(&mut node, "/workers?via=tunnel").await.expect("reached the device's daemon");
    assert_eq!(seen["device"], host.id());
    assert!(seen["token"].is_string(), "the device's gateway vouched for the host's dashboard");
    assert_eq!(host.get(&device.id, "/big", true).await.2.len(), 3 * 1024 * 1024);
    let info = wait_for(|| host.host_view(&device.id).and_then(|v| v.info)).await;
    assert_eq!(info.api_stamp.len(), TS_STAMP_LEN);
}

// ---- a TypeScript host, a Rust device ------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_device_pairs_with_a_typescript_host_and_drives_it() {
    let Some(mut node) = Node::start().await else { return };
    let host = NodeMac::start(&mut node, "Old iMac", json!({})).await;
    // What the old host raises reaches the person on the Rust computer.
    host.call(
        &mut node,
        "mac.raise",
        json!({ "payloads": [
        { "title": "Build finished", "body": "all green", "workerId": "w9" },
        { "title": "Relayed", "body": "?", "host": { "id": "x", "name": "Elsewhere" } },
    ] }),
    )
    .await;
    let device = Mac::new("New MacBook").await;

    let invite = host.call(&mut node, "mac.invite", json!({})).await["link"].as_str().expect("a link").to_owned();
    let (view, mutual) = device.peering.pair(&invite, Some("Old one"), false).await.expect("pairs");
    assert_eq!((view.id.0.as_str(), view.name.as_str(), mutual), (host.id.as_str(), "Old iMac", false));
    let live = device.link_is(&host.id, LinkState::Live).await;
    assert_eq!(live.link.route, Some(LinkRoute::Direct));
    let status = host.call(&mut node, "mac.status", json!({})).await["status"].clone();
    assert_eq!(status["devices"][0]["fp"], device.id());
    assert_eq!(status["devices"][0]["name"], "New MacBook");
    assert_eq!(status["openInvites"], 0);
    let known = wait_for(|| device.host_view(&host.id).filter(|v| v.info.is_some() && v.link.rtt_ms.is_some())).await;
    assert_eq!(known.info.expect("info").api_stamp.len(), TS_STAMP_LEN);

    // A used invite: the old host turns a stranger's session away, and the reason is read here.
    let stranger = Mac::new("Stranger").await;
    let refused = stranger.peering.pair(&invite, None, false).await.expect_err("used");
    assert_eq!(refused.status, 403);
    assert!(refused.message.starts_with("that Mac isn't taking this invite"), "{}", refused.message);

    let (status, _, body) = device.get(&host.id, "/workers?limit=3", true).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("json"),
        json!({ "path": "/workers?limit=3", "method": "GET", "body": "" })
    );
    let seen = host.seen(&mut node, "/workers?limit=3").await.expect("reached the old host's daemon");
    assert_eq!(seen["device"], device.id(), "its gateway names this computer from its certificate");
    assert!(seen["token"].is_string(), "and attached its own token: this computer vouched for its dashboard");
    let (_, _, body) = device.request(&host.id, "POST", "/pty", "{\"cols\":80}", true).await;
    assert_eq!(serde_json::from_str::<Value>(&body).expect("json")["body"], "{\"cols\":80}");
    assert_eq!(device.get(&host.id, "/big", true).await.2.len(), 3 * 1024 * 1024);

    // Without the dashboard's mark the old host's gateway holds the line itself.
    let (status, _, body) = device.get(&host.id, "/fs/read?path=/etc/hosts", false).await;
    assert_eq!(
        (status, serde_json::from_str::<Value>(&body).expect("json")["code"].as_str()),
        (403, Some("needs-human"))
    );
    assert_eq!(device.get(&host.id, "/api/host", false).await.0, 200);
    assert_eq!(
        device.request(&host.id, "POST", "/policy/decide", "{}", true).await.0,
        403,
        "the local plane never crosses"
    );

    // Its notification, raised here under the name the person gave it.
    let notes = wait_for(|| Some(device.events.notifications()).filter(|n| !n.is_empty())).await;
    assert_eq!(notes.len(), 1, "never one the host itself relayed");
    assert_eq!(notes[0]["title"], "Old one · Build finished");
    assert_eq!(notes[0]["host"], json!({ "id": host.id, "name": "Old one" }));
    assert_eq!(notes[0]["workerId"], "w9");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rust_device_resumes_a_stream_from_a_typescript_host_after_the_link_drops() {
    let Some(mut node) = Node::start().await else { return };
    let host = NodeMac::start(&mut node, "Old iMac", json!({})).await;
    let device = Mac::new("New MacBook").await;
    let invite = host.call(&mut node, "mac.invite", json!({})).await["link"].as_str().expect("a link").to_owned();
    device.peering.pair(&invite, None, false).await.expect("pairs");
    device.link_is(&host.id, LinkState::Live).await;

    let mut stream = rust_get(&device, &host.id, "/stream?since=e-0&hold=1", vec![]).await;
    assert_eq!(stream.status, 200);
    let header = |name: &str| stream.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    assert_eq!(header("content-type").as_deref(), Some("text/event-stream"));
    assert_eq!(header("content-encoding"), None, "the old host's gzip is unpacked before it reaches the page");
    let first = stream.body.next().await.expect("a frame").expect("whole");
    assert_eq!(first.as_ref(), b"id: e-1\nevent: change\ndata: {\"n\":1}\n\n", "arrived when it was written");

    // The old host drops the link: the stream here ends instead of hanging.
    let before = device.host_view(&host.id).expect("known").link.since;
    assert_eq!(host.call(&mut node, "mac.disconnect", json!({ "fp": device.id() })).await["disconnected"], 1);
    let ended = tokio::time::timeout(mac::WAIT, stream.body.next()).await.expect("the stream ends");
    assert!(ended.is_none_or(|chunk| chunk.is_err()), "cut, not completed");
    wait_for(|| device.host_view(&host.id).filter(|v| v.link.state == LinkState::Live && v.link.since != before)).await;

    let mut rest = rust_get(&device, &host.id, "/stream?since=e-1", vec![("last-event-id".into(), "e-1".into())]).await;
    let mut text = String::new();
    while let Some(chunk) = rest.body.next().await {
        text.push_str(&String::from_utf8_lossy(&chunk.expect("whole")));
    }
    assert_eq!(text, "id: e-2\nevent: change\ndata: {\"n\":2}\n\nid: e-3\nevent: change\ndata: {\"n\":3}\n\n");
    let seen = host.seen(&mut node, "/stream?since=e-1").await.expect("reached");
    assert_eq!(seen["lastEventId"], "e-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_host_tells_a_rust_device_why_it_is_turned_away() {
    let Some(mut node) = Node::start().await else { return };
    let host = NodeMac::start(&mut node, "Old iMac", json!({})).await;
    let device = Mac::new("New MacBook").await;
    let invite = host.call(&mut node, "mac.invite", json!({})).await["link"].as_str().expect("a link").to_owned();
    device.peering.pair(&invite, None, false).await.expect("pairs");
    device.link_is(&host.id, LinkState::Live).await;

    // Remote access switched off there, before its daemon applied the switch.
    host.call(&mut node, "mac.config", json!({ "patch": { "enabled": false }, "apply": false })).await;
    host.call(&mut node, "mac.disconnect", json!({ "fp": device.id() })).await;
    let off =
        wait_for(|| device.host_view(&host.id).filter(|v| v.link.error.as_deref() == Some("remote-access-off"))).await;
    assert_eq!(off.link.state, LinkState::Reconnecting);
    host.call(&mut node, "mac.config", json!({ "patch": { "enabled": true }, "apply": false })).await;
    assert!(device.peering.reconnect(&host.id));
    device.link_is(&host.id, LinkState::Live).await;

    // Revoked there: this computer stops retrying.
    eventually_connected(&host, &mut node).await;
    assert_eq!(host.call(&mut node, "mac.revoke", json!({ "fp": device.id() })).await["revoked"], true);
    let refused = device.link_is(&host.id, LinkState::Unauthorized).await;
    assert_eq!(refused.link.error.as_deref(), Some("not-paired"));
}

async fn eventually_connected(host: &NodeMac, node: &mut Node) {
    let deadline = tokio::time::Instant::now() + mac::WAIT;
    loop {
        let status = host.call(node, "mac.status", json!({})).await["status"].clone();
        if status["devices"][0]["connected"] == true {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "the old host never listed the session");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_typescript_host_reaches_a_rust_device_through_the_tunnel_it_offers() {
    let Some(mut node) = Node::start().await else { return };
    let host = NodeMac::start(&mut node, "Old iMac", json!({})).await;
    // This computer lets the old host control it too, but has no address the host could dial.
    let device =
        Mac::on(Arc::new(TempHome::new()), MacOptions { direct: false, ..MacOptions::named("New MacBook") }).await;
    let invite = host.call(&mut node, "mac.invite", json!({})).await["link"].as_str().expect("a link").to_owned();
    let (_, mutual) = device.peering.pair(&invite, None, true).await.expect("pairs");
    assert!(mutual, "the old host took the offer");
    assert_eq!(device.peering.status().devices[0].fp.0, host.id);

    let back = host.link_until(&mut node, &device.id(), |link| link["state"] == "live").await;
    assert_eq!(back["link"]["route"], "reverse", "the old host dialled TLS through the stream this computer offered");
    assert_eq!(back["name"], "New MacBook");
    let through = host.fetch(&mut node, &device.id(), "/workers?via=tunnel", json!({ "human": true })).await;
    assert_eq!(through["status"], 200);
    assert_eq!(json_body(&through)["path"], "/workers?via=tunnel");
    let seen = device.app.saw("/workers?via=tunnel").expect("reached this computer's app");
    assert_eq!(seen.device, host.id);
    assert!(seen.human);
    assert_eq!(host.fetch(&mut node, &device.id(), "/big", json!({ "human": true })).await["bytes"], 3 * 1024 * 1024);
}
