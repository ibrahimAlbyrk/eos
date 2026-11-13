//! What the installed bundle already holds, for planning an update
//! (`infra/src/update/FsBundleIndexer.ts`): each file by its content hash and
//! each chunk by its id, with where its bytes sit.

use std::path::Path;

use eos_core::BoxFuture;
use eos_core::net::updates::BundleIndexer;
use eos_domain::update::{BundleIndex, LocalChunk, UpdateError};
use eos_platform::ThreadClass;

use crate::scan::{ScannedEntry, scan_bundle};

#[derive(Debug, Default, Clone, Copy)]
pub struct FsBundleIndexer;

/// The index of a scanned tree; the first place a file or chunk is found wins.
pub fn index_of(entries: Vec<ScannedEntry>) -> BundleIndex {
    let mut index = BundleIndex::default();
    for entry in entries {
        let ScannedEntry::File { path, sha256, chunks, .. } = entry else { continue };
        for c in chunks {
            index.chunks.entry(c.id).or_insert_with(|| LocalChunk {
                path: path.clone(),
                offset: c.offset,
                size: c.size,
            });
        }
        index.files.entry(sha256).or_insert(path);
    }
    index
}

impl BundleIndexer for FsBundleIndexer {
    fn index<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<BundleIndex, UpdateError>> {
        let root = root.to_owned();
        Box::pin(async move {
            // Reads and hashes the whole bundle: long work nobody waits on.
            tokio::task::spawn_blocking(move || {
                eos_platform::in_thread_class(ThreadClass::Utility, || scan_bundle(&root, true).map(index_of))
            })
            .await
            .map_err(|e| UpdateError::disk(e.to_string()))?
            .map_err(|e| UpdateError::disk(format!("reading the installed app failed: {e}")))
        })
    }
}
