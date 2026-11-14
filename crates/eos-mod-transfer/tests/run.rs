//! `run_transfer` between two disks held in memory.

#![allow(clippy::unwrap_used)]

mod support;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use eos_contracts::{
    ManifestItem, ManifestItemType, Num, TransferCommitRequest, TransferCommitResult, TransferConflict,
    TransferDecision, TransferErrorCode as Code, TransferExisting, TransferListing, TransferManifest, TransferPlaced,
    TransferPrepareRequest, TransferPrepareResult, TransferRoute,
};
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_core::{BoxFuture, Clock};
use eos_domain::transfer::{TransferError, keep_both_name, manifest_roots};
use eos_mod_transfer::{RunDeps, RunEvents, RunInput, run_transfer};
use indexmap::IndexMap;
use support::{NoWait, TestClock};
use tokio::sync::Notify;

/// A disk in memory, with the same contract as the real endpoints.
#[derive(Default)]
struct MemoryEndpoint {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    staged: Mutex<HashMap<String, Vec<u8>>>,
    placed: Mutex<HashMap<String, Vec<u8>>>,
    existing: Mutex<HashSet<String>>,
    items: Mutex<Vec<ManifestItem>>,
    /// The next this many writes fail as a dropped link.
    fail_next: AtomicUsize,
    /// A failing write still lands before its answer is lost.
    lands_anyway: std::sync::atomic::AtomicBool,
    writes: AtomicUsize,
    largest_read: AtomicUsize,
}

/// Counts `counter` down by one; false when it is at zero.
fn take_one(counter: &AtomicUsize) -> bool {
    let mut left = counter.load(Ordering::SeqCst);
    while left > 0 {
        match counter.compare_exchange(left, left - 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(now) => left = now,
        }
    }
    false
}

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

