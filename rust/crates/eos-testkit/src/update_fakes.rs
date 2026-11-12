//! The update ports (`eos_core::net::updates`), in memory: a feed that offers
//! one scripted release, a workspace that remembers what it was told, and
//! switches for everything that can refuse.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use eos_contracts::update::{SignedUpdatePointer, UpdateApply, UpdateManifest, UpdatePlatform, UpdatePointerManifest};
use eos_core::BoxFuture;
use eos_core::net::updates::{
    AppBundleCheck, BundleIndexer, StageRequest, SwapResult, TopLevelAgents, UpdateApplier, UpdateFeed,
    UpdateSignature, UpdateWorkspace,
};
use eos_domain::update::{BundleIndex, FetchRange, StagedUpdate, UpdateError, parse_manifest};
use serde_json::json;
use tokio::sync::Notify;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

/// What a fake release downloads: one chunk of this many bytes.
pub const FAKE_DOWNLOAD_BYTES: i64 = 800_000;

/// A feed that offers one release (or none) for `darwin-arm64`. Its manifest
/// lists one file made of one chunk that no installed bundle holds.
#[derive(Debug, Default)]
pub struct FakeUpdateFeed {
    offer: Mutex<Option<String>>,
    notes: Mutex<Option<String>>,
    /// Failures handed out, one per manifest request, before it works.
    manifest_failures: Mutex<Vec<UpdateError>>,
    pointer_reads: AtomicUsize,
    range_reads: AtomicUsize,
    hold_ranges: AtomicBool,
    /// Signalled when a held range request arrives.
    range_waiting: Notify,
    never: Notify,
}

impl FakeUpdateFeed {
    pub fn offering(version: Option<&str>) -> Arc<Self> {
        let feed = Self::default();
        feed.offer(version);
        Arc::new(feed)
    }

    pub fn offer(&self, version: Option<&str>) {
        *lock(&self.offer) = version.map(str::to_owned);
    }

    /// The release notes the pointer names from now on.
    pub fn with_notes(&self, notes: &str) {
        *lock(&self.notes) = Some(notes.to_owned());
    }

    /// The next manifest request fails with `error`.
    pub fn fail_manifest_once(&self, error: UpdateError) {
        lock(&self.manifest_failures).push(error);
    }

    /// Range requests never answer from now on; [`range_requested`](Self::range_requested)
    /// resolves when one arrives.
    pub fn hold_ranges(&self) {
        self.hold_ranges.store(true, Ordering::SeqCst);
    }

    pub async fn range_requested(&self) {
        while self.range_reads.load(Ordering::SeqCst) == 0 {
            self.range_waiting.notified().await;
        }
    }

    /// How many times the pointer was asked for.
    pub fn checks(&self) -> usize {
        self.pointer_reads.load(Ordering::SeqCst)
    }

    pub fn range_reads(&self) -> usize {
        self.range_reads.load(Ordering::SeqCst)
    }

    fn manifest_of(version: &str) -> UpdateManifest {
        let json = json!({
            "format": 1, "version": version, "platform": "darwin-arm64",
            "packs": [format!("packs/darwin-arm64/{version}.pack")],
            "chunks": [{ "pack": 0, "offset": 0, "zsize": FAKE_DOWNLOAD_BYTES, "id": "1".repeat(64), "size": 100 }],
            "entries": [{ "type": "file", "path": "Contents/a", "mode": 0o644, "size": 100, "sha256": "2".repeat(64), "chunks": [0] }],
        });
        parse_manifest(json.to_string().as_bytes()).expect("a manifest")
    }
}

impl UpdateFeed for FakeUpdateFeed {
    fn pointer(&self, _platform: UpdatePlatform) -> BoxFuture<'_, Result<Option<SignedUpdatePointer>, UpdateError>> {
        self.pointer_reads.fetch_add(1, Ordering::SeqCst);
        let signed = lock(&self.offer).as_ref().map(|version| {
            let mut pointer = json!({
                "version": version, "platform": "darwin-arm64",
                "manifest": { "path": format!("releases/{version}/darwin-arm64.manifest.json.zst"), "sha256": "a".repeat(64), "size": 10 },
                "releasedAt": "2026-10-29T12:00:00.000Z",
            });
            if lock(&self.notes).is_some() {
                pointer["notes"] = json!(format!("notes/{version}.md"));
            }
            SignedUpdatePointer { payload: pointer.to_string(), signature: "s".to_owned() }
        });
        // A real feed does not answer in the same instant: the asker is suspended once.
        Box::pin(async move {
            tokio::task::yield_now().await;
            Ok(signed)
        })
    }

    fn manifest<'a>(
        &'a self,
        reference: &'a UpdatePointerManifest,
    ) -> BoxFuture<'a, Result<UpdateManifest, UpdateError>> {
        if let Some(error) = lock(&self.manifest_failures).pop() {
            return ready(Err(error));
        }
        let version = reference.path.split('/').nth(1).unwrap_or_default();
        ready(Ok(Self::manifest_of(version)))
    }

    fn range<'a>(&'a self, _path: &'a str, _offset: i64, length: i64) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>> {
        Box::pin(async move {
            self.range_reads.fetch_add(1, Ordering::SeqCst);
            if self.hold_ranges.load(Ordering::SeqCst) {
                self.range_waiting.notify_waiters();
                self.never.notified().await;
            }
            Ok(vec![0; usize::try_from(length).unwrap_or(0)])
        })
    }

    fn text<'a>(&'a self, _path: &'a str, _max_bytes: usize) -> BoxFuture<'a, Result<String, UpdateError>> {
        ready(lock(&self.notes).clone().ok_or_else(|| UpdateError::bad_release("no notes")))
    }
}

