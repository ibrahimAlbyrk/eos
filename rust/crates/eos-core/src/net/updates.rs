//! What in-app updates need from outside the process (`core/src/ports/Updates.ts`):
//! the feed on the network, the key that signs it, the installed bundle on
//! disk, a workspace for fetched bytes and the staged copy, and the system's
//! own check of an app — plus the three seams to the rest of the app: what the
//! window tells the updater, who is still working, and the hand-over that
//! restarts into the new version. Failures are [`UpdateError`]s.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::update::{
    SignedUpdatePointer, UpdateApply, UpdateManifest, UpdateNotice, UpdatePlatform, UpdatePointerManifest,
};
use eos_domain::update::{BundleIndex, FetchRange, StagedUpdate, UpdateError, UpdatePlan};

use crate::BoxFuture;

/// The update feed. A request the caller drops is abandoned.
pub trait UpdateFeed: Send + Sync + 'static {
    /// `None` while the feed has no release for this platform.
    fn pointer(&self, platform: UpdatePlatform) -> BoxFuture<'_, Result<Option<SignedUpdatePointer>, UpdateError>>;
    /// Fetched, checked against the pointer's hash and size, unpacked, parsed.
    fn manifest<'a>(
        &'a self,
        reference: &'a UpdatePointerManifest,
    ) -> BoxFuture<'a, Result<UpdateManifest, UpdateError>>;
    /// `length` bytes of the feed file `path` from `offset`.
    fn range<'a>(&'a self, path: &'a str, offset: i64, length: i64) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>>;
    fn text<'a>(&'a self, path: &'a str, max_bytes: usize) -> BoxFuture<'a, Result<String, UpdateError>>;
}

/// The keys whose signature on a pointer is trusted.
pub trait UpdateSignature: Send + Sync + 'static {
    /// `signature` (base64) is a trusted key's signature over exactly `payload`.
    fn verify(&self, payload: &str, signature: &str) -> bool;
}

/// What the installed bundle already holds.
pub trait BundleIndexer: Send + Sync + 'static {
    fn index<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<BundleIndex, UpdateError>>;
}

/// What staging a release needs.
#[derive(Debug, Clone)]
pub struct StageRequest {
    pub version: String,
    pub manifest: Arc<UpdateManifest>,
    pub plan: Arc<UpdatePlan>,
    pub installed_root: String,
}

/// How the applier's last swap ended, as it left it on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct SwapResult {
    pub notice: UpdateNotice,
    pub dismissed: bool,
}

/// Fetched bytes and the staged copy (`~/.eos/updates`, regenerable).
pub trait UpdateWorkspace: Send + Sync + 'static {
    fn has_range<'a>(&'a self, version: &'a str, range: FetchRange) -> BoxFuture<'a, bool>;
    /// Refuses bytes whose chunks do not match their ids.
    fn put_range<'a>(
        &'a self,
        version: &'a str,
        range: FetchRange,
        bytes: Vec<u8>,
        manifest: Arc<UpdateManifest>,
    ) -> BoxFuture<'a, Result<(), UpdateError>>;
    /// Builds the new bundle next to the installed one and checks every entry
    /// against the manifest; returns the staged bundle's path.
    fn stage(&self, request: StageRequest) -> BoxFuture<'_, Result<String, UpdateError>>;
    fn staged(&self) -> BoxFuture<'_, Option<StagedUpdate>>;
    fn mark_staged<'a>(&'a self, update: &'a StagedUpdate) -> BoxFuture<'a, Result<(), UpdateError>>;
    /// Drops fetched bytes of every version but `keep`, and any staged copy.
    /// The previous app the applier set aside stays: it may still be needed
    /// to roll back.
    fn clear<'a>(&'a self, keep: Option<&'a str>) -> BoxFuture<'a, Result<(), UpdateError>>;
    /// The version that ran here last — a newer one now means it was updated.
    fn last_version(&self) -> BoxFuture<'_, Option<String>>;
    fn set_last_version<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), UpdateError>>;
    fn result(&self) -> BoxFuture<'_, Option<SwapResult>>;
    /// Kept, so a version that failed to start is not fetched again on its own.
    fn dismiss_result(&self) -> BoxFuture<'_, Result<(), UpdateError>>;
}

/// The system's word on a staged app.
pub trait AppBundleCheck: Send + Sync + 'static {
    /// The staged copy is signed by the same developer as the installed app
    /// and the system would run it.
    fn verify<'a>(&'a self, staged: &'a Path, installed: &'a Path) -> BoxFuture<'a, Result<(), UpdateError>>;
}

/// What the window shell tells the updater. Each is a hint to look for a new
/// release; one that follows a recent check is ignored. Returns at once.
pub trait UpdateSignals: Send + Sync + 'static {
    /// The window was opened or shown again.
    fn window_shown(&self);
    /// The computer woke from sleep.
    fn woke(&self);
}

/// Asked by "restart when they finish". Implemented by the sessions side.
pub trait TopLevelAgents: Send + Sync + 'static {
    /// How many top-level agents are in a turn right now.
    fn working(&self) -> BoxFuture<'_, usize>;
}

/// The hand-over to the new version, implemented by the window shell: leave
/// what the applier needs, start it, and quit. `Ok` means the app is on its
/// way out; an `Err` text is shown to the user and the app keeps running.
pub trait UpdateApplier: Send + Sync + 'static {
    fn apply<'a>(&'a self, apply: &'a UpdateApply) -> BoxFuture<'a, Result<(), String>>;
}