fn item(rel: String, kind: ManifestItemType, size: usize) -> ManifestItem {
    let mode = if kind == ManifestItemType::Dir { 0o755 } else { 0o644 };
    ManifestItem { rel, r#type: kind, size: size as i64, mtime_ms: Num(1.0), mode, target: None }
}

impl MemoryEndpoint {
    fn put(&self, path: &str, bytes: Vec<u8>) {
        self.files.lock().unwrap().insert(path.to_owned(), bytes);
    }

    fn placed(&self, rel: &str) -> Option<Vec<u8>> {
        self.placed.lock().unwrap().get(rel).cloned()
    }
}

impl TransferEndpoint for MemoryEndpoint {
    fn list<'a>(&'a self, _: &'a str, _: bool) -> BoxFuture<'a, Result<TransferListing, TransferError>> {
        ready(Err(TransferError::failed("unused")))
    }

    fn scan<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Result<TransferManifest, TransferError>> {
        let files = self.files.lock().unwrap();
        let mut items = Vec::new();
        for path in paths {
            let name = path.rsplit('/').next().unwrap().to_owned();
            let under: Vec<(&String, &Vec<u8>)> =
                files.iter().filter(|(f, _)| f.starts_with(&format!("{path}/"))).collect();
            if under.is_empty() {
                items.push(item(name, ManifestItemType::File, files[path].len()));
            } else {
                items.push(item(name.clone(), ManifestItemType::Dir, 0));
                for (file, bytes) in under {
                    items.push(item(format!("{name}{}", &file[path.len()..]), ManifestItemType::File, bytes.len()));
                }
            }
        }
        let roots = manifest_roots(&items);
        let total_bytes = roots.iter().map(|r| r.size).sum();
        let file_count = items.iter().filter(|i| i.r#type == ManifestItemType::File).count() as i64;
        ready(Ok(TransferManifest { roots, items, total_bytes, file_count }))
    }

    fn read<'a>(
        &'a self,
        path: &'a str,
        range: ByteRange,
        _: FileStamp,
    ) -> BoxFuture<'a, Result<Bytes, TransferError>> {
        self.largest_read.fetch_max(range.length as usize, Ordering::SeqCst);
        let files = self.files.lock().unwrap();
        let (from, to) = (range.offset as usize, (range.offset + range.length) as usize);
        ready(Ok(Bytes::copy_from_slice(&files[path][from..to])))
    }

    fn prepare<'a>(
        &'a self,
        request: &'a TransferPrepareRequest,
    ) -> BoxFuture<'a, Result<TransferPrepareResult, TransferError>> {
        *self.items.lock().unwrap() = request.items.clone();
        let existing = self.existing.lock().unwrap();
        let there = request
            .items
            .iter()
            .filter(|i| !i.rel.contains('/') && existing.contains(&i.rel))
            .map(|i| TransferExisting { name: i.rel.clone(), r#type: i.r#type, size: Some(1), mtime_ms: Num(0.0) })
            .collect();
        let staged: IndexMap<String, i64> =
            self.staged.lock().unwrap().iter().map(|(rel, bytes)| (rel.clone(), bytes.len() as i64)).collect();
        ready(Ok(TransferPrepareResult { existing: there, staged, free_bytes: Num(1e12) }))
    }

    fn write<'a>(&'a self, at: &'a WriteAt, data: Bytes) -> BoxFuture<'a, Result<u64, TransferError>> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let failing = take_one(&self.fail_next);
        if failing && !self.lands_anyway.load(Ordering::SeqCst) {
            return ready(Err(TransferError::new(Code::Unreachable, "link dropped")));
        }
        let mut staged = self.staged.lock().unwrap();
        let held = staged.entry(at.rel.clone()).or_default();
        if held.len() as u64 != at.offset {
            return ready(Err(TransferError::offset_mismatch("wrong offset", held.len() as u64)));
        }
        held.extend_from_slice(&data);
        if failing {
            return ready(Err(TransferError::new(Code::Unreachable, "the answer was lost")));
        }
        ready(Ok(held.len() as u64))
    }

    fn commit<'a>(
        &'a self,
        request: &'a TransferCommitRequest,
    ) -> BoxFuture<'a, Result<TransferCommitResult, TransferError>> {
        let (existing, staged) = (self.existing.lock().unwrap(), self.staged.lock().unwrap());
        let (mut placed, mut skipped) = (Vec::new(), Vec::new());
        for root in self.items.lock().unwrap().iter().filter(|i| !i.rel.contains('/')) {
            let decision = request.decisions.get(&root.rel).copied();
            if existing.contains(&root.rel) && decision.is_none() {
                return ready(Err(TransferError::new(Code::ConflictUnresolved, root.rel.clone())));
            }
            if decision == Some(TransferDecision::Skip) {
                skipped.push(root.rel.clone());
                continue;
            }
            let name = match decision {
                Some(TransferDecision::Keep) => keep_both_name(&root.rel, |n| existing.contains(n)),
                _ => root.rel.clone(),
            };
            for (rel, bytes) in
                staged.iter().filter(|(rel, _)| **rel == root.rel || rel.starts_with(&format!("{}/", root.rel)))
            {
                self.placed.lock().unwrap().insert(format!("{name}{}", &rel[root.rel.len()..]), bytes.clone());
            }
            placed.push(TransferPlaced { path: format!("/dest/{name}"), name });
        }
        ready(Ok(TransferCommitResult { placed, skipped }))
    }

    fn abort<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<(), TransferError>> {
        self.staged.lock().unwrap().clear();
        ready(Ok(()))
    }

    fn project_key<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        ready(Ok(None))
    }

    fn locate<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        ready(Ok(None))
    }

    fn home(&self) -> BoxFuture<'_, Result<String, TransferError>> {
        ready(Ok("/home".to_owned()))
    }
}

/// What a run reported, and the decisions it is given.
#[derive(Default)]
struct Log {
    events: Mutex<Vec<String>>,
    done_at_prepare: Mutex<Option<u64>>,
    last_done: Mutex<u64>,
    decisions: Mutex<Option<IndexMap<String, TransferDecision>>>,
    decided: Notify,
}

