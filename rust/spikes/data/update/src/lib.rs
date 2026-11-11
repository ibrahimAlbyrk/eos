//! Spike 5: the update feed's byte-exact parts — the content-defined chunker,
//! the manifest and the signed pointer — as the TypeScript code defines them
//! (core/src/domain/update/chunker.ts, contracts/src/update.ts,
//! infra/src/update/{buildRelease,bundleScan,ed25519}.ts).

pub mod chunker;
pub mod manifest;
pub mod pointer;
pub mod testgen;
