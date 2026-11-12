//! File transfer between the user's computers: a computer's disk as a
//! transfer sees it (`core/src/ports/TransferEndpoint.ts`). What the feature
//! offers the agent tools is [`crate::transfer::AgentTransfers`].

use bytes::Bytes;
use eos_contracts::{
    TransferCommitRequest, TransferCommitResult, TransferListing, TransferManifest, TransferPrepareRequest,
    TransferPrepareResult,
};
use eos_domain::transfer::TransferError;

use crate::BoxFuture;

/// The part of a file a read asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

/// A file as it was scanned: a read of a file that changed since is refused.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ms: f64,
}

/// Where a chunk goes: a staged file of one transfer, at the offset the
/// sender believes it has reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteAt {
    pub id: String,
    pub dest_dir: String,
    pub rel: String,
    pub offset: u64,
}

/// One computer's disk as a file transfer sees it. The engine holds two:
/// this computer's (in process) and a paired one's (over its link).
pub trait TransferEndpoint: Send + Sync + 'static {
    fn list<'a>(&'a self, dir: &'a str, hidden: bool) -> BoxFuture<'a, Result<TransferListing, TransferError>>;
    /// Everything under the picked paths, without following links.
    fn scan<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Result<TransferManifest, TransferError>>;
    fn read<'a>(
        &'a self,
        path: &'a str,
        range: ByteRange,
        expect: FileStamp,
    ) -> BoxFuture<'a, Result<Bytes, TransferError>>;
    /// Sets up the staging and reports what already sits where the items
    /// would land.
    fn prepare<'a>(
        &'a self,
        request: &'a TransferPrepareRequest,
    ) -> BoxFuture<'a, Result<TransferPrepareResult, TransferError>>;
    /// Appends at `at.offset` (which must equal the staged size); answers
    /// the new size.
    fn write<'a>(&'a self, at: &'a WriteAt, data: Bytes) -> BoxFuture<'a, Result<u64, TransferError>>;
    fn commit<'a>(
        &'a self,
        request: &'a TransferCommitRequest,
    ) -> BoxFuture<'a, Result<TransferCommitResult, TransferError>>;
    fn abort<'a>(&'a self, id: &'a str, dest_dir: &'a str) -> BoxFuture<'a, Result<(), TransferError>>;
    /// The git project a folder belongs to, as a key that means the same
    /// repository on any computer.
    fn project_key<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>>;
    /// This computer's folder for such a key, if it has a checkout of it.
    fn locate<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, TransferError>>;
    fn home(&self) -> BoxFuture<'_, Result<String, TransferError>>;
}
