use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use serde_json::{Value, json};

use super::*;
use crate::access::Caller;
use crate::bus::{BusOptions, Scope};
use crate::http::{BodyStream, Method, Request};
use crate::live_text::LiveText;
use crate::ordered::Ordered;
use crate::router::Router;
use eos_contracts::stream::topics;
use eos_core::{Clock, Ids};

struct FixedIds;
impl Ids for FixedIds {
    fn token(&self, _alphabet: eos_core::Alphabet, len: usize) -> String {
        "0".repeat(len)
    }
    fn request_id(&self) -> String {
        "r-test0001".into()
    }
    fn stream_epoch(&self) -> String {
        "0123456789ab".into()
    }
}

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        1_700_000_000_000
    }
}

struct Harness {
    bus: Bus,
    hub: StreamHub,
}

fn harness(options: StreamOptions) -> Harness {
    let bus = Bus::new(Ordered::new(), Arc::new(FixedClock), BusOptions { delta_window: None });
    let hub = StreamHub::new(&bus, &FixedIds, options);
    Harness { bus, hub }
}

fn quiet() -> StreamOptions {
    StreamOptions { keepalive: Duration::from_secs(3600), ..StreamOptions::default() }
}

impl Harness {
    async fn broadcast(&self, topic: &'static str, payload: Value) {
        let scope = match topic {
            "agent:delta" | "genui:delta" | "workflow:progress" => payload["workerId"].as_str().map(Scope::worker),
            "pty:data" => payload["sessionId"].as_str().map(Scope::pty),
            _ => None,
        };
        self.bus.publish_raw(topic, scope, Bytes::from(payload.to_string()));
        self.bus.flush().await;
    }

    fn attach(&self, options: AttachOptions) -> Reader {
        let Ok(Body::Stream(stream)) = self.hub.attach(options) else { panic!("a stream body") };
        Reader { stream, frames: Vec::new() }
    }
}

struct Reader {
    stream: BodyStream,
    frames: Vec<String>,
}

impl Reader {
    /// Reads what is queued right now; `false` once the stream has ended.
    async fn drain(&mut self) -> bool {
        loop {
            match tokio::time::timeout(Duration::from_millis(20), self.stream.next()).await {
                Ok(Some(Ok(frame))) => self.frames.push(String::from_utf8(frame.to_vec()).expect("utf-8")),
                Ok(Some(Err(e))) => panic!("stream failed: {e}"),
                Ok(None) => return false,
                Err(_) => return true,
            }
        }
    }

    fn changes(&self) -> Vec<Value> {
        self.frames
            .iter()
            .filter(|f| f.contains("\nevent: change\n"))
            .map(|f| serde_json::from_str(&f[f.find("data: ").expect("data") + 6..]).expect("json data"))
            .collect()
    }

    fn payloads(&self) -> Vec<Value> {
        self.changes().into_iter().map(|d| d["payload"].clone()).collect()
    }

    fn reasons(&self) -> Vec<String> {
        self.changes()
            .iter()
            .map(|d| {
                let about = d["payload"]["workerId"].as_str().or(d["payload"]["sessionId"].as_str()).unwrap_or("");
                format!("{}:{about}", d["reason"].as_str().unwrap_or(""))
            })
            .collect()
    }

    fn last_id(&self) -> String {
        self.frames
            .iter()
            .rev()
            .find_map(|f| f.strip_prefix("id: ").map(|rest| rest[..rest.find('\n').expect("line")].to_owned()))
            .expect("an id")
    }

    fn has(&self, event: &str) -> bool {
        self.frames.iter().any(|f| f.contains(&format!("\nevent: {event}\n")))
    }
}

