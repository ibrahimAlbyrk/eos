//! The connection that owns a room, against a relay on a loopback port:
//! reconnecting, its bounds, and the byte pipes of a peer link.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use eos_core::net::relay::{Relay, RelayError, RoomClaim, RoomEvent, RoomHosting, RoomJoin};
use eos_relay::{RelayClient, RelayOptions};
use eos_testkit::FakeClock;
use eos_testkit::relay::registry::sha256_hex;
use eos_testkit::relay::{FakePhone, FakeRelay, JoinFailure, free_port};

const ROOM: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER: &str = "OWNER-SECRET-B64U";
const BEARER: &str = "dev-bearer";
const PATIENCE: Duration = Duration::from_secs(10);

fn claim(url: &str) -> RoomClaim {
    RoomClaim {
        url: url.to_owned(),
        room: ROOM.to_owned(),
        owner: OWNER.to_owned(),
        allow: Arc::new(|| vec![sha256_hex(BEARER)]),
    }
}

/// Timings short enough for a test, with a ping that never fires unless asked for.
fn quick() -> RelayOptions {
    RelayOptions {
        backoff_min: Duration::from_millis(40),
        backoff_max: Duration::from_millis(200),
        ping_interval: Duration::from_secs(3600),
        wake_check: Duration::from_millis(20),
        ..RelayOptions::default()
    }
}

fn client(options: RelayOptions) -> (RelayClient, Arc<FakeClock>) {
    let clock = Arc::new(FakeClock::at(1_731_400_000_000));
    (RelayClient::with_options(clock.clone(), options), clock)
}

async fn next(hosting: &Arc<dyn RoomHosting>) -> RoomEvent {
    tokio::time::timeout(PATIENCE, hosting.next()).await.expect("an event in time").expect("the room is open")
}

