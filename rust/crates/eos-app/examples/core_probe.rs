//! Measures the core alone: no window, no shell, no agent.
//!
//!   cargo run --release -p eos-app --example core_probe -- <data folder> [rounds]
//!
//! Prints how long the app takes from nothing to ready on that folder, how
//! long the worker list and a 500-row transcript page take to answer, and the
//! process's memory while idle. It only reads through the router (GET), and
//! prints figures, never content.

use std::process::Command;
use std::time::{Duration, Instant};

use eos_app::{App, Options};
use eos_runtime::http::{Method, Request};
use serde_json::Value;

fn resident_kb() -> Option<u64> {
    let out = Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

async fn get(app: &App, target: &str) -> (u16, Vec<u8>, Duration) {
    let caller = app.callers().classify(Some(app.callers().ui_token()));
    let began = Instant::now();
    let response = app.router().handle(Request::new(Method::Get, target, caller)).await;
    let status = response.status;
    let body = response.body.collect().await.map(|b| b.to_vec()).unwrap_or_default();
    (status, body, began.elapsed())
}

async fn timed(app: &App, label: &str, target: &str, rounds: usize) {
    let mut times = Vec::with_capacity(rounds);
    let mut bytes = 0;
    for _ in 0..rounds {
        let (status, body, took) = get(app, target).await;
        assert_eq!(status, 200, "{label}");
        bytes = body.len();
        times.push(took);
    }
    times.sort();
    println!(
        "{label:<34} p50 {:>9.3?}  p99 {:>9.3?}  max {:>9.3?}  {:>7} KB",
        percentile(&times, 0.5),
        percentile(&times, 0.99),
        times[times.len() - 1],
        bytes / 1024
    );
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(home) = args.next() else {
        eprintln!("usage: core_probe <data folder> [rounds]");
        std::process::exit(2);
    };
    let rounds: usize = args.next().and_then(|r| r.parse().ok()).unwrap_or(200);

    let began = Instant::now();
    let app = match App::build(Options::new(&home)) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("core_probe: {e}");
            std::process::exit(1);
        }
    };
    let built = began.elapsed();
    if let Err(e) = app.start().await {
        eprintln!("core_probe: {e}");
        std::process::exit(1);
    }
    println!("start: build {built:.3?}, ready {:.3?}", began.elapsed());
    app.runtime().lifecycle.deferred_done().await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!("idle, before any request:          {} KB resident", resident_kb().unwrap_or(0));

    let (_, list, _) = get(&app, "/workers").await;
    let workers: Vec<Value> = serde_json::from_slice(&list).unwrap_or_default();
    println!("workers listed: {}", workers.len());
    timed(&app, "GET /workers", "/workers", rounds).await;
    timed(&app, "GET /workers?brief=1", "/workers?brief=1", rounds).await;

    // The first chat whose log fills a whole 500-row page.
    let mut page = None;
    for id in workers.iter().filter_map(|w| w["id"].as_str()) {
        let target = format!("/workers/{id}/events?limit=500");
        let (_, body, _) = get(&app, &target).await;
        if serde_json::from_slice::<Vec<Value>>(&body).is_ok_and(|rows| rows.len() == 500) {
            page = Some(target);
            break;
        }
    }
    match page {
        Some(target) => timed(&app, "GET /workers/{id}/events?limit=500", &target, rounds).await,
        None => println!("no chat has 500 events"),
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    println!("idle, after the requests:          {} KB resident", resident_kb().unwrap_or(0));
    app.shutdown(Duration::from_secs(5)).await;
}
