use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::*;
use crate::seams::SystemClock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Change {
    n: u64,
}

const CHANGE: Topic<Change> = Topic::new("worker:change");
const OTHER: Topic<Change> = Topic::new("pages:change");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    worker_id: String,
    channel: &'static str,
    phase: &'static str,
    block_id: &'static str,
    text: String,
}
const DELTA: Topic<Delta> = Topic::scoped("agent:delta", ScopeKind::Worker, |d| Some(d.worker_id.as_str()));

fn bus() -> Bus {
    Bus::new(Ordered::new(), Arc::new(SystemClock), BusOptions { delta_window: None })
}

fn recorder(bus: &Bus, filter: impl Into<Filter>, tag: &'static str, log: &Arc<Mutex<Vec<String>>>) -> Subscription {
    let log = log.clone();
    bus.on(filter, move |ev| {
        log.lock().expect("log").push(format!("{tag}:{}:{}", ev.topic, String::from_utf8_lossy(&ev.payload)))
    })
}

#[tokio::test]
async fn delivers_to_a_topics_subscribers_first_then_to_those_of_everything() {
    let bus = bus();
    let log = Arc::new(Mutex::new(Vec::new()));
    let _all = recorder(&bus, Filter::All, "all", &log);
    let _a = recorder(&bus, &CHANGE, "a", &log);
    let _b = recorder(&bus, &CHANGE, "b", &log);
    let _other = recorder(&bus, &OTHER, "other", &log);
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.flush().await;
    assert_eq!(
        *log.lock().expect("log"),
        [r#"a:worker:change:{"n":1}"#, r#"b:worker:change:{"n":1}"#, r#"all:worker:change:{"n":1}"#]
    );
}

#[tokio::test]
async fn every_subscriber_shares_one_serialized_payload() {
    let bus = bus();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let subs: Vec<_> = (0..5)
        .map(|_| {
            let seen = seen.clone();
            bus.on(Filter::All, move |ev| seen.lock().expect("seen").push(ev.payload.as_ptr() as usize))
        })
        .collect();
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.flush().await;
    let seen = seen.lock().expect("seen");
    assert_eq!(seen.len(), 5);
    assert!(seen.iter().all(|p| *p == seen[0]), "the payload was copied");
    drop(subs);
}

#[tokio::test]
async fn a_publish_on_the_lane_has_reached_every_handler_when_it_returns() {
    let bus = bus();
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let _sub = bus.on(&CHANGE, move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let (publisher, count_in_job) = (bus.clone(), count.clone());
    let seen_inside = bus
        .lane()
        .run(move || {
            publisher.publish(&CHANGE, &Change { n: 1 });
            count_in_job.load(Ordering::SeqCst)
        })
        .await
        .expect("ran");
    assert_eq!(seen_inside, 1);
}

#[tokio::test]
async fn a_panicking_handler_does_not_stop_the_others() {
    let bus = bus();
    let log = Arc::new(Mutex::new(Vec::new()));
    let _bad = bus.on(&CHANGE, |_| panic!("bad subscriber"));
    let _good = recorder(&bus, &CHANGE, "good", &log);
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.publish(&CHANGE, &Change { n: 2 });
    bus.flush().await;
    assert_eq!(log.lock().expect("log").len(), 2);
}

#[tokio::test]
async fn an_event_published_by_a_handler_goes_out_after_the_one_being_delivered() {
    let bus = bus();
    let log = Arc::new(Mutex::new(Vec::new()));
    let republisher = bus.clone();
    let _react = bus.on(&CHANGE, move |ev| {
        let n = ev.payload_as::<Change>().expect("payload").n;
        republisher.publish(&OTHER, &Change { n: n * 10 });
    });
    let _all = recorder(&bus, Filter::All, "all", &log);
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.publish(&CHANGE, &Change { n: 2 });
    bus.flush().await;
    // Every subscriber — the stream included — sees the cause before its effect.
    assert_eq!(
        *log.lock().expect("log"),
        [
            r#"all:worker:change:{"n":1}"#,
            r#"all:pages:change:{"n":10}"#,
            r#"all:worker:change:{"n":2}"#,
            r#"all:pages:change:{"n":20}"#
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_state_change_and_its_event_stay_in_order_under_concurrency() {
    let bus = bus();
    let state = Arc::new(AtomicU64::new(0));
    let seen = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
    let (state_seen, log) = (state.clone(), seen.clone());
    let _sub = bus.on(&CHANGE, move |ev| {
        let announced = ev.payload_as::<Change>().expect("payload").n;
        log.lock().expect("seen").push((announced, state_seen.load(Ordering::SeqCst)));
    });

    const THREADS: u64 = 8;
    const EACH: u64 = 500;
    let mut workers = Vec::new();
    for _ in 0..THREADS {
        let (bus, state) = (bus.clone(), state.clone());
        workers.push(std::thread::spawn(move || {
            for _ in 0..EACH {
                let (publisher, state) = (bus.clone(), state.clone());
                // The transition and its announcement are one lane job.
                bus.lane()
                    .post(move || {
                        let n = state.load(Ordering::SeqCst) + 1;
                        state.store(n, Ordering::SeqCst);
                        publisher.publish(&CHANGE, &Change { n });
                    })
                    .expect("lane is running");
            }
        }));
    }
    for w in workers {
        w.join().expect("worker");
    }
    bus.flush().await;

    let seen = seen.lock().expect("seen");
    assert_eq!(seen.len() as u64, THREADS * EACH);
    for (i, &(announced, state_then)) in seen.iter().enumerate() {
        assert_eq!(announced, i as u64 + 1, "events arrived out of transition order");
        assert_eq!(state_then, announced, "a handler saw a state other than the one its event announced");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_threads_publishes_keep_their_order() {
    let bus = bus();
    let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
    let log = seen.clone();
    let _sub =
        bus.on(Filter::All, move |ev| log.lock().expect("seen").push(ev.payload_as::<Change>().expect("payload").n));
    let mut workers = Vec::new();
    for t in 0..4u64 {
        let bus = bus.clone();
        workers.push(std::thread::spawn(move || {
            for i in 0..1000u64 {
                bus.publish(&CHANGE, &Change { n: t * 1_000_000 + i });
            }
        }));
    }
    for w in workers {
        w.join().expect("worker");
    }
    bus.flush().await;
    let seen = seen.lock().expect("seen");
    assert_eq!(seen.len(), 4000);
    let mut next = [0u64; 4];
    for n in seen.iter() {
        let (t, i) = ((n / 1_000_000) as usize, n % 1_000_000);
        assert_eq!(i, next[t]);
        next[t] += 1;
    }
}

#[tokio::test]
async fn dropping_a_subscription_removes_it_and_leaves_nothing_behind() {
    let bus = bus();
    let hits = Arc::new(AtomicUsize::new(0));
    for round in 0..5_000 {
        let h = hits.clone();
        let topic: TopicName =
            if round % 2 == 0 { "worker:change".into() } else { format!("plugin:p{round}:tick").into() };
        let sub = bus.on(topic, move |_| {
            h.fetch_add(1, Ordering::SeqCst);
        });
        let all = bus.on(Filter::All, |_| {});
        let queue = bus.subscribe(Filter::All, 4);
        assert_eq!(bus.subscriber_count(), 3);
        drop((sub, all, queue));
    }
    assert_eq!(bus.subscriber_count(), 0);
    assert_eq!(bus.subscribed_topics(), 0, "an emptied topic left its entry behind");
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.flush().await;
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    let kept = Arc::new(AtomicUsize::new(0));
    let k = kept.clone();
    bus.on(&CHANGE, move |_| {
        k.fetch_add(1, Ordering::SeqCst);
    })
    .forever();
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.flush().await;
    assert_eq!(kept.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_slow_queue_subscriber_loses_events_and_is_told() {
    let bus = bus();
    let mut rx = bus.subscribe(&CHANGE, 2);
    for n in 0..5 {
        bus.publish(&CHANGE, &Change { n });
    }
    bus.flush().await;
    assert_eq!(rx.recv().await, Err(RecvError::Lagged(3)));
    assert_eq!(rx.recv().await.expect("queued").payload_as::<Change>().expect("payload"), Change { n: 0 });
    assert_eq!(rx.recv().await.expect("queued").payload_as::<Change>().expect("payload"), Change { n: 1 });
    bus.publish(&CHANGE, &Change { n: 9 });
    assert_eq!(rx.recv().await.expect("live").payload_as::<Change>().expect("payload"), Change { n: 9 });
}

#[tokio::test]
async fn scoped_topics_carry_what_they_are_about_and_raw_topics_pass_through() {
    let bus = bus();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let _sub = bus.on(Filter::All, move |ev| log.lock().expect("seen").push(ev.clone()));
    bus.publish(
        &DELTA,
        &Delta { worker_id: "w1".into(), channel: "text", phase: "start", block_id: "b", text: "hi".into() },
    );
    bus.publish_raw(String::from("plugin:clock:tick"), None, Bytes::from_static(br#"{"t":1}"#));
    bus.publish_raw("worker:removed", None, Bytes::new());
    bus.flush().await;
    let seen = seen.lock().expect("seen");
    assert_eq!(seen[0].scope, Some(Scope::worker("w1")));
    assert_eq!(
        seen[0].payload.as_ref(),
        br#"{"workerId":"w1","channel":"text","phase":"start","blockId":"b","text":"hi"}"#
    );
    assert_eq!((seen[1].topic.as_str(), seen[1].scope.clone()), ("plugin:clock:tick", None));
    assert!(seen[2].payload.is_empty());
    assert_eq!(CHANGE.decl(), TopicDecl { name: "worker:change", scope: None });
    assert_eq!(DELTA.decl().scope, Some(ScopeKind::Worker));
}

#[tokio::test]
async fn coalesces_deltas_over_real_windows() {
    // Long enough that a busy machine does not close it between two lines here.
    const WINDOW: Duration = Duration::from_millis(100);
    let bus = Bus::new(Ordered::new(), Arc::new(SystemClock), BusOptions { delta_window: Some(WINDOW) });
    let texts = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = texts.clone();
    let _sub = bus.on(Filter::All, move |ev| {
        let v: serde_json::Value = ev.payload_as().expect("json");
        log.lock().expect("texts").push(format!("{}:{}", ev.topic, v["text"].as_str().unwrap_or("")));
    });
    let delta = |phase: &'static str, text: &str| Delta {
        worker_id: "w1".into(),
        channel: "text",
        phase,
        block_id: "b",
        text: text.into(),
    };
    bus.publish(&DELTA, &delta("start", "He"));
    bus.publish(&DELTA, &delta("append", "l"));
    bus.publish(&DELTA, &delta("append", "lo"));
    bus.flush().await;
    assert_eq!(*texts.lock().expect("texts"), ["agent:delta:He"], "the first token is not delayed");
    let waiting = std::time::Instant::now();
    while texts.lock().expect("texts").len() < 2 && waiting.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(*texts.lock().expect("texts"), ["agent:delta:He", "agent:delta:llo"]);

    // Held text never trails the event that follows it.
    bus.publish(&DELTA, &delta("append", "!"));
    bus.publish(&CHANGE, &Change { n: 1 });
    bus.flush().await;
    assert_eq!(texts.lock().expect("texts")[2..], ["agent:delta:!", "worker:change:"]);
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(texts.lock().expect("texts").len(), 4, "an idle window sends nothing");
}