impl RunEvents for Log {
    fn scanned(&self, _: &TransferManifest) {
        self.events.lock().unwrap().push("scanned".into());
    }
    fn prepared(&self, conflicts: &[TransferConflict], done_bytes: u64) {
        *self.done_at_prepare.lock().unwrap() = Some(done_bytes);
        self.events.lock().unwrap().push(format!("prepared:{}", conflicts.len()));
    }
    fn progress(&self, done_bytes: u64, _: f64) {
        *self.last_done.lock().unwrap() = done_bytes;
    }
    fn decisions<'a>(&'a self, _: &'a [TransferConflict]) -> BoxFuture<'a, IndexMap<String, TransferDecision>> {
        Box::pin(async move {
            loop {
                if let Some(decisions) = self.decisions.lock().unwrap().clone() {
                    return decisions;
                }
                self.decided.notified().await;
            }
        })
    }
    fn copied(&self) {
        self.events.lock().unwrap().push("copied".into());
    }
    fn committing(&self) {
        self.events.lock().unwrap().push("committing".into());
    }
}

struct Bench {
    src: Arc<MemoryEndpoint>,
    dst: Arc<MemoryEndpoint>,
    log: Arc<Log>,
}

impl Bench {
    fn new() -> Self {
        Self { src: Arc::default(), dst: Arc::default(), log: Arc::default() }
    }

    fn deps(&self, route: TransferRoute, clock: Arc<dyn Clock>, outage_ms: i64) -> RunDeps {
        RunDeps {
            source: self.src.clone(),
            dest: self.dst.clone(),
            clock,
            sleeper: Arc::new(NoWait),
            route: Arc::new(move || Some(route)),
            events: self.log.clone(),
            outage_ms,
        }
    }

    async fn run(&self, route: TransferRoute, sources: &[&str]) -> Result<TransferCommitResult, TransferError> {
        let input = RunInput {
            id: "tr-aaaaaaaa".into(),
            sources: sources.iter().map(|s| (*s).to_owned()).collect(),
            dest_dir: "/dest".into(),
        };
        run_transfer(self.deps(route, TestClock::real(), 120_000), input).await
    }

