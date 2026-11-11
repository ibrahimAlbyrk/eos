//! Small benchmarks of the hot paths: `cargo bench -p eos-runtime`.
//! Plain timings (no statistics): they are for spotting an order-of-magnitude
//! regression, not for comparing percent changes.

use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use eos_runtime::access::{Access, Caller, Tier};
use eos_runtime::bus::{Bus, BusOptions, Filter, Topic};
use eos_runtime::http::{ApiError, Body, Method, Request, Response};
use eos_runtime::ordered::Ordered;
use eos_runtime::router::{RouteDef, Router};
use eos_runtime::seams::{RandomIds, SystemClock};
use eos_runtime::stream::{AttachOptions, StreamHub, StreamOptions};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerChange {
    worker_id: &'static str,
    state: &'static str,
    cost_usd: f64,
    tokens: u64,
}

const WORKER_CHANGE: Topic<WorkerChange> = Topic::new("worker:change");
const SAMPLE: WorkerChange = WorkerChange { worker_id: "w-abcdefgh", state: "WORKING", cost_usd: 1.25, tokens: 48_213 };

fn bus() -> Bus {
    Bus::new(Ordered::new(), Arc::new(SystemClock), BusOptions { delta_window: None })
}

fn per(total: Duration, n: u64) -> String {
    let nanos = total.as_nanos() as f64 / n as f64;
    if nanos >= 1_000_000.0 {
        format!("{:.2} ms", nanos / 1_000_000.0)
    } else if nanos >= 1_000.0 {
        format!("{:.2} µs", nanos / 1_000.0)
    } else {
        format!("{nanos:.0} ns")
    }
}

/// One event to N bus handlers: publish (serialize once) → every handler ran.
async fn fan_out_handlers(subscribers: usize, events: u64) {
    let bus = bus();
    let hits = Arc::new(AtomicU64::new(0));
    let subs: Vec<_> = (0..subscribers)
        .map(|_| {
            let hits = hits.clone();
            bus.on(Filter::All, move |ev| {
                hits.fetch_add(ev.payload.len() as u64, Ordering::Relaxed);
            })
        })
        .collect();
    let began = Instant::now();
    for _ in 0..events {
        bus.publish(&WORKER_CHANGE, &SAMPLE);
    }
    bus.flush().await;
    let took = began.elapsed();
    assert!(hits.load(Ordering::Relaxed) > 0);
    println!(
        "fan-out  bus handlers   N={subscribers:<5} {:>10} per event  ({} per delivery)",
        per(took, events),
        per(took, events * subscribers as u64)
    );
    drop(subs);
}

/// One event to N stream clients: publish → framed once → queued for each.
async fn fan_out_streams(clients: usize, events: u64) {
    let bus = bus();
    let options = StreamOptions {
        client_max_frames: usize::MAX,
        client_max_bytes: usize::MAX,
        max_clients: clients,
        ..StreamOptions::default()
    };
    let hub = StreamHub::new(&bus, &RandomIds::default(), options);
    let bodies: Vec<Body> = (0..clients).filter_map(|_| hub.attach(AttachOptions::default()).ok()).collect();
    assert_eq!(bodies.len(), clients);
    let began = Instant::now();
    for _ in 0..events {
        bus.publish(&WORKER_CHANGE, &SAMPLE);
    }
    bus.flush().await;
    let took = began.elapsed();
    println!(
        "fan-out  stream clients N={clients:<5} {:>10} per event  ({} per delivery)",
        per(took, events),
        per(took, events * clients as u64)
    );
    drop(bodies);
    assert_eq!(hub.size(), 0);
}

async fn ok(_req: Request) -> Result<Response, ApiError> {
    Ok(Response::new(204))
}