async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dials_registers_and_carries_messages_both_ways() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(quick());
    let hosting = client.host(claim(&relay.url()));
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    assert!(hosting.online());
    until("the relay to take the registration", || !relay.registrations().is_empty()).await;
    let registration = relay.registrations().pop().expect("a registration");
    assert_eq!((registration.room.as_str(), registration.owner.as_str()), (ROOM, OWNER));
    assert_eq!(registration.allow, [sha256_hex(BEARER)]);

    let mut phone = FakePhone::join(&relay.url(), ROOM, BEARER).await.expect("joins");
    assert_eq!(next(&hosting).await, RoomEvent::Joined(phone.client()));

    phone.send_raw(b"plaintext-bytes");
    assert_eq!(
        next(&hosting).await,
        RoomEvent::Data { client: phone.client(), payload: Bytes::from_static(b"plaintext-bytes") }
    );

    hosting
        .send(phone.client(), Bytes::from_static(br#"{"t":"event","seq":1,"reason":"x","ts":0}"#))
        .await
        .expect("sent");
    assert_eq!(phone.next().await["reason"], "x");

    let id = phone.client();
    phone.close();
    assert_eq!(next(&hosting).await, RoomEvent::Left(id));

    hosting.close();
    assert_eq!(tokio::time::timeout(PATIENCE, hosting.next()).await.expect("ends"), None);
    until("the relay to see the owner leave", || relay.connections() == 0).await;
    assert!(!hosting.online());
    assert_eq!(hosting.try_send(id, Bytes::new()), Err(RelayError::Offline));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_join_is_told_apart_from_a_relay_that_is_down() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(quick());
    let hosting = client.host(claim(&relay.url()));
    assert_eq!(next(&hosting).await, RoomEvent::Registered);

    assert_eq!(FakePhone::join(&relay.url(), ROOM, "stranger").await.err(), Some(JoinFailure::AuthRejected));
    let unknown = FakePhone::join(&relay.url(), "UNKNOWNROOMUNKNOWNROO0", BEARER).await.err();
    assert_eq!(unknown, Some(JoinFailure::Transient("relay ROOM_NOT_FOUND".into())));

    // A frame for a device that is not in the room: the relay says so.
    hosting.send([9; 16], Bytes::from_static(b"{}")).await.expect("queued");
    assert_eq!(
        next(&hosting).await,
        RoomEvent::Refused { code: "ROOM_NOT_FOUND".into(), message: "no route for frame".into() }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_that_stops_answering_pings_is_redialled_and_a_healthy_one_is_kept() {
    let dead = FakeRelay::start().await;
    let healthy = FakeRelay::start().await;
    let (client, _) = client(RelayOptions { ping_interval: Duration::from_millis(30), ..quick() });
    let a = client.host(claim(&dead.url()));
    let b = client.host(claim(&healthy.url()));
    assert_eq!(next(&a).await, RoomEvent::Registered);
    assert_eq!(next(&b).await, RoomEvent::Registered);

    dead.freeze(true);
    assert_eq!(next(&a).await, RoomEvent::Offline, "no answer for a whole interval ends the socket");
    dead.freeze(false);
    assert_eq!(next(&a).await, RoomEvent::Registered, "and it dials again");

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(healthy.accepted(), 1, "a relay that answers keeps its socket across the same ticks");
    assert!(b.online());
}

#[tokio::test(flavor = "multi_thread")]
async fn redials_once_and_promptly_when_the_wall_clock_shows_the_computer_slept() {
    let relay = FakeRelay::start().await;
    let (client, clock) = client(RelayOptions { backoff_min: Duration::from_millis(60), ..quick() });
    let hosting = client.host(claim(&relay.url()));
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    let mut phone = FakePhone::join(&relay.url(), ROOM, BEARER).await.expect("joins");
    assert_eq!(next(&hosting).await, RoomEvent::Joined(phone.client()));

    // Twenty seconds between two ticks is not a sleep (the limit is check + 20 s).
    clock.advance(20_000);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(relay.accepted(), 2, "the owner and the phone, no redial");

    clock.advance(10 * 60_000);
    assert_eq!(next(&hosting).await, RoomEvent::Offline);
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    // The relay closes the devices of the owner's old socket: they join again.
    phone.closed().await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(relay.accepted(), 3, "exactly one redial");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wake_skips_the_pause_before_the_next_dial() {
    let addr = free_port().await;
    let (client, clock) =
        client(RelayOptions { backoff_min: Duration::from_secs(30), backoff_max: Duration::from_secs(60), ..quick() });
    let hosting = client.host(claim(&format!("ws://{addr}/")));
    // The relay is down: the first dial fails and a 30 s pause begins.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!hosting.online());

    let relay = FakeRelay::start_at(addr, Default::default()).await;
    let woke = Instant::now();
    clock.advance(10 * 60_000);
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    assert!(woke.elapsed() < Duration::from_secs(5), "dialled without waiting out the pause");
    assert_eq!(relay.accepted(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cut_connection_is_redialled_and_registers_the_current_admission_list() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(quick());
    let allowed = Arc::new(std::sync::Mutex::new(vec!["aa".to_owned()]));
    let list = allowed.clone();
    let hosting =
        client.host(RoomClaim { allow: Arc::new(move || list.lock().expect("lock").clone()), ..claim(&relay.url()) });
    assert_eq!(next(&hosting).await, RoomEvent::Registered);

    // The list sent again on the live socket: no new connection.
    allowed.lock().expect("lock").push("bb".to_owned());
    hosting.refresh_allow();
    until("the second registration", || relay.registrations().len() == 2).await;
    assert_eq!(relay.registrations()[1].allow, ["aa", "bb"]);
    assert_eq!(relay.accepted(), 1);

    allowed.lock().expect("lock").push("cc".to_owned());
    relay.drop_connections();
    assert_eq!(next(&hosting).await, RoomEvent::Offline);
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    until("the registration on the new connection", || relay.registrations().len() == 3).await;
    assert_eq!(relay.registrations()[2].allow, ["aa", "bb", "cc"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_that_stops_reading_fills_a_bounded_queue_and_senders_wait() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(RelayOptions { outbound_bytes: 6 * 1024 * 1024, ..quick() });
    let hosting = client.host(claim(&relay.url()));
    assert_eq!(next(&hosting).await, RoomEvent::Registered);
    let mut phone = FakePhone::join(&relay.url(), ROOM, BEARER).await.expect("joins");
    assert_eq!(next(&hosting).await, RoomEvent::Joined(phone.client()));

    relay.freeze(true);
    let megabyte = Bytes::from(vec![b' '; 1024 * 1024]);
    let mut queued = 0;
    // The socket's own buffers take some; then the queue fills and says so.
    while hosting.try_send(phone.client(), megabyte.clone()).is_ok() {
        queued += 1;
        assert!(queued < 256, "the queue never filled: it is not bounded");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(hosting.try_send(phone.client(), megabyte.clone()), Err(RelayError::Behind));

    let late = format!(r#"{{"t":"event","seq":7,"reason":"late","ts":0,"payload":"{}"}}"#, "x".repeat(1024 * 1024));
    let waiting = tokio::spawn({
        let (hosting, to) = (hosting.clone(), phone.client());
        async move { hosting.send(to, Bytes::from(late)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished(), "a sender that can wait, waits");

    relay.freeze(false);
    waiting.await.expect("joins").expect("sent once the relay read again");
    assert_eq!(phone.event("late").await["seq"], 7, "and it arrives after everything queued before it");

    let over = Bytes::from(vec![0u8; 5 * 1024 * 1024]);
    assert!(matches!(hosting.send(phone.client(), over).await, Err(RelayError::TooLarge { .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pipe_carries_bytes_both_ways_and_ends_when_either_side_leaves() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(quick());
    let listener = client.listen(claim(&relay.url()));
    until("the room", || listener.online()).await;

    let join = RoomJoin { url: relay.url(), room: ROOM.to_owned(), bearer: BEARER.to_owned() };
    let device = client.dial(join.clone()).await.expect("admitted");
    let host = tokio::time::timeout(PATIENCE, listener.accept()).await.expect("in time").expect("a pipe");

    device.write(Bytes::from_static(b"client hello")).await.expect("written");
    assert_eq!(host.read().await, Some(Bytes::from_static(b"client hello")));
    host.write(Bytes::from_static(b"server hello")).await.expect("written");
    assert_eq!(device.read().await, Some(Bytes::from_static(b"server hello")));

    // A write larger than one envelope carries arrives whole and in order.
    let large: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    host.write(Bytes::from(large.clone())).await.expect("written");
    let mut got = Vec::new();
    while got.len() < large.len() {
        let chunk = device.read().await.expect("more bytes");
        assert!(chunk.len() <= 256 * 1024, "one envelope carries at most 256 KiB");
        got.extend_from_slice(&chunk);
    }
    assert_eq!(got, large);

    device.close();
    assert_eq!(tokio::time::timeout(PATIENCE, host.read()).await.expect("ends"), None, "the device left");
    assert_eq!(host.write(Bytes::from_static(b"x")).await, Err(RelayError::Closed));

    // The owner leaving ends a device's pipe.
    let second = client.dial(join.clone()).await.expect("admitted");
    let _host = tokio::time::timeout(PATIENCE, listener.accept()).await.expect("in time").expect("a pipe");
    listener.close();
    assert_eq!(tokio::time::timeout(PATIENCE, second.read()).await.expect("ends"), None);

    let refused = client.dial(RoomJoin { bearer: "stranger".into(), ..join }).await.err().expect("refused");
    assert_eq!(refused.code, "ROOM_NOT_FOUND", "the room went with its owner");
}

#[tokio::test(flavor = "multi_thread")]
async fn joining_fails_with_the_relays_reason_or_a_timeout() {
    let relay = FakeRelay::start().await;
    let (client, _) = client(RelayOptions { join_timeout: Duration::from_millis(200), ..quick() });
    let _listener = client.listen(claim(&relay.url()));
    until("the room", || relay.room_count() == 1).await;

    let join = RoomJoin { url: relay.url(), room: ROOM.to_owned(), bearer: "stranger".to_owned() };
    assert_eq!(client.dial(join.clone()).await.err().expect("refused").code, "BEARER_DENIED");

    relay.freeze(true);
    let silent = client.dial(RoomJoin { bearer: BEARER.into(), ..join.clone() }).await.err().expect("no answer");
    assert_eq!((silent.code.as_str(), silent.message.as_str()), ("TIMEOUT", "relay did not admit this device in time"));

    let down = free_port().await;
    let unreachable = client.dial(RoomJoin { url: format!("ws://{down}/"), ..join }).await.err().expect("down");
    assert_eq!(unreachable.code, "UNREACHABLE");
}
