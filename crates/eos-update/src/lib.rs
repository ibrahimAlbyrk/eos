//! In-app updates on disk and on the network.
//!
//! Only a release build updates itself ([`resolve_install`]). The feed is
//! static files: an Ed25519-signed pointer per platform → a manifest of the
//! bundle's tree with every file as content-defined chunks → per-release packs
//! holding only new chunks, one zstd frame per chunk. An install fetches only
//! the chunks it lacks.
//!
//! - [`HttpUpdateFeed`]: the feed over HTTPS (retries, size caps, the
//!   manifest pinned by the pointer's hash).
//! - [`Ed25519Keys`]: the pointer's signature against the keys compiled in
//!   (`eos_contracts::update::UPDATE_PUBLIC_KEYS`).
//! - [`scan_bundle`]: the one reader of a bundle's tree, for the publisher,
//!   the installed app's index ([`FsBundleIndexer`]) and the staged copy's check.
//! - [`FsUpdateWorkspace`]: fetched ranges and the staged bundle under
//!   `~/.eos/updates`, built beside the installed app with clone copies.
//! - [`PlatformBundleCheck`]: the system's word on a staged app.
//! - [`build_release`]: the publisher (`cargo xtask publish-update`).
//! - [`handover`]: what the app leaves for the applier and for the version
//!   that follows it.
//! - [`legacy`]: retiring what the TypeScript-era app left running.
//!
//! The rules (chunker, manifest checks, download plan) are `eos_domain::update`;
//! the ports are `eos_core::net::updates`.

mod bundle_check;
mod error;
mod feed;
mod fsx;
pub mod handover;
mod indexer;
mod install;
pub mod legacy;
mod publish;
mod scan;
mod signature;
mod workspace;

pub use bundle_check::PlatformBundleCheck;
pub use error::Error;
pub use feed::{BaseUrl, HttpUpdateFeed, open_manifest};
pub use indexer::{FsBundleIndexer, index_of};
pub use install::resolve_install;
pub use publish::{BuiltRelease, ReleaseInput, build_release};
pub use scan::{ScannedChunk, ScannedEntry, scan_bundle};
pub use signature::{Ed25519Keys, public_key_of, sign_payload};
pub use workspace::{FsUpdateWorkspace, tree_mismatch};
