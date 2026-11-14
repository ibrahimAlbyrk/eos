//! A long, mixed, seeded run of the whole app on a data folder (meant for a
//! copy of a real one, `scripts/private-copy.sh`), judged by whether the
//! process plateaus.
//!
//!   cargo run --release -p eos-app --example soak -- <data folder> [options]
//!
//!   --minutes N      how long (30)              --rate X      1 realistic, 10 ten times (1)
//!   --seed S         every choice follows it    --chats N     chats driven at once (3)
//!   --cwd DIR        the chats' folder (a new git repository by default)
//!   --sample-secs N  how often the process is measured (10)
//!   --csv FILE       the samples, one line each
//!   --leak-kb K      a deliberate leak of K KB a second: the rule must fail it
//!   --only A,B       only these actors: readers, writer, streams, chats
//!   --max-footprint-mb N   the footprint's ceiling (default: by rate, see the rule)
//!
//! What runs, all through the router: readers across every feature (lists,
//! transcript pages of the folder's chats, profile, plugins, jobs, …);
//! writes that are safe on a copy (pages with stale-revision conflicts,
//! memories, settings, plugin switches, templates, questions); event-stream
//! subscribers that lag, drop and resume where they were; chats on a
//! scripted engine (thinking, tools, subagents, background tasks, workflow
//! progress, long turns that are interrupted or queued behind, compaction at
//! the idle edge, side questions, renames, exports, archive, restore, purge).
//!
//! The rule (printed at the end; exit 1 when broken), over the samples after
//! a warm-up of the first quarter, cut into three windows: the floor of the
//! bytes the allocator holds out (each window's lowest sample, so an answer
//! in flight at a sample does not count) rises by at most 4 MB from the first
//! window to the last, or by at most 8 MB an hour; descriptors and threads end
//! within 8 of the warm-up's highest; no answer is a 5xx.
//!
//! The footprint (what Activity Monitor shows) never passes its ceiling after
//! the warm-up: 48 MB at the realistic rate, 64 MB from five times it. The app
//! runs with `MallocLargeCache=0` (its Info.plist), and so should a soak: with
//! the cache on, the allocator keeps large blocks it got back, up to its own
//! limit. Resident memory is printed, not judged.

#[path = "../tests/support/rig.rs"]
mod rig;

/// `--features mimalloc`: the run on the allocator the app binary may use.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use eos_app::App;
use eos_runtime::http::Method;
use eos_testkit::ScriptedRuntime;
use rig::{Rng, Sample};
use serde_json::{Value, json};

const MAX_FLOOR_RISE_MB: f64 = 4.0;
const MAX_FLOOR_RISE_MB_PER_HOUR: f64 = 8.0;
const MAX_FDS_ABOVE_WARM: usize = 8;
const MAX_THREADS_ABOVE_WARM: usize = 8;

struct Args {
    home: String,
    minutes: f64,
    rate: f64,
    seed: u64,
    chats: usize,
    cwd: Option<String>,
    sample_secs: u64,
    csv: Option<String>,
    leak_kb: usize,
    only: Option<String>,
    max_footprint_mb: Option<f64>,
}

fn args() -> Args {
    let mut it = std::env::args().skip(1);
    let Some(home) = it.next() else {
        eprintln!(
            "usage: soak <data folder> [--minutes N] [--rate X] [--seed S] [--chats N] [--cwd DIR] [--sample-secs N] [--csv FILE] [--leak-kb K]"
        );
        std::process::exit(2);
    };
    let mut a = Args {
        home,
        minutes: 30.0,
        rate: 1.0,
        seed: 1,
        chats: 3,
        cwd: None,
        sample_secs: 10,
        csv: None,
        leak_kb: 0,
        only: None,
        max_footprint_mb: None,
    };
    while let Some(flag) = it.next() {
        let value = it.next().unwrap_or_default();
        match flag.as_str() {
            "--minutes" => a.minutes = value.parse().unwrap_or(a.minutes),
            "--rate" => a.rate = value.parse().unwrap_or(a.rate),
            "--seed" => a.seed = value.parse().unwrap_or(a.seed),
            "--chats" => a.chats = value.parse().unwrap_or(a.chats),
            "--cwd" => a.cwd = Some(value),
            "--sample-secs" => a.sample_secs = value.parse().unwrap_or(a.sample_secs),
            "--csv" => a.csv = Some(value),
            "--leak-kb" => a.leak_kb = value.parse().unwrap_or(0),
            "--only" => a.only = Some(value),
            "--max-footprint-mb" => a.max_footprint_mb = value.parse().ok(),
            other => {
                eprintln!("soak: unknown option {other}");
                std::process::exit(2);
            }
        }
    }
    a
}

