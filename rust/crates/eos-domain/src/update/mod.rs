//! The rules of in-app updates (`core/src/domain/update`).
//!
//! A signed pointer per platform names the newest release; its manifest lists
//! the app bundle's tree, every file as content-defined chunks that live,
//! zstd-compressed, in per-release packs. An installed app fetches only the
//! chunks it lacks. The wire types are `eos_contracts::update`; this module
//! holds what is decided from them:
//!
//! - [`chunker`]: where a file is cut. Part of manifest format 1.
//! - [`manifest`]: reading a manifest and refusing one that could write outside the bundle.
//! - [`pointer`]: reading the pointer wrapper and deciding whether its release is ours to take.
//! - [`plan`]: which bytes an update fetches, given what is installed.
//! - [`status`]: which phase may follow which.
//! - [`version`]: `major.minor.patch` comparison.
//!
//! **Byte formats.** Everything a published release is made of must stay
//! exactly as the TypeScript publisher writes it, because installed apps of
//! every past version read it: the manifest is format 1 JSON with zod's key
//! order (`eos_contracts::update` keeps it; a round trip reproduces the
//! bytes), the pointer payload is signed verbatim, chunk ids are sha256 of
//! the chunker's cuts. `fixtures/update` holds releases written by the
//! TypeScript code; `tests/update_vectors.rs` holds this module to them.

pub mod chunker;
mod error;
mod manifest;
pub mod plan;
mod pointer;
mod status;
mod version;

pub use chunker::{CHUNK_AVG, CHUNK_MAX, CHUNK_MIN, ContentChunker, chunk_lengths};
pub use error::{UpdateError, UpdateErrorCode};
pub use manifest::{entry_path, link_stays_inside, manifest_problem, parse_manifest, rel_segments};
pub use plan::{
    BundleIndex, FetchRange, FilePart, FileStep, LocalChunk, RANGE_MAX_GAP, RANGE_MAX_LENGTH, UpdatePlan,
    chunks_within, coalesce_spans, plan_update,
};
pub use pointer::{offered_release, parse_signed_pointer, platform_name, platform_named};
pub use status::{can_update_transition, update_transitions};
pub use version::{compare_versions, is_newer_version};

/// The installed app that may update itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInstall {
    pub version: String,
    /// The installed app bundle (`…/Eos.app`).
    pub root: String,
    pub platform: eos_contracts::update::UpdatePlatform,
}

/// A release brought onto this disk, ready to take the installed app's place.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StagedUpdate {
    pub version: String,
    /// The staged bundle.
    pub path: String,
    /// What this update downloaded, and what the whole release would have.
    pub bytes: i64,
    pub full: i64,
    pub notes: Option<String>,
}
