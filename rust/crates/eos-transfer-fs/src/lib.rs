//! This computer's disk as a file-transfer endpoint
//! (`infra/src/transfer/FsTransferEndpoint.ts`): the engine uses it in
//! process, and `/transfer/*` serves it to a paired computer. Incoming bytes
//! go to a staging folder inside the destination
//! (`<dest>/.eos-incoming/<id>/files/…`, same volume, so placing them is a
//! rename) and only reach their final names at commit.
//!
//! What it refuses: relative or escaping paths, a destination inside Eos's
//! own data, writing through a link (links are created last, at commit),
//! more bytes than a file was scanned with, and a source that changed since
//! its scan.
//!
//! Every call does its file work on a blocking thread; nothing here holds a
//! lock while it touches the disk.

mod disk;
mod staging;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use eos_contracts::{
    TransferCommitRequest, TransferCommitResult, TransferListing, TransferManifest, TransferPrepareRequest,
    TransferPrepareResult,
};
use eos_core::git::ProjectKeys;
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_core::{BoxFuture, Clock};
use eos_domain::transfer::TransferError;

pub use staging::STAGING_DIR;

/// Sends a file or folder to the Trash (what "Replace" does to the one
/// already there). Runs on a blocking thread.
pub type Trash = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;

pub struct FsTransferEndpointDeps {
    /// The user's home folder: where a listing starts.
    pub home: PathBuf,
    /// Where nothing may land: Eos's own data.
    pub forbidden: Vec<PathBuf>,
    pub trash: Trash,
    pub projects: Arc<dyn ProjectKeys>,
    pub clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FsTransferEndpointDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsTransferEndpointDeps").field("home", &self.home).finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct FsTransferEndpoint {
    disk: Arc<staging::Disk>,
    projects: Arc<dyn ProjectKeys>,
}

impl std::fmt::Debug for FsTransferEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsTransferEndpoint").finish_non_exhaustive()
    }
}

impl FsTransferEndpoint {
    pub fn new(deps: FsTransferEndpointDeps) -> Self {
        let FsTransferEndpointDeps { home, forbidden, trash, projects, clock } = deps;
        Self { disk: Arc::new(staging::Disk::new(home, &forbidden, trash, clock)), projects }
    }

    /// Runs `work` on a blocking thread.
    async fn on_disk<T: Send + 'static>(
        &self,
        work: impl FnOnce(&staging::Disk) -> Result<T, TransferError> + Send + 'static,
    ) -> Result<T, TransferError> {
        let disk = self.disk.clone();
        tokio::task::spawn_blocking(move || work(&disk)).await.map_err(TransferError::failed)?
    }
}

impl TransferEndpoint for FsTransferEndpoint {
    fn list<'a>(&'a self, dir: &'a str, hidden: bool) -> BoxFuture<'a, Result<TransferListing, TransferError>> {
        let dir = dir.to_owned();
        Box::pin(self.on_disk(move |disk| disk::list(disk.home(), &dir, hidden)))
    }

    fn scan<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Result<TransferManifest, TransferError>> {
        let paths = paths.to_vec();
        Box::pin(self.on_disk(move |_| disk::scan(&paths)))
    }

    fn read<'a>(
        &'a self,
        path: &'a str,
        range: ByteRange,
        expect: FileStamp,
    ) -> BoxFuture<'a, Result<Bytes, TransferError>> {
        let path = path.to_owned();
        Box::pin(self.on_disk(move |_| disk::read(&path, range, expect)))
    }

    fn prepare<'a>(
        &'a self,
        request: &'a TransferPrepareRequest,
    ) -> BoxFuture<'a, Result<TransferPrepareResult, TransferError>> {
        let request = request.clone();
        Box::pin(self.on_disk(move |disk| disk.prepare(request)))
    }

    fn write<'a>(&'a self, at: &'a WriteAt, data: Bytes) -> BoxFuture<'a, Result<u64, TransferError>> {
        let at = at.clone();
        Box::pin(self.on_disk(move |disk| disk.write(&at, &data)))
    }

    fn commit<'a>(
        &'a self,
        request: &'a TransferCommitRequest,
    ) -> BoxFuture<'a, Result<TransferCommitResult, TransferError>> {
        let request = request.clone();
        Box::pin(self.on_disk(move |disk| disk.commit(&request)))
    }

    fn abort<'a>(&'a self, id: &'a str, dest_dir: &'a str) -> BoxFuture<'a, Result<(), TransferError>> {
        let (id, dest_dir) = (id.to_owned(), dest_dir.to_owned());
        Box::pin(self.on_disk(move |disk| disk.abort(&id, &dest_dir)))
    }

    fn project_key<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        Box::pin(async move {
            let dir = disk::absolute(dir)?;
            let key = self.projects.to_key(&dir.to_string_lossy()).await;
            Ok(key.starts_with("git:").then_some(key))
        })
    }

    fn locate<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>> {
        Box::pin(async move { if key.starts_with("git:") { Ok(self.projects.find_path(key).await) } else { Ok(None) } })
    }

    fn home(&self) -> BoxFuture<'_, Result<String, TransferError>> {
        Box::pin(std::future::ready(Ok(self.disk.home().to_string_lossy().into_owned())))
    }
}
