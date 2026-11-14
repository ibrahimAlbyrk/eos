//! A computer for a test: its own data folder, a listener on loopback only,
//! no keep-awake, and a small app behind its gateway.

#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::route_planes::{KERNEL_LOCAL_ONLY_ROUTES, is_peer_open_route, matches_route_rules};
use eos_contracts::{HostView, LinkState, PeerConfig};
use eos_core::net::peer::{ByteStream, HostLinks, LinkRequest, LocalApi, PeerAnswer, PeerCall, PeerHosting};
use eos_core::net::relay::Relay;
use eos_core::{BoxFuture, SystemClock};
use eos_peer::{Peering, PeeringOptions};
use eos_testkit::{RecordedPeerEvents, TempHome};
use serde_json::json;
use tokio::sync::mpsc;

pub(crate) const WAIT: Duration = Duration::from_secs(20);

/// A body fed by a channel: the fake app's streamed answers.
pub(crate) struct ChannelBody(pub(crate) mpsc::Receiver<Result<Bytes, String>>);

impl ByteStream for ChannelBody {
    fn next(&mut self) -> BoxFuture<'_, Option<Result<Bytes, String>>> {
        Box::pin(self.0.recv())
    }
}

pub(crate) fn body_of(bytes: impl Into<Bytes>) -> Box<dyn ByteStream> {
    let (tx, rx) = mpsc::channel(1);
    let bytes: Bytes = bytes.into();
    tx.try_send(Ok(bytes)).expect("room for one");
    Box::new(ChannelBody(rx))
}

fn json_answer(status: u16, value: &serde_json::Value) -> PeerAnswer {
    PeerAnswer {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: body_of(value.to_string()),
    }
}

/// The app behind a host's gateway. It applies the two rules the real router
/// applies to a paired computer's request, echoes what it was asked, and
/// streams three events on `/stream`.
#[derive(Default)]
pub(crate) struct FakeApp {
    pub(crate) seen: Mutex<Vec<PeerCall>>,
    /// Set while a `/stream` body is being produced; cleared when the device went away.
    pub(crate) streaming: Arc<Mutex<u32>>,
    pub(crate) notify: Mutex<Vec<serde_json::Value>>,
    /// A `/stream?gated=1` holds its second and third event until this is notified.
    pub(crate) gate: Arc<tokio::sync::Notify>,
    /// What `GET /api/host` answers: the computer's own description.
    pub(crate) host_info: Mutex<serde_json::Value>,
}

impl FakeApp {
    pub(crate) fn saw(&self, target: &str) -> Option<PeerCall> {
        self.seen.lock().expect("lock").iter().find(|c| c.target == target).cloned()
    }

    fn path(target: &str) -> String {
        // Resolve dot segments the way the router does before judging the path.
        let path = target.split('?').next().unwrap_or(target).replace("%2e", ".").replace("%2E", ".");
        let mut out: Vec<&str> = Vec::new();
        for segment in path.split('/') {
            match segment {
                "." => {}
                ".." => {
                    out.pop();
                }
                other => out.push(other),
            }
        }
        out.join("/")
    }
}

impl LocalApi for FakeApp {
    fn body_limit(&self, _method: &str, target: &str) -> usize {
        if target.starts_with("/small") { 8 } else { 1024 * 1024 }
    }