#[tokio::test]
async fn writes_todays_frames_byte_for_byte() {
    let h = harness(StreamOptions { caps: vec!["state:patch".into()], ..quiet() });
    let mut r = h.attach(AttachOptions::default());
    h.broadcast("worker:change", json!({ "workerId": "w1", "state": "IDLE" })).await;
    h.bus.publish_raw("worker:removed", None, Bytes::new());
    h.bus.publish_raw(String::from("plugin:clock:\"tick\""), None, Bytes::from_static(b"{\n  \"t\": 1\n}"));
    h.bus.flush().await;
    r.drain().await;
    assert_eq!(
        r.frames,
        [
            "retry: 2000\n\n",
            ":connected\n\n",
            "id: 0123456789ab-0\nevent: hello\ndata: {\"epoch\":\"0123456789ab\",\"seq\":0,\"caps\":[\"state:patch\"]}\n\n",
            "id: 0123456789ab-1\nevent: change\ndata: {\"reason\":\"worker:change\",\"ts\":1700000000000,\"payload\":{\"workerId\":\"w1\",\"state\":\"IDLE\"}}\n\n",
            // No payload: the key is left out, as JSON.stringify drops undefined.
            "id: 0123456789ab-2\nevent: change\ndata: {\"reason\":\"worker:removed\",\"ts\":1700000000000}\n\n",
            // A pre-serialized payload with line breaks still sits on one data line.
            "id: 0123456789ab-3\nevent: change\ndata: {\"reason\":\"plugin:clock:\\\"tick\\\"\",\"ts\":1700000000000,\"payload\":{\"t\":1}}\n\n",
        ]
    );
    assert_eq!(h.hub.current_id(), "0123456789ab-3");
}

#[tokio::test]
async fn greets_a_fresh_client_with_the_current_id_and_stamps_every_event() {
    let h = harness(quiet());
    h.broadcast("worker:change", json!({ "n": 1 })).await;
    let mut r = h.attach(AttachOptions::default());
    r.drain().await;
    assert!(r.has("hello"), "hello carries the resume point");
    assert_eq!(r.last_id(), h.hub.current_id());
    h.broadcast("worker:change", json!({ "n": 2 })).await;
    r.drain().await;
    assert_eq!(r.last_id(), h.hub.current_id());
}

#[tokio::test]
async fn replays_exactly_what_a_reconnecting_client_missed_then_goes_live() {
    let h = harness(quiet());
    let mut first = h.attach(AttachOptions::default());
    h.broadcast("pty:data", json!({ "n": 1 })).await;
    first.drain().await;
    let since = first.last_id();
    drop(first); // link drops
    h.broadcast("pty:data", json!({ "n": 2 })).await;
    h.broadcast("pty:data", json!({ "n": 3 })).await;

    let mut again = h.attach(AttachOptions { since: Some(since), ..AttachOptions::default() });
    h.broadcast("pty:data", json!({ "n": 4 })).await;
    again.drain().await;
    assert_eq!(again.payloads(), [json!({ "n": 2 }), json!({ "n": 3 }), json!({ "n": 4 })]);
    assert!(!again.has("resync"));
    assert!(!again.has("hello"), "a resumed stream gets its replay, not a greeting");
    assert_eq!(&again.frames[..2], ["retry: 2000\n\n", ":connected\n\n"]);
}

#[tokio::test]
async fn sends_resync_when_the_gap_is_older_than_the_ring_or_from_another_run() {
    let h = harness(StreamOptions { ring_max_events: 2, ..quiet() });
    let mut r = h.attach(AttachOptions::default());
    r.drain().await;
    let since = r.last_id();
    for i in 0..5 {
        h.broadcast("worker:change", json!({ "i": i })).await;
    }

    let mut late = h.attach(AttachOptions { since: Some(since), ..AttachOptions::default() });
    late.drain().await;
    assert!(late.has("resync"), "the ring no longer covers the gap");
    assert_eq!(late.changes().len(), 0);
    assert_eq!(
        late.frames[2],
        "id: 0123456789ab-5\nevent: resync\ndata: {\"epoch\":\"0123456789ab\",\"seq\":5,\"caps\":[]}\n\n"
    );

    for stranger in
        ["deadbeef-3", "0123456789ab-99", "0123456789ab-99999999999999999999999", "garbage", "0123456789AB-1", "-1"]
    {
        let mut s = h.attach(AttachOptions { since: Some(stranger.into()), ..AttachOptions::default() });
        s.drain().await;
        assert!(s.has("resync"), "{stranger} ⇒ resync");
    }
    // The newest two are still in the ring.
    let mut near = h.attach(AttachOptions { since: Some("0123456789ab-3".into()), ..AttachOptions::default() });
    near.drain().await;
    assert_eq!(near.payloads(), [json!({ "i": 3 }), json!({ "i": 4 })]);
    // An empty resume point is no resume point.
    let mut empty = h.attach(AttachOptions { since: Some(String::new()), ..AttachOptions::default() });
    empty.drain().await;
    assert!(empty.has("hello"));
}

