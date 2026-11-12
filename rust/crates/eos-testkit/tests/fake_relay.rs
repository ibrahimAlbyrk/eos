//! The fake relay held to what the real one's tests pin
//! (`relay/__tests__/server.test.ts`): a raw WebSocket on each side, the
//! envelopes written by hand.

use std::time::{Duration, Instant};

use bytes::Bytes;
use eos_relay::control::{self, Control};
use eos_relay::envelope::{Dir, Envelope, FrameType, Header, encode_envelope, parse_envelope};
use eos_testkit::relay::registry::sha256_hex;
use eos_testkit::relay::{FakeRelay, FakeRelayOptions};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const ROOM: &str = "AAAAAAAAAAAAAAAAAAAAAA";
const PATIENCE: Duration = Duration::from_secs(10);

struct Peer(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Peer {
    async fn open(relay: &FakeRelay) -> Self {
        Self(tokio_tungstenite::connect_async(relay.url()).await.expect("connects").0)
    }

    async fn send(&mut self, frame: Bytes) {
        self.0.send(Message::Binary(frame)).await.expect("sent");
    }

    /// The next binary message, raw; `None` once the socket closed.
    async fn raw(&mut self) -> Option<Bytes> {
        loop {
            match tokio::time::timeout(PATIENCE, self.0.next()).await.expect("something in time") {
                Some(Ok(Message::Binary(buf))) => return Some(buf),
                Some(Ok(Message::Close(_)) | Err(_)) | None => return None,
                Some(Ok(_)) => {}
            }
        }
    }

    async fn next(&mut self) -> (Envelope, Control) {
        let envelope = parse_envelope(&self.raw().await.expect("a message")).expect("an envelope");
        let body = Control::parse(&envelope.payload);
        (envelope, body)
    }
}

fn json(kind: FrameType, body: &str) -> Bytes {
    encode_envelope(Header::new(kind, Dir::C2s, ROOM, [0; 16]), body.as_bytes()).expect("encodes")
}

/// A registered owner and a joined device, their acks consumed.
async fn mac_and_device(relay: &FakeRelay) -> (Peer, Peer, [u8; 16]) {
    let mut mac = Peer::open(relay).await;
    mac.send(control::register(ROOM, "owner", &[sha256_hex("dev")]).expect("encodes")).await;
    assert_eq!(mac.next().await.1.kind(), Some("registered"));
    let mut dev = Peer::open(relay).await;
    dev.send(control::join(ROOM, "dev").expect("encodes")).await;
    let client = dev.next().await.1.client_id().expect("an id");
    assert_eq!(mac.next().await.1.kind(), Some("joined"));
    (mac, dev, client)
}

async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn register_join_and_forwarding_both_ways_untouched() {
    let relay = FakeRelay::start().await;
    let mut mac = Peer::open(&relay).await;
    mac.send(control::register(ROOM, "owner-secret", &[sha256_hex("dev-bearer")]).expect("encodes")).await;
    assert_eq!(mac.next().await.1.kind(), Some("registered"));
    assert_eq!(relay.room_count(), 1);

    let mut dev = Peer::open(&relay).await;
    dev.send(control::join(ROOM, "dev-bearer").expect("encodes")).await;

    // The owner is told to start the device's session; the device learns its id.
    let (mac_env, mac_body) = mac.next().await;
    assert_eq!((mac_env.frame_type(), mac_body.kind()), (Some(FrameType::RelayCtl), Some("joined")));
    let (dev_env, dev_body) = dev.next().await;
    assert_eq!(dev_body.kind(), Some("joined"));
    // The id is 22 characters of base64url for 16 bytes, the same in header and body, the same for both ends.
    assert_eq!(dev_body.str("clientId").map(str::len), Some(22));
    let client = dev_body.client_id().expect("16 bytes");
    assert_eq!(dev_env.client_id, client);
    assert_eq!(mac_body.str("clientId"), dev_body.str("clientId"));

    let header = |dir| Header { seq: 1, ..Header::new(FrameType::Data, dir, ROOM, client) };
    let up = encode_envelope(header(Dir::C2s), b"opaque-ciphertext-up").expect("encodes");
    dev.send(up.clone()).await;
    assert_eq!(mac.raw().await, Some(up), "the owner gets the device's frame byte for byte");

    let down = encode_envelope(header(Dir::S2c), b"opaque-ciphertext-down").expect("encodes");
    mac.send(down.clone()).await;
    assert_eq!(dev.raw().await, Some(down), "the addressed device gets the owner's frame byte for byte");
    assert_eq!(relay.forwarded(), 2);
}

#[tokio::test]
async fn a_join_is_refused_with_its_reason() {
    let relay = FakeRelay::start().await;
    let mut mac = Peer::open(&relay).await;
    mac.send(control::register(ROOM, "owner", &[sha256_hex("good")]).expect("encodes")).await;
    mac.next().await;

    let mut dev = Peer::open(&relay).await;
    dev.send(control::join(ROOM, "bad").expect("encodes")).await;
    let (envelope, body) = dev.next().await;
    assert_eq!((envelope.frame_type(), body.str("code")), (Some(FrameType::Error), Some("BEARER_DENIED")));

    let mut lost = Peer::open(&relay).await;
    lost.send(control::join("UNKNOWNROOMUNKNOWNROO0", "x").expect("encodes")).await;
    assert_eq!(lost.next().await.1.str("code"), Some("ROOM_NOT_FOUND"));
}

#[tokio::test]
async fn malformed_requests_are_answered_not_met_with_silence() {
    let relay = FakeRelay::start().await;
    let mut dev = Peer::open(&relay).await;
    dev.send(json(FrameType::Join, &format!(r#"{{"t":"join","room":"{ROOM}"}}"#))).await;
    let (envelope, body) = dev.next().await;
    assert_eq!((envelope.frame_type(), body.str("code")), (Some(FrameType::Error), Some("BAD_REQUEST")));

    let mut mac = Peer::open(&relay).await;
    mac.send(json(FrameType::Register, &format!(r#"{{"t":"register","room":"{ROOM}"}}"#))).await;
    assert_eq!(mac.next().await.1.str("code"), Some("BAD_REQUEST"));
}

#[tokio::test]
async fn a_device_leaving_is_announced_to_the_owner_with_its_id() {
    let relay = FakeRelay::start().await;
    let (mut mac, dev, client) = mac_and_device(&relay).await;
    drop(dev);
    let (envelope, body) = mac.next().await;
    assert_eq!((body.kind(), body.client_id()), (Some("left"), Some(client)));
    assert_eq!(envelope.client_id, client);
}

#[tokio::test]
async fn the_owner_dropping_closes_its_devices_and_keeps_the_room() {
    let relay = FakeRelay::start().await;
    let (mac, mut dev, _) = mac_and_device(&relay).await;
    drop(mac);
    assert_eq!(dev.raw().await, None, "the device's socket is closed");
    assert_eq!(relay.room_count(), 1);
}

#[tokio::test]
async fn only_the_owner_changes_the_admission_list_and_wake_requests_are_counted() {
    let relay = FakeRelay::start().await;
    let (mut mac, mut dev, _) = mac_and_device(&relay).await;
    let add = format!(r#"{{"t":"allow-add","room":"{ROOM}","hash":"{}"}}"#, sha256_hex("second"));
    dev.send(json(FrameType::RelayCtl, &add)).await;
    assert_eq!(dev.next().await.1.str("code"), Some("OWNER_MISMATCH"));
    mac.send(json(FrameType::RelayCtl, &add)).await;

    // A socket's messages are handled in order: once this stray frame is
    // answered, the update before it was applied.
    mac.send(encode_envelope(Header::new(FrameType::Data, Dir::S2c, ROOM, [9; 16]), b"x").expect("encodes")).await;
    assert_eq!(mac.next().await.1.str("code"), Some("ROOM_NOT_FOUND"));
    let mut second = Peer::open(&relay).await;
    second.send(control::join(ROOM, "second").expect("encodes")).await;
    assert_eq!(second.next().await.1.kind(), Some("joined"));

    mac.send(json(FrameType::RelayCtl, &format!(r#"{{"t":"pushIntent","room":"{ROOM}","reason":"x"}}"#))).await;
    until("the wake request", || relay.push_intents() == 1).await;
}

#[tokio::test]
async fn the_heartbeat_drops_a_socket_that_stops_answering_pings() {
    let relay =
        FakeRelay::start_with(FakeRelayOptions { heartbeat: Some(Duration::from_millis(40)), ..Default::default() })
            .await;
    // A half-open peer: the socket stays open but is never read, so it never pongs.
    let mut silent = Peer::open(&relay).await;
    silent.send(control::register(ROOM, "owner", &[]).expect("encodes")).await;
    let mut healthy = Peer::open(&relay).await;
    let reading = tokio::spawn(async move {
        // Reading is what answers pings.
        while healthy.0.next().await.is_some() {}
    });

    until("the silent socket to be dropped", || relay.connections() == 1).await;
    assert!(!reading.is_finished(), "a socket that answers survives the same ticks");
    reading.abort();
    drop(silent);
}

#[tokio::test]
async fn stopping_leaves_nothing_listening() {
    let relay = FakeRelay::start().await;
    let addr = relay.addr();
    let _peer = Peer::open(&relay).await;
    relay.stop().await;
    assert!(TcpStream::connect(addr).await.is_err(), "the port is closed");
}
