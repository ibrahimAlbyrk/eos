//! The manifest (format 1) and pointer payload as serde types.
//!
//! Field order is the order the TypeScript publisher writes — zod emits keys in
//! schema order, so a chunk is `pack, offset, zsize, id, size` — which makes
//! `to_string(&from_str(x))` reproduce the publisher's bytes. Unknown fields are
//! ignored on read, as the non-strict zod schemas do.

use serde::{Deserialize, Serialize};

pub const UPDATE_MANIFEST_FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackSpan {
    pub pack: u32,
    pub offset: u64,
    pub zsize: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateChunk {
    pub pack: u32,
    pub offset: u64,
    pub zsize: u64,
    pub id: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum UpdateEntry {
    Dir {
        path: String,
        mode: u32,
    },
    Link {
        path: String,
        target: String,
    },
    File {
        path: String,
        mode: u32,
        size: u64,
        sha256: String,
        /// Indexes into `chunks`, in file order.
        chunks: Vec<u32>,
        /// The file as one frame, when that compressed better than its chunks.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        whole: Option<PackSpan>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub format: u32,
    pub version: String,
    pub platform: String,
    pub packs: Vec<String>,
    pub chunks: Vec<UpdateChunk>,
    pub entries: Vec<UpdateEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestRef {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePointer {
    pub version: String,
    pub platform: String,
    pub manifest: ManifestRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub released_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_url: Option<String>,
}

impl UpdateManifest {
    pub fn parse(json: &[u8]) -> anyhow::Result<Self> {
        let manifest: Self = serde_json::from_slice(json)?;
        anyhow::ensure!(
            manifest.format == UPDATE_MANIFEST_FORMAT,
            "manifest format {} is not supported",
            manifest.format
        );
        Ok(manifest)
    }
}