/// A route table the size and shape of today's (~310 routes).
fn route_table() -> Router {
    let mut builder = Router::builder();
    let access = Access::open().phone(Tier::Read);
    for area in ["workers", "orchestrators", "pending", "pty", "terminal"] {
        builder = builder.route(RouteDef::get(format!("/{area}"), ok).access(access));
        builder = builder.route(RouteDef::get(format!("/{area}/{{id}}"), ok).access(access));
        for verb in [
            "events",
            "queue",
            "diff",
            "changes",
            "conflicts",
            "memory",
            "peers",
            "message",
            "interrupt",
            "resume",
            "archive",
            "restore",
        ] {
            builder = builder.route(RouteDef::get(format!("/{area}/{{id}}/{verb}"), ok).access(access));
            builder = builder.route(RouteDef::post(format!("/{area}/{{id}}/{verb}"), ok).access(access));
        }
    }
    for feature in [
        "pages",
        "genui",
        "jobs",
        "sync",
        "transfers",
        "artifacts",
        "profile",
        "plugins",
        "settings",
        "templates",
        "accounts",
        "usage",
    ] {
        for verb in ["list", "read", "create", "update", "remove", "status", "refresh", "preview"] {
            builder = builder.route(RouteDef::get(format!("/api/{feature}/{verb}"), ok).access(access));
        }
        builder = builder.route(RouteDef::get(format!("/api/{feature}/{{id}}"), ok).access(access));
        builder = builder.route(RouteDef::put(format!("/api/{feature}/{{id}}/state"), ok).access(access));
    }
    builder = builder.route(RouteDef::get("/workers/{id}/workflow-runs/{callId}/agents/{agentId}", ok).access(access));
    builder = builder.route(RouteDef::get("/fs/raw/{*path}", ok).access(access));
    builder = builder.route(RouteDef::any("/h/{hostId}/{*rest}", ok).access(Access::open().local_only()));
    builder.build().expect("a valid table")
}

async fn router_match() {
    let router = route_table();
    let routes = router.routes().count();
    let targets = [
        (Method::Get, "/workers"),
        (Method::Get, "/workers/w-abcdefgh/events?limit=200&order=desc"),
        (Method::Post, "/pty/s-12345678/message"),
        (Method::Get, "/api/genui/abcdef0123456789"),
        (Method::Put, "/api/pages/pg-1/state"),
        (Method::Get, "/workers/w-abcdefgh/workflow-runs/toolu_01/agents/a7"),
        (Method::Get, "/fs/raw/Users/someone/Projects/app/src/main.rs"),
        (Method::Get, "/api/usage/status"),
        (Method::Get, "/nope/not/a/route"),
    ];
    const ROUNDS: u64 = 200_000;
    let began = Instant::now();
    let mut found = 0u64;
    for _ in 0..ROUNDS {
        for (method, target) in targets {
            found += u64::from(black_box(router.find(method, black_box(target))).is_some());
        }
    }
    let took = began.elapsed();
    assert_eq!(found, ROUNDS * (targets.len() as u64 - 1));
    println!("router   match          {routes} routes {:>8} per lookup", per(took, ROUNDS * targets.len() as u64));

    const REQUESTS: u64 = 200_000;
    let began = Instant::now();
    for i in 0..REQUESTS {
        let (method, target) = targets[i as usize % (targets.len() - 1)];
        let res = router.handle(Request::new(method, target, Caller::DASHBOARD)).await;
        black_box(res.status);
    }
    println!(
        "router   handle (trivial handler, ids, access, timing) {:>8} per request",
        per(began.elapsed(), REQUESTS)
    );
}

/// A reconnecting client that missed the whole ring: 5,000 events / 8 MB.
async fn replay_full_ring() {
    let bus = bus();
    let hub = StreamHub::new(&bus, &RandomIds::default(), StreamOptions::default());
    let first = hub.current_id();
    // ~1.6 KB per frame: 5,000 of them fill the 8 MB ring.
    let payload = Bytes::from(format!("{{\"workerId\":\"w-abcdefgh\",\"blob\":\"{}\"}}", "x".repeat(1_500)));
    for _ in 0..5_000 {
        bus.publish_raw("worker:change", None, payload.clone());
    }
    bus.flush().await;

    let began = Instant::now();
    let Ok(Body::Stream(mut stream)) = hub.attach(AttachOptions { since: Some(first), ..AttachOptions::default() })
    else {
        unreachable!()
    };
    let attached = began.elapsed();
    let (mut frames, mut bytes) = (0u64, 0usize);
    while frames < 5_002 {
        let Some(Ok(frame)) = stream.next().await else { break };
        frames += 1;
        bytes += frame.len();
    }
    let took = began.elapsed();
    assert_eq!(frames, 5_002, "preamble + 5,000 replayed events");
    println!(
        "stream   replay full ring  {} events, {:.1} MB: attach {:.2} ms, read all {:.2} ms ({} per frame)",
        frames - 2,
        bytes as f64 / (1024.0 * 1024.0),
        attached.as_secs_f64() * 1e3,
        took.as_secs_f64() * 1e3,
        per(took, frames)
    );
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("a runtime");
    runtime.block_on(async {
        for (n, events) in [(1, 200_000), (10, 100_000), (100, 20_000), (1_000, 2_000)] {
            fan_out_handlers(n, events).await;
        }
        for (n, events) in [(1, 200_000), (10, 100_000), (100, 10_000), (1_000, 1_000)] {
            fan_out_streams(n, events).await;
        }
        router_match().await;
        replay_full_ring().await;
    });
}