/// Every signature verifies, or none does.
#[derive(Debug)]
pub struct FakeUpdateSignature(pub bool);

impl UpdateSignature for FakeUpdateSignature {
    fn verify(&self, _payload: &str, _signature: &str) -> bool {
        self.0
    }
}

/// An installed bundle that holds nothing a release could reuse.
#[derive(Debug, Default)]
pub struct FakeBundleIndexer;

impl BundleIndexer for FakeBundleIndexer {
    fn index<'a>(&'a self, _root: &'a Path) -> BoxFuture<'a, Result<BundleIndex, UpdateError>> {
        ready(Ok(BundleIndex::default()))
    }
}

/// A workspace that keeps what it is told and builds nothing: a staged
/// bundle is `/u/staged/<version>/Eos.app`.
#[derive(Debug, Default)]
pub struct FakeUpdateWorkspace {
    pub staged: Mutex<Option<StagedUpdate>>,
    pub result: Mutex<Option<SwapResult>>,
    pub last_version: Mutex<Option<String>>,
    /// The first `put_range` is refused as damaged.
    pub damage_first_range: AtomicBool,
    pub kept_ranges: Mutex<Vec<FetchRange>>,
    pub clears: AtomicUsize,
}

impl UpdateWorkspace for FakeUpdateWorkspace {
    fn has_range<'a>(&'a self, _version: &'a str, range: FetchRange) -> BoxFuture<'a, bool> {
        ready(lock(&self.kept_ranges).contains(&range))
    }

    fn put_range<'a>(
        &'a self,
        _version: &'a str,
        range: FetchRange,
        _bytes: Vec<u8>,
        _manifest: Arc<UpdateManifest>,
    ) -> BoxFuture<'a, Result<(), UpdateError>> {
        if self.damage_first_range.swap(false, Ordering::SeqCst) {
            return ready(Err(UpdateError::corrupt("damaged")));
        }
        lock(&self.kept_ranges).push(range);
        ready(Ok(()))
    }

    fn stage(&self, request: StageRequest) -> BoxFuture<'_, Result<String, UpdateError>> {
        ready(Ok(format!("/u/staged/{}/Eos.app", request.version)))
    }

    fn staged(&self) -> BoxFuture<'_, Option<StagedUpdate>> {
        ready(lock(&self.staged).clone())
    }

    fn mark_staged<'a>(&'a self, update: &'a StagedUpdate) -> BoxFuture<'a, Result<(), UpdateError>> {
        *lock(&self.staged) = Some(update.clone());
        ready(Ok(()))
    }

    fn clear<'a>(&'a self, _keep: Option<&'a str>) -> BoxFuture<'a, Result<(), UpdateError>> {
        self.clears.fetch_add(1, Ordering::SeqCst);
        *lock(&self.staged) = None;
        ready(Ok(()))
    }

    fn last_version(&self) -> BoxFuture<'_, Option<String>> {
        ready(lock(&self.last_version).clone())
    }

    fn set_last_version<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), UpdateError>> {
        *lock(&self.last_version) = Some(version.to_owned());
        ready(Ok(()))
    }

    fn result(&self) -> BoxFuture<'_, Option<SwapResult>> {
        ready(lock(&self.result).clone())
    }

    fn dismiss_result(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
        if let Some(result) = lock(&self.result).as_mut() {
            result.dismissed = true;
        }
        ready(Ok(()))
    }
}

/// The system's check of a staged app; accepts until told to refuse.
#[derive(Debug, Default)]
pub struct FakeBundleCheck {
    refuse_with: Mutex<Option<UpdateError>>,
    pub checks: AtomicUsize,
}

impl FakeBundleCheck {
    /// Every check from now on fails with `error`.
    pub fn refuse(&self, error: UpdateError) {
        *lock(&self.refuse_with) = Some(error);
    }
}

impl AppBundleCheck for FakeBundleCheck {
    fn verify<'a>(&'a self, _staged: &'a Path, _installed: &'a Path) -> BoxFuture<'a, Result<(), UpdateError>> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        ready(lock(&self.refuse_with).clone().map_or(Ok(()), Err))
    }
}

/// How many top-level agents are in a turn, as the test says.
#[derive(Debug, Default)]
pub struct FakeTopLevelAgents(pub AtomicUsize);

impl FakeTopLevelAgents {
    pub fn set(&self, working: usize) {
        self.0.store(working, Ordering::SeqCst);
    }
}

impl TopLevelAgents for FakeTopLevelAgents {
    fn working(&self) -> BoxFuture<'_, usize> {
        ready(self.0.load(Ordering::SeqCst))
    }
}

/// The shell's hand-over: records what it was asked to apply.
#[derive(Debug, Default)]
pub struct FakeUpdateApplier {
    pub applied: Mutex<Vec<UpdateApply>>,
    /// The hand-over fails with this text.
    pub fail_with: Mutex<Option<String>>,
}

impl FakeUpdateApplier {
    pub fn applied(&self) -> Vec<UpdateApply> {
        lock(&self.applied).clone()
    }
}

impl UpdateApplier for FakeUpdateApplier {
    fn apply<'a>(&'a self, apply: &'a UpdateApply) -> BoxFuture<'a, Result<(), String>> {
        if let Some(message) = lock(&self.fail_with).clone() {
            return ready(Err(message));
        }
        lock(&self.applied).push(apply.clone());
        ready(Ok(()))
    }
}
