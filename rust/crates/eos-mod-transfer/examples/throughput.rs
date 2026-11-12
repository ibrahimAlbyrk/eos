//! How fast a transfer moves between two folders of this computer: one
//! large file, then a tree of many small files. Both sides are the real disk
//! endpoint; the engine is the real one, on the "local" route.
//!
//! ```bash
//! /usr/bin/time -l cargo run --release -p eos-mod-transfer --example throughput
//! /usr/bin/time -l cargo run --release -p eos-mod-transfer --example throughput -- 1024 10000
//! ```
//!
//! Arguments: megabytes of the large file (default 1024), number of small
//! files (default 10000). `time -l` prints the peak memory: it stays flat,
//! since a file in flight holds one chunk being written and one read ahead.

use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use eos_contracts::{TransferConflict, TransferDecision, TransferManifest, TransferRoute};
use eos_core::git::ProjectKeys;
use eos_core::net::transfer::TransferEndpoint;
use eos_core::{BoxFuture, Sleeper, SystemClock};
use eos_mod_transfer::{DEFAULT_OUTAGE_MS, RunDeps, RunEvents, RunInput, run_transfer};
use eos_transfer_fs::{FsTransferEndpoint, FsTransferEndpointDeps};
use indexmap::IndexMap;

struct NoKeys;

impl ProjectKeys for NoKeys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(format!("path:{path}")))
    }
    fn to_path<'a>(&'a self, _: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(hint.to_owned()))
    }
    fn find_path<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }
}

/// Notes when each phase of a run ended.
struct Phases {
    began: Instant,
    marks: Mutex<Vec<(&'static str, f64)>>,
}

impl Phases {
    fn mark(&self, phase: &'static str) {
        self.marks.lock().unwrap_or_else(|p| p.into_inner()).push((phase, self.began.elapsed().as_secs_f64()));
    }
}

impl RunEvents for Phases {
    fn scanned(&self, _: &TransferManifest) {
        self.mark("scan");
    }
    fn prepared(&self, _: &[TransferConflict], _: u64) {
        self.mark("prepare");
    }
    fn progress(&self, _: u64, _: f64) {}
    fn decisions<'a>(&'a self, _: &'a [TransferConflict]) -> BoxFuture<'a, IndexMap<String, TransferDecision>> {
        Box::pin(std::future::ready(IndexMap::new()))
    }
    fn copied(&self) {
        self.mark("copy");
    }
    fn committing(&self) {}
}

struct TokioSleep;

impl Sleeper for TokioSleep {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms.unsigned_abs())))
    }
}

fn endpoint(home: &Path) -> Arc<dyn TransferEndpoint> {
    Arc::new(FsTransferEndpoint::new(FsTransferEndpointDeps {
        home: home.to_owned(),
        forbidden: Vec::new(),
        trash: Arc::new(|_| Err("nothing is replaced here".to_owned())),
        projects: Arc::new(NoKeys),
        clock: Arc::new(SystemClock),
    }))
}

/// Runs one transfer; answers its seconds and where they went.
async fn copy(id: &str, from: &Path, to: &Path, picked: &Path) -> Result<(f64, String), Box<dyn std::error::Error>> {
    let phases = Arc::new(Phases { began: Instant::now(), marks: Mutex::default() });
    let deps = RunDeps {
        source: endpoint(from),
        dest: endpoint(to),
        clock: Arc::new(SystemClock),
        sleeper: Arc::new(TokioSleep),
        route: Arc::new(|| Some(TransferRoute::Local)),
        events: phases.clone(),
        outage_ms: DEFAULT_OUTAGE_MS,
    };
    let input = RunInput {
        id: id.to_owned(),
        sources: vec![picked.to_string_lossy().into_owned()],
        dest_dir: to.to_string_lossy().into_owned(),
    };
    run_transfer(deps, input).await?;
    phases.mark("commit");
    let marks = phases.marks.lock().unwrap_or_else(|p| p.into_inner());
    let mut last = 0.0;
    let mut spent = Vec::new();
    for (phase, at) in marks.iter() {
        spent.push(format!("{phase} {:.2} s", at - last));
        last = *at;
    }
    Ok((last, spent.join(", ")))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let megabytes: usize = args.next().map_or(Ok(1024), |a| a.parse())?;
    let small_files: usize = args.next().map_or(Ok(10_000), |a| a.parse())?;
    let tmp = tempfile::tempdir()?;
    let (src, dst) = (tmp.path().join("src"), tmp.path().join("dst"));
    std::fs::create_dir_all(&src)?;
    std::fs::create_dir_all(&dst)?;

    // One large file of bytes that do not compress or repeat.
    let big = src.join("big.bin");
    {
        let mut file = std::io::BufWriter::new(std::fs::File::create(&big)?);
        let mut block = vec![0u8; 1024 * 1024];
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..megabytes {
            for at in (0..block.len()).step_by(8) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                block[at..at + 8].copy_from_slice(&state.to_le_bytes());
            }
            file.write_all(&block)?;
        }
        file.flush()?;
    }
    let (seconds, spent) = copy("tr-throughput01", &src, &dst, &big).await?;
    assert_eq!(std::fs::metadata(dst.join("big.bin"))?.len(), (megabytes * 1024 * 1024) as u64);
    println!("large file: {megabytes} MB in {seconds:.2} s — {:.0} MB/s ({spent})", megabytes as f64 / seconds);

    // A tree of small files, 100 to a folder.
    let tree = src.join("tree");
    let mut bytes = 0usize;
    for i in 0..small_files {
        let dir = tree.join(format!("d{:03}", i / 100));
        if i % 100 == 0 {
            std::fs::create_dir_all(&dir)?;
        }
        let content = vec![(i % 251) as u8; 512 + (i % 7) * 512];
        bytes += content.len();
        std::fs::write(dir.join(format!("f{i:05}.dat")), content)?;
    }
    let (seconds, spent) = copy("tr-throughput02", &src, &dst, &tree).await?;
    let megabytes = bytes as f64 / (1024.0 * 1024.0);
    println!(
        "small files: {small_files} files ({megabytes:.1} MB) in {seconds:.2} s — {:.0} files/s, {:.1} MB/s ({spent})",
        small_files as f64 / seconds,
        megabytes / seconds
    );
    Ok(())
}
