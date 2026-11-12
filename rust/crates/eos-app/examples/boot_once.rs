//! Starts the app once on a data folder and stops it cleanly: what start-up
//! and a stop leave on disk (`scripts/boot-compare.sh` compares that with the
//! TypeScript daemon's boot), and how long each part takes.
//!
//!   cargo run --release -p eos-app --example boot_once -- <data folder> [settle seconds]
//!
//! No request is made. Peers, the relay and the leftover sweep stay off, as on
//! any copy of a data folder.

use std::time::{Duration, Instant};

use eos_app::{App, Options};

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(home) = args.next() else {
        eprintln!("usage: boot_once <data folder> [settle seconds]");
        std::process::exit(2);
    };
    let settle: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(3);

    let began = Instant::now();
    let app = match App::build(Options { launchd: None, ..Options::new(&home) }) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("boot_once: {e}");
            std::process::exit(1);
        }
    };
    let built = began.elapsed();
    if let Err(e) = app.start().await {
        eprintln!("boot_once: {e}");
        std::process::exit(1);
    }
    let ready = began.elapsed();
    app.runtime().lifecycle.deferred_done().await;
    let deferred = began.elapsed();
    println!("build {built:.3?}  ready {ready:.3?}  deferred work done {deferred:.3?}");
    tokio::time::sleep(Duration::from_secs(settle)).await;
    let stopping = Instant::now();
    let report = app.shutdown(Duration::from_secs(5)).await;
    println!(
        "stop {:.3?}  modules stopped {}  timed out {:?}  skipped {:?}",
        stopping.elapsed(),
        report.stopped.len(),
        report.timed_out,
        report.skipped
    );
}
