//! The two things an update run does with the feed.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use eos_contracts::update::{UpdateManifest, UpdatePlatform, UpdatePointer};
use eos_core::net::updates::{
    AppBundleCheck, BundleIndexer, StageRequest, UpdateFeed, UpdateSignature, UpdateWorkspace,
};
use eos_domain::update::{
    FetchRange, StagedUpdate, UpdateError, UpdateErrorCode, manifest_problem, offered_release, plan_update,
};
use futures_util::stream::{self, TryStreamExt};
use tokio::sync::Notify;

const PARALLEL_RANGES: usize = 4;
const NOTES_MAX_BYTES: usize = 64 * 1024;

/// Asks the feed for the newest release and decides whether it is ours to
/// take: signed by our key, meant for this platform, newer than what is installed.
pub async fn check_for_update(
    feed: &dyn UpdateFeed,
    signature: &dyn UpdateSignature,
    platform: UpdatePlatform,
    current: &str,
) -> Result<Option<UpdatePointer>, UpdateError> {
    let Some(signed) = feed.pointer(platform).await? else { return Ok(None) };
    offered_release(&signed, signature.verify(&signed.payload, &signed.signature), platform, current)
}

/// Stops a download between its steps and abandons its requests.
#[derive(Debug, Clone, Default)]
pub struct Cancel {
    inner: Arc<CancelInner>,
}

#[derive(Debug, Default)]
struct CancelInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    fn check(&self) -> Result<(), UpdateError> {
        if self.is_cancelled() { Err(UpdateError::network("the download was stopped")) } else { Ok(()) }
    }
}

pub struct DownloadDeps {
    pub feed: Arc<dyn UpdateFeed>,
    pub indexer: Arc<dyn BundleIndexer>,
    pub workspace: Arc<dyn UpdateWorkspace>,
    pub bundle_check: Arc<dyn AppBundleCheck>,
}

impl std::fmt::Debug for DownloadDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DownloadDeps").finish_non_exhaustive()
    }
}

/// Hears how a download is going.
pub trait DownloadProgress: Send + Sync {
    /// Once the plan is known (`done` = 0), then after every range.
    fn progress(&self, done: i64, total: i64);
    /// Every byte is in; the new bundle is being built.
    fn staging(&self);
}

/// Brings one release onto this disk, ready to swap in: read its manifest,
/// see what the installed bundle already holds, fetch only the missing chunks,
/// build the new bundle beside the old one and have the system vouch for it.
/// Ranges already fetched are kept, so a cancelled or failed run resumes.
pub async fn download_update(
    deps: &DownloadDeps,
    pointer: &UpdatePointer,
    installed_root: &str,
    progress: &dyn DownloadProgress,
    cancel: &Cancel,
) -> Result<StagedUpdate, UpdateError> {
    let version = pointer.version.0.as_str();
    deps.workspace.clear(Some(version)).await?;

    let manifest = deps.feed.manifest(&pointer.manifest).await?;
    if manifest.version != pointer.version || manifest.platform != pointer.platform {
        return Err(UpdateError::bad_release("the manifest is not the release its pointer names"));
    }
    if let Some(problem) = manifest_problem(&manifest) {
        return Err(UpdateError::bad_release(problem));
    }
    let manifest = Arc::new(manifest);

    let index = deps.indexer.index(Path::new(installed_root)).await?;
    let plan = Arc::new(plan_update(&index, &manifest));
    let total = plan.download_bytes;
    let done = AtomicI64::new(0);
    progress.progress(0, total);
    stream::iter(plan.ranges.iter().map(Ok::<_, UpdateError>))
        // One failing range stops its siblings too.
        .try_for_each_concurrent(PARALLEL_RANGES, |range| {
            let (manifest, done) = (&manifest, &done);
            async move {
                cancel.check()?;
                if !deps.workspace.has_range(version, *range).await {
                    tokio::select! {
                        fetched = fetch_range(deps, manifest, *range) => fetched?,
                        () = cancel.cancelled() => cancel.check()?,
                    }
                }
                progress.progress(done.fetch_add(range.length, Ordering::SeqCst) + range.length, total);
                Ok(())
            }
        })
        .await?;

    progress.staging();
    let path = deps
        .workspace
        .stage(StageRequest {
            version: version.to_owned(),
            manifest: manifest.clone(),
            plan: plan.clone(),
            installed_root: installed_root.to_owned(),
        })
        .await?;
    cancel.check()?;
    deps.bundle_check.verify(Path::new(&path), Path::new(installed_root)).await?;
    let notes = match &pointer.notes {
        Some(notes) => deps.feed.text(notes, NOTES_MAX_BYTES).await.ok(),
        None => None,
    };
    let full = manifest.chunks.iter().map(|c| c.zsize).sum();
    let staged = StagedUpdate { version: version.to_owned(), path, bytes: plan.download_bytes, full, notes };
    deps.workspace.mark_staged(&staged).await?;
    Ok(staged)
}

/// Bytes whose chunks do not match are fetched once more before giving up.
async fn fetch_range(
    deps: &DownloadDeps,
    manifest: &Arc<UpdateManifest>,
    range: FetchRange,
) -> Result<(), UpdateError> {
    let pack = usize::try_from(range.pack).ok().and_then(|i| manifest.packs.get(i));
    let pack = pack.ok_or_else(|| UpdateError::bad_release(format!("a chunk names pack {}", range.pack)))?;
    let mut retried = false;
    loop {
        let bytes = deps.feed.range(pack, range.offset, range.length).await?;
        match deps.workspace.put_range(&manifest.version.0, range, bytes, manifest.clone()).await {
            Err(e) if e.code == UpdateErrorCode::Corrupt && !retried => retried = true,
            other => return other,
        }
    }
}