#[tokio::test]
async fn a_client_that_is_up_to_date_resumes_with_nothing_to_replay() {
    let h = harness(quiet());
    h.broadcast("worker:change", json!({ "n": 1 })).await;
    let mut r = h.attach(AttachOptions { since: Some(h.hub.current_id()), ..AttachOptions::default() });
    r.drain().await;
    assert_eq!(r.frames, ["retry: 2000\n\n", ":connected\n\n"]);
    // Before any event at all, id …-0 is replayable too.
    let fresh = harness(quiet());
    let mut r = fresh.attach(AttachOptions { since: Some("0123456789ab-0".into()), ..AttachOptions::default() });
    r.drain().await;
    assert!(!r.has("resync"));
}

#[tokio::test]
async fn hello_is_the_greeting_a_stream_opened_now_gets_and_resuming_from_it_misses_nothing() {
    let h = harness(StreamOptions { caps: vec!["state:patch".into()], ..quiet() });
    h.broadcast("worker:change", json!({ "n": 1 })).await;
    let hello = h.hub.hello();
    let mut fresh = h.attach(AttachOptions::default());
    fresh.drain().await;
    assert_eq!(fresh.frames[2], format!("id: 0123456789ab-1\nevent: hello\ndata: {hello}\n\n"));
    assert_eq!(hello, r#"{"epoch":"0123456789ab","seq":1,"caps":["state:patch"]}"#);

    // What a page read after `hello` is covered: a stream opened later from it replays the rest.
    h.broadcast("worker:change", json!({ "n": 2 })).await;
    let data: Value = serde_json::from_str(&hello).expect("json");
    let since = format!("{}-{}", data["epoch"].as_str().expect("epoch"), data["seq"]);
    let mut resumed = h.attach(AttachOptions { since: Some(since), ..AttachOptions::default() });
    resumed.drain().await;
    assert_eq!(resumed.payloads(), [json!({ "n": 2 })]);
}

#[tokio::test]
async fn filters_by_topic_and_topic_family() {
    let h = harness(quiet());
    let mut r = h.attach(AttachOptions {
        topics: Some(vec!["worker:*".into(), "notification:fire".into()]),
        ..AttachOptions::default()
    });
    h.broadcast("worker:change", json!({ "a": 1 })).await;
    h.broadcast("pty:data", json!({ "a": 2 })).await;
    h.broadcast("notification:fire", json!({ "a": 3 })).await;
    h.broadcast("agent:delta", json!({ "a": 4 })).await;
    r.drain().await;
    assert_eq!(r.payloads(), [json!({ "a": 1 }), json!({ "a": 3 })]);
}

fn tab(workers: &[&str], ptys: &[&str]) -> AttachOptions {
    AttachOptions {
        client_id: Some("tab".into()),
        focus: Some(StreamFocus {
            workers: workers.iter().map(|s| s.to_string()).collect(),
            ptys: ptys.iter().map(|s| s.to_string()).collect(),
        }),
        ..AttachOptions::default()
    }
}

#[tokio::test]
async fn streams_scoped_topics_only_for_what_the_tab_shows() {
    let h = harness(quiet());
    let mut focused = h.attach(tab(&["w1"], &["p1"]));
    let mut unfocused = h.attach(AttachOptions::default());
    h.broadcast("agent:delta", json!({ "workerId": "w1" })).await;
    h.broadcast("agent:delta", json!({ "workerId": "w2" })).await;
    h.broadcast("pty:data", json!({ "sessionId": "p2" })).await;
    h.broadcast("pty:data", json!({ "sessionId": "p1" })).await;
    h.broadcast("worker:change", json!({ "workerId": "w2" })).await;
    h.broadcast("genui:delta", json!({ "workerId": "w1", "callId": "c1" })).await;
    h.broadcast("genui:delta", json!({ "workerId": "w2", "callId": "c2" })).await;
    h.broadcast("genui:change", json!({ "viewId": "v_abcdefghijkl" })).await;
    // A scoped topic whose payload names nobody goes to every stream.
    h.broadcast("agent:delta", json!({ "text": "?" })).await;
    focused.drain().await;
    unfocused.drain().await;
    assert_eq!(
        focused.reasons(),
        ["agent:delta:w1", "pty:data:p1", "worker:change:w2", "genui:delta:w1", "genui:change:", "agent:delta:"]
    );
    assert_eq!(unfocused.changes().len(), 9, "a tab that declared nothing gets everything");
}

#[tokio::test]
async fn set_focus_applies_from_the_next_event_and_the_replay_follows_the_focus_too() {
    let h = harness(quiet());
    let mut r = h.attach(tab(&[], &[]));
    let since = h.hub.current_id();
    h.broadcast("agent:delta", json!({ "workerId": "w1" })).await;
    h.hub.set_focus("tab", &StreamFocus { workers: vec!["w1".into()], ptys: vec![] });
    h.broadcast("agent:delta", json!({ "workerId": "w1" })).await;
    r.drain().await;
    assert_eq!(r.changes().len(), 1);

    let mut again = h.attach(AttachOptions { since: Some(since), ..tab(&["w2"], &[]) });
    again.drain().await;
    assert_eq!(again.changes().len(), 0, "w1's deltas are not replayed to a tab now showing w2");
}

#[tokio::test]
async fn a_tabs_focus_goes_with_its_last_stream_and_stray_focus_is_bounded() {
    let h = harness(quiet());
    let gone = Arc::new(Mutex::new(Vec::new()));
    let log = gone.clone();
    h.hub.on_client_gone(move |tab| log.lock().expect("gone").push(tab.to_owned()));

    let a = h.attach(tab(&["w1"], &[]));
    let b = h.attach(tab(&["w1"], &[]));
    assert_eq!((h.hub.size(), h.hub.focused_tabs()), (2, 1));
    drop(a);
    assert_eq!(h.hub.focused_tabs(), 1, "the tab still has a stream");
    drop(b);
    assert_eq!((h.hub.size(), h.hub.focused_tabs()), (0, 0));
    assert_eq!(*gone.lock().expect("gone"), ["tab", "tab"]);

    // Focus sent for tabs with no stream: only the newest are kept.
    for i in 0..300 {
        h.hub.set_focus(&format!("ghost-{i}"), &StreamFocus::default());
    }
    assert_eq!(h.hub.focused_tabs(), 256);
    let anonymous = h.attach(AttachOptions { client_id: Some(String::new()), ..AttachOptions::default() });
    drop(anonymous);
    assert_eq!(gone.lock().expect("gone").len(), 2, "an empty client id is no tab");
}

#[tokio::test]
async fn a_client_that_falls_too_far_behind_is_ended_and_replays_on_reconnect() {
    let h = harness(StreamOptions { client_max_frames: 3, ..quiet() });
    let mut slow = h.attach(AttachOptions::default());
    let mut fast = h.attach(AttachOptions::default());
    for n in 0..3 {
        h.broadcast("x", json!({ "n": n })).await;
        fast.drain().await;
    }
    assert_eq!(h.hub.size(), 2);
    // The fourth unread frame is one too many: the slow client is recycled.
    h.broadcast("x", json!({ "n": 3 })).await;
    h.broadcast("x", json!({ "n": 4 })).await;
    assert_eq!(h.hub.size(), 1, "it left the hub the moment it missed an event");
    assert!(fast.drain().await);
    assert_eq!(fast.changes().len(), 5, "a healthy client is unaffected by a slow one");

    assert!(!slow.drain().await, "the stream ends instead of resuming with a hole");
    assert_eq!(
        slow.payloads(),
        [json!({ "n": 0 }), json!({ "n": 1 }), json!({ "n": 2 })],
        "what was queued still arrives"
    );
    let mut again = h.attach(AttachOptions { since: Some(slow.last_id()), ..AttachOptions::default() });
    again.drain().await;
    assert_eq!(again.payloads(), [json!({ "n": 3 }), json!({ "n": 4 })]);
}

#[tokio::test]
async fn the_byte_budget_bounds_a_slow_client_too_and_a_replay_does_not_count_against_it() {
    let h = harness(StreamOptions { client_max_bytes: 500, ..quiet() });
    let big = "x".repeat(150);
    let mut slow = h.attach(AttachOptions::default());
    for _ in 0..3 {
        h.broadcast("x", json!({ "blob": big })).await;
    }
    assert_eq!(h.hub.size(), 0, "two frames fit in 500 bytes, the third does not");
    assert!(!slow.drain().await);
    assert_eq!(slow.changes().len(), 2);

    // A replay larger than the budget is owed in full; live events queue behind it.
    let mut resumed = h.attach(AttachOptions { since: Some("0123456789ab-0".into()), ..AttachOptions::default() });
    h.broadcast("x", json!({ "n": "live" })).await;
    assert_eq!(h.hub.size(), 1);
    assert!(resumed.drain().await);
    assert_eq!(resumed.changes().len(), 4);

    // One frame over the whole budget still reaches a client that has caught up.
    h.broadcast("x", json!({ "blob": "y".repeat(1000) })).await;
    assert!(resumed.drain().await);
    assert_eq!(resumed.changes().len(), 5);
}

#[tokio::test]
async fn the_ring_is_bounded_by_count_and_by_bytes() {
    let h = harness(StreamOptions { ring_max_events: 10, ring_max_bytes: 2_000, ..quiet() });
    for i in 0..50 {
        h.broadcast("x", json!({ "i": i })).await;
    }
    assert_eq!(h.hub.ring_len().0, 10);
    for _ in 0..20 {
        h.broadcast("x", json!({ "blob": "z".repeat(600) })).await;
    }
    let (events, bytes) = h.hub.ring_len();
    assert!(events <= 3 && bytes <= 2_000, "{events} events, {bytes} bytes");
    // One event larger than the whole budget is still kept (alone).
    h.broadcast("x", json!({ "blob": "z".repeat(5_000) })).await;
    assert_eq!(h.hub.ring_len().0, 1);
}

#[tokio::test(start_paused = true)]
async fn keeps_an_idle_stream_warm() {
    let h = harness(StreamOptions { keepalive: Duration::from_secs(25), ..StreamOptions::default() });
    let Ok(Body::Stream(mut stream)) = h.hub.attach(AttachOptions::default()) else { panic!("a stream body") };
    for _ in 0..3 {
        stream.next().await.expect("preamble").expect("frame");
    }
    let started = tokio::time::Instant::now();
    for _ in 0..2 {
        assert_eq!(stream.next().await.expect("keepalive").expect("frame").as_ref(), b":ka\n\n");
    }
    assert_eq!(started.elapsed(), Duration::from_secs(50));
}

#[tokio::test]
async fn thousands_of_attach_and_detach_cycles_leave_nothing_behind() {
    let h = harness(quiet());
    let subscribers = h.bus.subscriber_count();
    for i in 0..5_000 {
        let mut r = h.attach(AttachOptions {
            client_id: Some(format!("tab-{}", i % 7)),
            focus: Some(StreamFocus::default()),
            ..AttachOptions::default()
        });
        if i % 500 == 0 {
            h.broadcast("worker:change", json!({ "i": i })).await;
            r.drain().await;
        }
    }
    assert_eq!(h.hub.size(), 0);
    assert_eq!(h.hub.focused_tabs(), 0);
    assert_eq!(h.bus.subscriber_count(), subscribers, "the hub is one bus subscriber however many streams come and go");
}

#[tokio::test]
async fn close_ends_every_stream_after_what_it_has_queued() {
    let h = harness(quiet());
    let mut r = h.attach(AttachOptions::default());
    h.broadcast("worker:change", json!({ "n": 1 })).await;
    h.hub.close();
    assert!(!r.drain().await);
    assert_eq!(r.changes().len(), 1);
    assert_eq!(h.hub.size(), 0);
    let mut late = h.attach(AttachOptions::default());
    assert!(!late.drain().await, "a stream opened during shutdown ends at once");
}

struct Redact;
impl DisplayFilter for Redact {
    fn filter(&self, _topic: &str, payload: &Bytes) -> Option<Bytes> {
        let text = std::str::from_utf8(payload).ok()?;
        text.contains("<agent_message>").then(|| Bytes::from(text.replace("<agent_message>", "")))
    }
}

#[tokio::test]
async fn frames_the_display_copy_of_a_payload() {
    let h = harness(StreamOptions { display_filter: Some(Arc::new(Redact)), ..quiet() });
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = seen.clone();
    let _sub = h.bus.on("worker:report", move |ev| {
        // The bus payload is untouched: only the stream shows the display copy.
        assert!(ev.payload.windows(15).any(|w| w == b"<agent_message>"));
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let mut r = h.attach(AttachOptions::default());
    h.broadcast("worker:report", json!({ "text": "<agent_message>hi" })).await;
    r.drain().await;
    assert_eq!(r.payloads(), [json!({ "text": "hi" })]);
    assert_eq!(seen.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_routes_open_a_stream_and_update_focus() {
    let h = harness(StreamOptions { caps: vec!["state:patch".into()], ..quiet() });
    let live = LiveText::new(&h.bus);
    let router = Router::builder().routes(routes::routes(h.hub.clone(), live)).build().expect("valid routes");

    let res = router.handle(Request::new(Method::Get, "/stream?topics=pages:*", Caller::UNTRUSTED)).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header_value("content-type"), Some("text/event-stream"));
    assert_eq!(res.header_value("cache-control"), Some("no-cache, no-transform"));
    assert_eq!(res.header_value("x-accel-buffering"), Some("no"));
    let Body::Stream(stream) = res.body else { panic!("a stream body") };
    let mut r = Reader { stream, frames: Vec::new() };
    h.broadcast("pages:change", json!({ "id": "p1" })).await;
    h.broadcast("worker:change", json!({ "id": "w1" })).await;
    r.drain().await;
    assert!(r.has("hello"));
    assert_eq!(r.payloads(), [json!({ "id": "p1" })]);
    let since = r.last_id();
    drop(r);
    assert_eq!(h.hub.size(), 0, "dropping the response body detaches the stream");

    // A native EventSource retry resumes through Last-Event-ID; ?since wins when both are there.
    h.broadcast("pages:change", json!({ "id": "p2" })).await;
    let res =
        router.handle(Request::new(Method::Get, "/stream", Caller::DASHBOARD).header("Last-Event-ID", &since)).await;
    let Body::Stream(stream) = res.body else { panic!("a stream body") };
    let mut r = Reader { stream, frames: Vec::new() };
    r.drain().await;
    assert_eq!(r.payloads(), [json!({ "id": "w1" }), json!({ "id": "p2" })]);

    // Focus: the answer seeds the panes that came into view.
    let delta = json!({ "workerId": "w1", "channel": "text", "phase": "start", "blockId": "b1", "text": "so far" });
    h.bus.publish_raw(topics::AGENT_DELTA, Some(Scope::worker("w1")), Bytes::from(delta.to_string()));
    h.bus.flush().await;
    let body = json!({ "clientId": "tab", "workers": ["w1", "w2"], "ptys": [] }).to_string();
    let res = router.handle(Request::new(Method::Post, "/stream/focus", Caller::DASHBOARD).body(body)).await;
    assert_eq!(res.status, 200);
    let answer = String::from_utf8(res.body.collect().await.expect("bytes").to_vec()).expect("utf-8");
    assert_eq!(answer, r#"{"live":[{"workerId":"w1","blockId":"b1","channel":"text","text":"so far"}]}"#);
    assert_eq!(h.hub.focused_tabs(), 1);

    let bad = json!({ "clientId": "", "workers": [], "ptys": [] }).to_string();
    let res = router.handle(Request::new(Method::Post, "/stream/focus", Caller::DASHBOARD).body(bad)).await;
    assert_eq!(res.status, 400);
    let phone = Caller::Phone { grant: crate::access::Tier::High, mutate: true };
    assert_eq!(router.handle(Request::new(Method::Get, "/stream", phone)).await.status, 403);
}

#[tokio::test]
async fn refuses_one_stream_too_many() {
    let h = harness(StreamOptions { max_clients: 2, ..quiet() });
    let router =
        Router::builder().routes(routes::routes(h.hub.clone(), LiveText::new(&h.bus))).build().expect("valid routes");
    let a = h.attach(AttachOptions::default());
    let _b = h.attach(AttachOptions::default());
    assert_eq!(h.hub.attach(AttachOptions::default()).err(), Some(TooManyStreams(2)));
    let res = router.handle(Request::new(Method::Get, "/stream", Caller::DASHBOARD)).await;
    assert_eq!(res.status, 503);
    drop(a);
    assert!(h.hub.attach(AttachOptions::default()).is_ok(), "a closed stream frees its place");
}