/// Latency and failures per kind of request.
#[derive(Default)]
struct Stats {
    routes: Mutex<HashMap<String, Route>>,
    slowest: Mutex<Vec<(Duration, String)>>,
    requests: AtomicU64,
    server_errors: AtomicU64,
}

#[derive(Default, Clone)]
struct Route {
    count: u64,
    total: Duration,
    max: Duration,
    errors_5xx: u64,
}

impl Stats {
    fn note(&self, label: &str, target: &str, status: u16, took: Duration) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        let mut routes = self.routes.lock().unwrap_or_else(|p| p.into_inner());
        let route = routes.entry(label.to_owned()).or_default();
        route.count += 1;
        route.total += took;
        route.max = route.max.max(took);
        if status >= 500 {
            route.errors_5xx += 1;
            self.server_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("5xx: {status} {target}");
        }
        drop(routes);
        let mut slowest = self.slowest.lock().unwrap_or_else(|p| p.into_inner());
        if slowest.len() < 10 || took > slowest[slowest.len() - 1].0 {
            slowest.push((took, target.chars().take(100).collect()));
            slowest.sort_by_key(|s| std::cmp::Reverse(s.0));
            slowest.truncate(10);
        }
    }
}

struct Ctx {
    app: App,
    agents: ScriptedRuntime,
    stats: Stats,
    stop: AtomicBool,
    rate: f64,
    cwd: String,
    /// Chats of the data folder, for transcript reads.
    chats: Vec<String>,
    turns: AtomicU64,
    frames: AtomicU64,
    resumes: AtomicU64,
    resyncs: AtomicU64,
}

impl Ctx {
    async fn call(&self, label: &str, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        let began = Instant::now();
        let (status, value) = rig::call(&self.app, method, target, body).await;
        self.stats.note(label, target, status, began.elapsed());
        (status, value)
    }

    /// A read whose answer is not looked at: only its bytes are taken.
    async fn read(&self, label: &str, target: &str) {
        let began = Instant::now();
        let (status, _) = rig::call_bytes(&self.app, rig::dashboard(&self.app), Method::Get, target, None).await;
        self.stats.note(label, target, status, began.elapsed());
    }