    fn events(&self) -> Vec<String> {
        self.log.events.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn copies_a_folder_and_a_file_chunk_by_chunk_then_commits() {
    let b = Bench::new();
    b.src.put("/s/game/a.txt", vec![b'x'; 2_700_000]);
    b.src.put("/s/game/sub/b.txt", b"bee".to_vec());
    b.src.put("/s/notes.md", b"hello".to_vec());
    let result = b.run(TransferRoute::Relay, &["/s/game", "/s/notes.md"]).await.unwrap();
    assert_eq!(result.placed.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["game", "notes.md"]);
    assert_eq!(b.dst.placed("game/a.txt").unwrap(), vec![b'x'; 2_700_000]);
    assert_eq!(b.dst.placed("game/sub/b.txt").unwrap(), b"bee");
    assert_eq!(b.dst.placed("notes.md").unwrap(), b"hello");
    assert_eq!(b.events(), ["scanned", "prepared:0", "copied", "committing"]);
    assert_eq!(*b.log.last_done.lock().unwrap(), 2_700_008);
    // Over the relay a chunk starts at 1 MiB: the big file crossed in pieces.
    assert_eq!(b.src.largest_read.load(Ordering::SeqCst), 1024 * 1024);
    assert!(b.dst.writes.load(Ordering::SeqCst) >= 5);
}

#[tokio::test]
async fn rides_out_a_dropped_link_and_carries_on_from_what_landed() {
    let b = Bench::new();
    b.src.put("/s/big.bin", vec![b'z'; 3_000_000]);
    b.dst.fail_next.store(2, Ordering::SeqCst);
    b.run(TransferRoute::Relay, &["/s/big.bin"]).await.unwrap();
    assert_eq!(b.dst.placed("big.bin").unwrap().len(), 3_000_000);

    // A write that landed but whose answer was lost is not sent twice over.
    let b = Bench::new();
    let bytes: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    b.src.put("/s/big.bin", bytes.clone());
    b.dst.lands_anyway.store(true, Ordering::SeqCst);
    b.dst.fail_next.store(2, Ordering::SeqCst);
    b.run(TransferRoute::Relay, &["/s/big.bin"]).await.unwrap();
    assert_eq!(b.dst.placed("big.bin").unwrap(), bytes, "byte for byte, nothing doubled");
}

#[tokio::test]
async fn resumes_from_the_bytes_the_destination_already_holds() {
    let b = Bench::new();
    b.src.put("/s/f.txt", b"abcdef".to_vec());
    b.dst.staged.lock().unwrap().insert("f.txt".into(), b"abc".to_vec());
    b.run(TransferRoute::Direct, &["/s/f.txt"]).await.unwrap();
    assert_eq!(*b.log.done_at_prepare.lock().unwrap(), Some(3));
    assert_eq!(b.dst.placed("f.txt").unwrap(), b"abcdef");
    assert_eq!(b.dst.writes.load(Ordering::SeqCst), 1, "only the missing tail crossed");
}

#[tokio::test]
async fn gives_up_as_unreachable_once_the_link_stays_down_past_the_outage_window() {
    let b = Bench::new();
    b.src.put("/s/f.txt", b"abc".to_vec());
    b.dst.fail_next.store(1_000, Ordering::SeqCst);
    let input = RunInput { id: "tr-dddddddd".into(), sources: vec!["/s/f.txt".into()], dest_dir: "/dest".into() };
    let failed =
        run_transfer(b.deps(TransferRoute::Relay, TestClock::stepping(1_000), 5_000), input).await.unwrap_err();
    assert_eq!(failed.code, Some(Code::Unreachable));
    assert!(b.dst.writes.load(Ordering::SeqCst) < 20, "it stopped trying");
}

#[tokio::test]
async fn copies_while_a_conflict_waits_and_commits_with_the_users_decision() {
    let b = Bench::new();
    b.src.put("/s/a.zip", b"new".to_vec());
    b.dst.existing.lock().unwrap().insert("a.zip".into());
    let running = tokio::spawn({
        let (deps, input) = (
            b.deps(TransferRoute::Direct, TestClock::real(), 120_000),
            RunInput { id: "tr-eeeeeeee".into(), sources: vec!["/s/a.zip".into()], dest_dir: "/dest".into() },
        );
        run_transfer(deps, input)
    });
    while b.events().len() < 3 {
        tokio::task::yield_now().await;
    }
    assert_eq!(b.events(), ["scanned", "prepared:1", "copied"], "staged, waiting on the decision");
    *b.log.decisions.lock().unwrap() = Some([("a.zip".to_owned(), TransferDecision::Keep)].into());
    b.log.decided.notify_one();
    let result = running.await.unwrap().unwrap();
    assert_eq!((result.placed[0].name.as_str(), result.placed[0].path.as_str()), ("a 2.zip", "/dest/a 2.zip"));
}

#[tokio::test]
async fn stops_at_once_when_dropped_keeping_what_is_staged() {
    let b = Bench::new();
    b.src.put("/s/f.txt", b"abc".to_vec());
    b.dst.existing.lock().unwrap().insert("f.txt".into());
    let running = tokio::spawn({
        let (deps, input) = (
            b.deps(TransferRoute::Direct, TestClock::real(), 120_000),
            RunInput { id: "tr-ffffffff".into(), sources: vec!["/s/f.txt".into()], dest_dir: "/dest".into() },
        );
        run_transfer(deps, input)
    });
    while b.events().len() < 3 {
        tokio::task::yield_now().await;
    }
    // A pause: the run is dropped while it waits on the decision.
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_eq!(b.dst.staged.lock().unwrap()["f.txt"], b"abc");
    assert!(b.dst.placed("f.txt").is_none());
}

#[tokio::test]
async fn one_failing_file_stops_the_others() {
    let b = Bench::new();
    for i in 0..8 {
        b.src.put(&format!("/s/set/f{i}.bin"), vec![b'x'; 600_000]);
    }
    // The link stays down for good and the window is zero: the first failure ends the run.
    b.dst.fail_next.store(usize::MAX, Ordering::SeqCst);
    let input = RunInput { id: "tr-gggggggg".into(), sources: vec!["/s/set".into()], dest_dir: "/dest".into() };
    let failed = run_transfer(b.deps(TransferRoute::Local, TestClock::stepping(1_000), 0), input).await;
    assert!(failed.is_err());
    let after = b.dst.writes.load(Ordering::SeqCst);
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(b.dst.writes.load(Ordering::SeqCst), after, "nothing keeps writing after the run ended");
}