    fn call(&self, call: PeerCall) -> BoxFuture<'_, PeerAnswer> {
        Box::pin(async move {
            let path = Self::path(&call.target);
            if matches_route_rules(KERNEL_LOCAL_ONLY_ROUTES, &call.method, &path) {
                return json_answer(403, &json!({ "error": "not available from another device", "path": path }));
            }
            if !call.human && !is_peer_open_route(&call.method, &path) {
                return json_answer(
                    403,
                    &json!({ "error": "only the Eos window can do this on another computer", "code": "needs-human", "path": path }),
                );
            }
            self.seen.lock().expect("lock").push(call.clone());
            if path == "/stream" {
                let topics = call.target.contains("topics=notification:fire");
                let notes = self.notify.lock().expect("lock").clone();
                let (tx, rx) = mpsc::channel(1);
                let streaming = self.streaming.clone();
                *streaming.lock().expect("lock") += 1;
                let gate = call.target.contains("gated=1").then(|| self.gate.clone());
                let hold = call.target.contains("hold=1");
                let named =
                    call.target.split(['?', '&']).find_map(|pair| pair.strip_prefix("since=").map(str::to_owned));
                let last =
                    named.or_else(|| call.headers.iter().find(|(n, _)| n == "last-event-id").map(|(_, v)| v.clone()));
                let since: u32 = last.and_then(|id| id.strip_prefix("e-").and_then(|n| n.parse().ok())).unwrap_or(0);
                tokio::spawn(async move {
                    if topics {
                        for (i, note) in notes.iter().enumerate() {
                            let frame = format!(
                                "id: e1-{i}\nevent: change\ndata: {}\n\n",
                                json!({ "reason": "notification:fire", "payload": note })
                            );
                            if tx.send(Ok(frame.into())).await.is_err() {
                                break;
                            }
                        }
                        // Stays open like the real stream, until the device leaves.
                        tx.closed().await;
                    } else {
                        // Three events; a caller that names the last one it saw gets the rest.
                        for i in since..3 {
                            let frame = format!("id: e-{}\nevent: change\ndata: {{\"n\":{}}}\n\n", i + 1, i + 1);
                            if tx.send(Ok(frame.into())).await.is_err() {
                                break;
                            }
                            if hold {
                                // Stops after one event and stays open, until the device leaves.
                                tx.closed().await;
                                break;
                            }
                            match (&gate, i) {
                                (Some(gate), 0) => gate.notified().await,
                                _ => tokio::time::sleep(Duration::from_millis(15)).await,
                            }
                        }
                    }
                    *streaming.lock().expect("lock") -= 1;
                });
                return PeerAnswer {
                    status: 200,
                    headers: vec![
                        ("content-type".into(), "text/event-stream".into()),
                        ("cache-control".into(), "no-cache".into()),
                    ],
                    body: Box::new(ChannelBody(rx)),
                };
            }
            if path == "/api/host" {
                return json_answer(200, &self.host_info.lock().expect("lock"));
            }
            if path == "/ui/assets/app.js" {
                return PeerAnswer {
                    status: 200,
                    headers: vec![("content-type".into(), "text/javascript; charset=utf-8".into())],
                    body: body_of("console.log('eos');\n".repeat(20_000)),
                };
            }
            if path == "/big" {
                return PeerAnswer {
                    status: 200,
                    headers: vec![("content-type".into(), "application/octet-stream".into())],
                    body: body_of(vec![7u8; 3 * 1024 * 1024]),
                };
            }
            if call.body.len() > self.body_limit(&call.method, &call.target) {
                return json_answer(413, &json!({ "error": "body too large" }));
            }
            json_answer(
                200,
                &json!({ "path": call.target, "method": call.method, "body": String::from_utf8_lossy(&call.body) }),
            )
        })
    }
}

pub(crate) struct Mac {
    pub(crate) home: Arc<TempHome>,
    pub(crate) peering: Arc<Peering>,
    pub(crate) app: Arc<FakeApp>,
    pub(crate) events: Arc<RecordedPeerEvents>,
    pub(crate) config: Arc<Mutex<PeerConfig>>,
}

impl Drop for Mac {
    fn drop(&mut self) {
        // No listener and no link outlives a test.
        self.peering.stop();
    }
}

pub(crate) struct MacOptions {
    pub(crate) name: &'static str,
    pub(crate) hosting: bool,
    pub(crate) relay: Option<Arc<dyn Relay>>,
    /// Where the relay is; a made-up address serves a relay held in memory.
    pub(crate) relay_url: Option<String>,
    pub(crate) direct: bool,
    /// `PeeringOptions::network`: false for a run that keeps off the network.
    pub(crate) network: bool,
}

impl MacOptions {
    pub(crate) fn named(name: &'static str) -> Self {
        Self { name, hosting: true, relay: None, relay_url: None, direct: true, network: true }
    }
}