    /// Waits `base` divided by the rate, give or take a quarter.
    async fn pause(&self, rng: &mut Rng, base_ms: u64) {
        let ms = (base_ms as f64 / self.rate).max(1.0);
        let jitter = 0.75 + (rng.below(50) as f64) / 100.0;
        tokio::time::sleep(Duration::from_secs_f64(ms * jitter / 1000.0)).await;
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

async fn reader(cx: Arc<Ctx>, seed: u64) {
    let mut rng = Rng::new(seed);
    const LISTS: [&str; 22] = [
        "/workers",
        "/workers?brief=1",
        "/workers/archived",
        "/orchestrators",
        "/projects",
        "/fs/recents",
        "/api/pages",
        "/api/profile",
        "/api/user-memories",
        "/api/settings",
        "/api/settings/compaction",
        "/api/plugins",
        "/api/jobs",
        "/api/templates",
        "/worker-definitions",
        "/pending",
        "/api/accounts",
        "/api/usage",
        "/api/dreams",
        "/api/transfers",
        "/api/update",
        "/health",
    ];
    while !cx.stopped() {
        let target = match rng.below(10) {
            0..=4 => (*rng.pick(&LISTS)).to_owned(),
            5..=8 if !cx.chats.is_empty() => {
                let chat = rng.pick(&cx.chats).clone();
                match rng.below(5) {
                    0 => format!("/workers/{chat}/events?limit=500"),
                    1 => format!("/workers/{chat}/events?limit=50&order=asc"),
                    2 => format!("/workers/{chat}/subagent-events"),
                    3 => format!("/workers/{chat}/prompt-events"),
                    _ => format!("/workers/{chat}"),
                }
            }
            _ => "/api/user-memories/search?q=test".to_owned(),
        };
        // Chats read alike count as one route.
        let path = target.split('?').next().unwrap_or_default();
        let label = match path.strip_prefix("/workers/w-").or_else(|| path.strip_prefix("/workers/o-")) {
            Some(rest) => format!("GET /workers/{{id}}{}", rest.find('/').map_or("", |at| &rest[at..])),
            None => format!("GET {path}"),
        };
        cx.read(&label, &target).await;
        cx.pause(&mut rng, 200).await;
    }
}

async fn writer(cx: Arc<Ctx>, seed: u64) {
    let mut rng = Rng::new(seed);
    let plugins: Vec<String> = {
        let (_, list) = cx.call("GET /api/plugins", Method::Get, "/api/plugins", None).await;
        list["plugins"].as_array().into_iter().flatten().filter_map(|p| p["id"].as_str().map(str::to_owned)).collect()
    };
    let mut n = 0u64;
    while !cx.stopped() {
        n += 1;
        match rng.below(6) {
            0 => {
                let body =
                    json!({"title": format!("Soak page {n}"), "body": "- [ ] one\n- [ ] two\n", "project": cx.cwd});
                let (_, made) = cx.call("POST /api/pages", Method::Post, "/api/pages", Some(body)).await;
                if let (Some(id), Some(rev)) = (made["page"]["id"].as_str(), made["page"]["rev"].as_i64()) {
                    let path = format!("/api/pages/{id}");
                    let edit = json!({"op": "append", "text": "- [ ] three"});
                    cx.call("POST /api/pages/edit", Method::Post, &format!("{path}/edit"), Some(edit)).await;
                    // The user's save on a stale revision: a conflict, then a save on the new one.
                    let stale = json!({"title": "renamed", "baseRev": rev});
                    let (status, conflict) = cx.call("PUT /api/pages", Method::Put, &path, Some(stale)).await;
                    if status == 409 {
                        let rev = conflict["page"]["rev"].as_i64().unwrap_or(rev + 1);
                        cx.call(
                            "PUT /api/pages",
                            Method::Put,
                            &path,
                            Some(json!({"title": "renamed", "baseRev": rev})),
                        )
                        .await;
                    }
                    cx.call("DELETE /api/pages", Method::Delete, &path, None).await;
                }
            }
            1 => {
                let body = json!({"text": format!("Soak rule {n}: prefer small commits."), "category": "work-style", "scope": {"kind": "global"}});
                let (_, made) =
                    cx.call("POST /api/user-memories", Method::Post, "/api/user-memories", Some(body)).await;
                if let Some(id) = made["memory"]["id"].as_str() {
                    cx.call("DELETE /api/user-memories", Method::Delete, &format!("/api/user-memories/{id}"), None)
                        .await;
                }
            }
            2 => {
                let threshold = if n.is_multiple_of(2) { 0.8 } else { 0.85 };
                let body = json!({"threshold": threshold});
                cx.call("PUT /api/settings/compaction", Method::Put, "/api/settings/compaction", Some(body)).await;
                let theme = if n.is_multiple_of(2) { "dark" } else { "light" };
                let body = json!({"settings": {"appearance.theme": theme}});
                cx.call("PUT /api/settings", Method::Put, "/api/settings", Some(body)).await;
            }
            3 if !plugins.is_empty() => {
                let id = rng.pick(&plugins).clone();
                let path = format!("/api/plugins/{id}/enabled");
                cx.call("PUT /api/plugins/enabled", Method::Put, &path, Some(json!({"enabled": false}))).await;
                cx.call("PUT /api/plugins/enabled", Method::Put, &path, Some(json!({"enabled": true}))).await;
            }
            4 => {
                let name = format!("soak-{n}");
                let body = json!({"name": name, "content": "Review the diff.\n", "description": "soak"});
                cx.call("POST /api/templates", Method::Post, "/api/templates", Some(body)).await;
                let path = format!("/api/templates/{name}");
                cx.call("PUT /api/templates", Method::Put, &path, Some(json!({"content": "Review it again.\n"}))).await;
                cx.call("DELETE /api/templates", Method::Delete, &path, None).await;
            }
            _ => {}
        }
        cx.pause(&mut rng, 1000).await;
    }
}

async fn subscriber(cx: Arc<Ctx>, seed: u64, slow: bool) {
    let mut rng = Rng::new(seed);
    let mut since: Option<String> = None;
    while !cx.stopped() {
        let query = match (&since, rng.below(3)) {
            (Some(id), _) => format!("since={id}"),
            (None, 0) => "topics=worker:*,state:*".to_owned(),
            _ => String::new(),
        };
        if since.is_some() {
            cx.resumes.fetch_add(1, Ordering::Relaxed);
        }
        let Some(stream) = rig::open_stream(&cx.app, &query).await else { break };
        let mut frames = rig::Frames::new(stream);
        let until = Instant::now() + Duration::from_secs(5 + rng.below(25) as u64);
        while Instant::now() < until && !cx.stopped() {
            match frames.next(Duration::from_secs(1)).await {
                Some(frame) => {
                    cx.frames.fetch_add(1, Ordering::Relaxed);
                    if frame.get("reason").is_none() && frame.get("epoch").is_some() && query.starts_with("since") {
                        cx.resyncs.fetch_add(1, Ordering::Relaxed);
                    }
                }
                None => continue,
            }
            if slow {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        since = if rng.chance(70) { frames.last_id.clone() } else { None };
        cx.pause(&mut rng, 500).await;
    }
}

async fn state_of(cx: &Ctx, id: &str) -> String {
    let (_, row) = rig::call(&cx.app, Method::Get, &format!("/workers/{id}"), None).await;
    row["state"].as_str().unwrap_or("GONE").to_owned()
}

async fn until_settled(cx: &Ctx, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !cx.stopped() {
        if !matches!(state_of(cx, id).await.as_str(), "WORKING" | "SPAWNING" | "STARTING") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn chat_driver(cx: Arc<Ctx>, seed: u64) {
    let mut rng = Rng::new(seed);
    while !cx.stopped() {
        let body = json!({"mode": "focused", "cwd": cx.cwd, "prompt": "[reply] start"});
        let (status, created) = cx.call("POST /orchestrators", Method::Post, "/orchestrators", Some(body)).await;
        let Some(id) = created["id"].as_str().filter(|_| status == 201).map(str::to_owned) else {
            cx.pause(&mut rng, 2000).await;
            continue;
        };
        until_settled(&cx, &id).await;
        let turns = 10 + rng.below(30);
        for turn in 0..turns {
            if cx.stopped() {
                return;
            }
            let path = format!("/workers/{id}/message");
            let kind = *rng.pick(&rig::KINDS);
            match rng.below(20) {
                0 | 1 => {
                    // A message while the agent is busy waits for the turn to end.
                    cx.call("POST /workers/message", Method::Post, &path, Some(json!({"text": "[long] think"}))).await;
                    let queued = json!({"text": format!("[{kind}] then this"), "queueWhenBusy": true});
                    cx.call("POST /workers/message", Method::Post, &path, Some(queued)).await;
                }
                2 | 3 => {
                    cx.call("POST /workers/message", Method::Post, &path, Some(json!({"text": "[long] think"}))).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    cx.call("POST /workers/interrupt", Method::Post, &format!("/workers/{id}/interrupt"), None).await;
                }
                4 => {
                    let body = json!({"question": "What are you doing?"});
                    cx.call("POST /workers/btw", Method::Post, &format!("/workers/{id}/btw"), Some(body)).await;
                }
                5 => {
                    cx.call("GET /workers/export", Method::Get, &format!("/workers/{id}/export"), None).await;
                }
                6 => {
                    let body = json!({"name": format!("Soak chat {turn}")});
                    cx.call("PUT /workers/name", Method::Put, &format!("/workers/{id}/name"), Some(body)).await;
                }
                7 => {
                    cx.call("POST /workers/message", Method::Post, &path, Some(json!({"text": "[big] keep going"})))
                        .await;
                }
                _ => {
                    let body = json!({"text": format!("[{kind}] go on {turn}")});
                    cx.call("POST /workers/message", Method::Post, &path, Some(body)).await;
                }
            }
            cx.turns.fetch_add(1, Ordering::Relaxed);
            until_settled(&cx, &id).await;
            cx.pause(&mut rng, 5000).await;
        }
        // Done with this chat: archived, sometimes brought back first, then purged.
        cx.call("POST /workers/archive", Method::Post, &format!("/workers/{id}/archive"), None).await;
        if rng.chance(30) {
            cx.call("POST /workers/restore", Method::Post, &format!("/workers/{id}/restore"), None).await;
            cx.call("POST /workers/archive", Method::Post, &format!("/workers/{id}/archive"), None).await;
        }
        cx.call("DELETE /workers/purge", Method::Delete, &format!("/workers/{id}/purge"), None).await;
    }
}

fn mb(kb: u64) -> f64 {
    kb as f64 / 1024.0
}

/// The footprint's ceiling for a run at `rate`.
fn footprint_ceiling_mb(rate: f64) -> f64 {
    if rate >= 5.0 { 64.0 } else { 48.0 }
}

fn judge(samples: &[Sample], stats: &Stats, ceiling_mb: f64) -> Vec<String> {
    let mut broken = Vec::new();
    let warm_end = (samples.len() / 4).max(1);
    if samples.len() < warm_end + 3 {
        return vec!["too few samples to judge".into()];
    }
    let (warm, measured) = samples.split_at(warm_end);
    let third = measured.len() / 3;
    let windows = [&measured[..third], &measured[third..measured.len() - third], &measured[measured.len() - third..]];
    let floor = |w: &[Sample]| w.iter().map(|s| s.malloc_kb).min().unwrap_or(0);
    let middle = |w: &[Sample]| w.iter().map(|s| s.at_secs).sum::<f64>() / w.len().max(1) as f64;
    let rise = mb(floor(windows[2])) - mb(floor(windows[0]));
    let hours = (middle(windows[2]) - middle(windows[0])) / 3600.0;
    let rate = if hours > 0.0 { rise / hours } else { 0.0 };
    let last = &measured[measured.len() - 1];
    let warm_fds = warm.iter().map(|s| s.fds).max().unwrap_or(0);
    let warm_threads = warm.iter().map(|s| s.threads).max().unwrap_or(0);
    let rss: Vec<(f64, f64)> = measured.iter().map(|s| (s.at_secs / 3600.0, mb(s.rss_kb))).collect();
    println!(
        "rule: allocated floor {:.1} → {:.1} → {:.1} MB, rise {rise:+.1} MB ({rate:+.1} MB/h; ≤ {MAX_FLOOR_RISE_MB} MB or ≤ {MAX_FLOOR_RISE_MB_PER_HOUR} MB/h); fds {} vs {}, threads {} vs {}, 5xx {}",
        mb(floor(windows[0])),
        mb(floor(windows[1])),
        mb(floor(windows[2])),
        last.fds,
        warm_fds,
        last.threads,
        warm_threads,
        stats.server_errors.load(Ordering::Relaxed)
    );
    println!(
        "printed: rss {:.1} → {:.1} MB ({:+.1} MB/h), footprint {:.1} → {:.1} MB (peak {:.1})",
        mb(samples[0].rss_kb),
        mb(last.rss_kb),
        rig::slope(&rss),
        mb(samples[0].footprint_kb),
        mb(last.footprint_kb),
        mb(samples.iter().map(|s| s.footprint_kb).max().unwrap_or(0))
    );
    if rise > MAX_FLOOR_RISE_MB && rate > MAX_FLOOR_RISE_MB_PER_HOUR {
        broken.push(format!("the allocated floor rose {rise:.1} MB ({rate:.1} MB an hour)"));
    }
    let peak = measured.iter().map(|s| s.footprint_kb).max().unwrap_or(0);
    println!("rule: footprint after the warm-up peaks at {:.1} MB (ceiling {ceiling_mb} MB)", mb(peak));
    if mb(peak) > ceiling_mb {
        broken.push(format!("the footprint reached {:.1} MB, over its {ceiling_mb} MB ceiling", mb(peak)));
    }
    if last.fds > warm_fds + MAX_FDS_ABOVE_WARM {
        broken.push(format!("descriptors grew {warm_fds} → {}", last.fds));
    }
    if last.threads > warm_threads + MAX_THREADS_ABOVE_WARM {
        broken.push(format!("threads grew {warm_threads} → {}", last.threads));
    }
    if stats.server_errors.load(Ordering::Relaxed) > 0 {
        broken.push("some answers were 5xx".into());
    }
    broken
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let a = args();
    let agents = ScriptedRuntime::unlogged();
    agents.otherwise(rig::turn_for);
    let began = Instant::now();
    let app = rig::build(std::path::Path::new(&a.home), &agents);
    app.start().await.expect("the app starts");
    app.runtime().lifecycle.deferred_done().await;
    println!("cold start: {:.3?}", began.elapsed());

    let scratch = tempfile::tempdir().expect("a folder");
    let cwd = match &a.cwd {
        Some(dir) => dir.clone(),
        None => {
            let dir = scratch.path().canonicalize().expect("the folder");
            std::fs::write(dir.join("README.md"), "# soak\n").expect("a file");
            let _ = std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status();
            dir.to_string_lossy().into_owned()
        }
    };
    let (_, list) = rig::call(&app, Method::Get, "/workers?brief=1", None).await;
    let chats: Vec<String> =
        list.as_array().into_iter().flatten().filter_map(|w| w["id"].as_str().map(str::to_owned)).collect();
    println!("folder: {} chats; rate ×{}, {} driven chats, seed {}", chats.len(), a.rate, a.chats, a.seed);

    let cx = Arc::new(Ctx {
        app,
        agents,
        stats: Stats::default(),
        stop: AtomicBool::new(false),
        rate: a.rate,
        cwd,
        chats,
        turns: AtomicU64::new(0),
        frames: AtomicU64::new(0),
        resumes: AtomicU64::new(0),
        resyncs: AtomicU64::new(0),
    });
    let runs = |actor: &str| a.only.as_deref().is_none_or(|only| only.split(',').any(|o| o == actor));
    let mut tasks = Vec::new();
    if runs("readers") {
        for i in 0..2 {
            tasks.push(tokio::spawn(reader(cx.clone(), a.seed * 100 + i)));
        }
    }
    if runs("writer") {
        tasks.push(tokio::spawn(writer(cx.clone(), a.seed * 100 + 10)));
    }
    if runs("streams") {
        for i in 0..3 {
            tasks.push(tokio::spawn(subscriber(cx.clone(), a.seed * 100 + 20 + i, i == 0)));
        }
    }
    if runs("chats") {
        for i in 0..a.chats as u64 {
            tasks.push(tokio::spawn(chat_driver(cx.clone(), a.seed * 100 + 30 + i)));
        }
    }

    let mut csv = a.csv.as_ref().map(|path| {
        let mut file = std::fs::File::create(path).expect("the csv file");
        use std::io::Write;
        let _ = writeln!(file, "{}", Sample::HEADER);
        file
    });
    let mut leak: Vec<Vec<u8>> = Vec::new();
    let mut samples = Vec::new();
    let start = Instant::now();
    let total = Duration::from_secs_f64(a.minutes * 60.0);
    let mut next_sample = Duration::ZERO;
    while start.elapsed() < total {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if a.leak_kb > 0 {
            leak.push(vec![1u8; a.leak_kb * 1024]);
        }
        if start.elapsed() >= next_sample {
            next_sample += Duration::from_secs(a.sample_secs);
            let sample = rig::sample(&cx.app, &cx.agents, start.elapsed().as_secs_f64());
            println!(
                "t={:>5.0}s rss {:>6.1} footprint {:>6.1} allocated {:>6.1} MB fds {:>3} threads {:>3} tasks {:>4} db {:>6.1} wal {:>5.1} MB queued {:>3} sessions {:>2} requests {:>8} turns {:>6}",
                sample.at_secs,
                mb(sample.rss_kb),
                mb(sample.footprint_kb),
                mb(sample.malloc_kb),
                sample.fds,
                sample.threads,
                sample.tasks,
                mb(sample.db_kb),
                mb(sample.wal_kb),
                sample.writes_queued,
                sample.sessions,
                cx.stats.requests.load(Ordering::Relaxed),
                cx.turns.load(Ordering::Relaxed)
            );
            if let Some(file) = csv.as_mut() {
                use std::io::Write;
                let _ = writeln!(file, "{}", sample.csv());
            }
            samples.push(sample);
        }
    }
    cx.stop.store(true, Ordering::Relaxed);
    for task in tasks {
        let _ = task.await;
    }
    let leaked: usize = leak.iter().map(Vec::len).sum();
    if leaked > 0 {
        println!("deliberate leak held: {:.1} MB", leaked as f64 / 1048576.0);
    }

    println!(
        "\nrequests {}, turns {}, frames {}, resumes {} ({} resync)",
        cx.stats.requests.load(Ordering::Relaxed),
        cx.turns.load(Ordering::Relaxed),
        cx.frames.load(Ordering::Relaxed),
        cx.resumes.load(Ordering::Relaxed),
        cx.resyncs.load(Ordering::Relaxed)
    );
    let mut routes: Vec<(String, Route)> =
        cx.stats.routes.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    routes.sort_by_key(|r| std::cmp::Reverse(r.1.max));
    println!("slowest routes (max, mean, count):");
    for (label, route) in routes.iter().take(12) {
        let mean = route.total / u32::try_from(route.count.max(1)).unwrap_or(u32::MAX);
        println!(
            "  {label:<34} {:>9.1?} {:>9.1?} {:>7}{}",
            route.max,
            mean,
            route.count,
            if route.errors_5xx > 0 { format!("  5xx ×{}", route.errors_5xx) } else { String::new() }
        );
    }
    println!("slowest requests:");
    for (took, target) in cx.stats.slowest.lock().unwrap_or_else(|p| p.into_inner()).iter() {
        println!("  {took:>9.1?} {target}");
    }
    let report = cx.app.shutdown(Duration::from_secs(5)).await;
    println!("shutdown: {:.1?}, timed out {:?}", report.took, report.timed_out);

    let ceiling = a.max_footprint_mb.unwrap_or_else(|| footprint_ceiling_mb(a.rate));
    let broken = judge(&samples, &cx.stats, ceiling);
    if broken.is_empty() {
        println!("PASS");
    } else {
        for reason in &broken {
            println!("FAIL: {reason}");
        }
        std::process::exit(1);
    }
}