impl Mac {
    /// Builds a computer on `home` (so a test can restart one on the same folder).
    pub(crate) async fn on(home: Arc<TempHome>, options: MacOptions) -> Self {
        let config = Arc::new(Mutex::new(PeerConfig {
            enabled: options.hosting,
            direct: options.direct,
            port: 0,
            name: Some(options.name.to_owned()),
            advertise: None,
            relay_url: None,
        }));
        let events = RecordedPeerEvents::new();
        let read = config.clone();
        let mut opts = PeeringOptions::new(
            home.join("peer"),
            Arc::new(SystemClock),
            Arc::new(move || read.lock().expect("lock").clone()),
            events.clone(),
        );
        opts.home = "/Users/test".into();
        opts.api_stamp = "test-stamp".into();
        opts.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
        opts.addresses = Some(Arc::new(|port| vec![format!("127.0.0.1:{port}")]));
        opts.keep_awake = Arc::new(|| None);
        opts.ping_interval = Duration::from_millis(200);
        opts.network = options.network;
        if let Some(relay) = options.relay {
            opts.relay = Some(relay);
            let url = options.relay_url.unwrap_or_else(|| "wss://relay.invalid/ws".to_owned());
            opts.relay_url = Arc::new(move || Some(url.clone()));
        }
        let peering = Peering::open(opts).expect("peering opens");
        let app = Arc::new(FakeApp::default());
        *app.host_info.lock().expect("lock") = serde_json::to_value(peering.host_info()).expect("json");
        peering.serve(app.clone());
        peering.start().await;
        Self { home, peering, app, events, config }
    }

    pub(crate) async fn new(name: &'static str) -> Self {
        Self::on(Arc::new(TempHome::new()), MacOptions::named(name)).await
    }

    pub(crate) fn id(&self) -> String {
        self.peering.fingerprint().to_owned()
    }

    pub(crate) fn invite(&self) -> String {
        self.peering.create_invite().expect("hosting is on").link
    }

    pub(crate) fn host_view(&self, id: &str) -> Option<HostView> {
        HostLinks::get(self.peering.as_ref(), id)
    }

    /// The stored record of a host this computer controls.
    pub(crate) fn peering_host(&self, id: &str) -> eos_contracts::KnownHost {
        eos_peer::stores::known_hosts(&self.home.join("peer")).get(id).expect("a known host")
    }

    pub(crate) async fn set_config(&self, change: impl FnOnce(&mut PeerConfig)) {
        change(&mut self.config.lock().expect("lock"));
        self.peering.reconcile().await;
    }

    /// Waits until this computer's link to `host` is in `state`.
    pub(crate) async fn link_is(&self, host: &str, state: LinkState) -> HostView {
        wait_for(|| self.host_view(host).filter(|v| v.link.state == state)).await
    }

    /// A request for `host` through this computer's link, as its dashboard.
    pub(crate) async fn get(&self, host: &str, target: &str, human: bool) -> (u16, Vec<(String, String)>, String) {
        self.request(host, "GET", target, "", human).await
    }

    pub(crate) async fn request(
        &self,
        host: &str,
        method: &str,
        target: &str,
        body: &str,
        human: bool,
    ) -> (u16, Vec<(String, String)>, String) {
        let request = LinkRequest {
            method: method.to_owned(),
            target: target.to_owned(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Bytes::copy_from_slice(body.as_bytes()),
            human,
        };
        let mut answer = self.peering.forward(host, request).await.expect("the link carried it");
        let mut text = Vec::new();
        while let Some(chunk) = answer.body.next().await {
            text.extend_from_slice(&chunk.expect("the body arrives whole"));
        }
        (answer.status, answer.headers, String::from_utf8_lossy(&text).into_owned())
    }
}

/// Polls `check` until it yields a value.
pub(crate) async fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        if let Some(found) = check() {
            return found;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub(crate) async fn eventually(mut check: impl FnMut() -> bool) {
    wait_for(|| check().then_some(())).await;
}
