//! The release builder against the TypeScript one: for the same bundle, key,
//! time and levels, every file of the feed comes out byte for byte as
//! `infra/src/update/buildRelease.ts` wrote it (`rust/fixtures/update`,
//! frozen from the TypeScript, see `rust/fixtures/README.md`).

#![cfg(unix)]

use std::fs;
use std::path::Path;

use eos_contracts::update::UpdatePlatform;
use eos_domain::update::parse_manifest;
use eos_testkit::update::{read, release};
use eos_update::{ReleaseInput, build_release};

fn same(out: &Path, built: &str, fixture: &str) {
    let ours = fs::read(out.join(built)).unwrap_or_else(|e| panic!("{built}: {e}"));
    assert!(ours == read(fixture), "{built} differs from what TypeScript wrote ({fixture})");
}

#[test]
fn two_releases_come_out_byte_for_byte_as_typescript_builds_them() {
    let rel = release();
    let tmp = tempfile::tempdir().expect("dir");
    let out = tmp.path().join("feed");

    // The feed's first release: no previous manifest, the quick level.
    rel.write_bundle(&tmp.path().join("1/Eos.app"), false);
    let first = build_release(&ReleaseInput {
        app_root: &tmp.path().join("1/Eos.app"),
        version: "9.0.0",
        platform: UpdatePlatform::DarwinArm64,
        previous: None,
        out_dir: &out,
        notes: Some("first\n"),
        signing_key: &rel.private_key,
        released_at: &rel.released_at,
        level: None,
    })
    .expect("built");
    same(&out, "packs/darwin-arm64/9.0.0.pack", "feed/packs/darwin-arm64/9.0.0.pack");
    same(&out, "releases/9.0.0/darwin-arm64.manifest.json.zst", "feed/releases/9.0.0/darwin-arm64.manifest.json.zst");
    same(&out, "notes/9.0.0.md", "feed/notes/9.0.0.md");
    same(&out, "stable/darwin-arm64.json", "pointer-9.0.0.json");
    let reported = &rel.built["9.0.0"];
    assert_eq!(first.files, reported.files);
    assert_eq!(
        (first.pack_bytes as u64, first.new_chunks as u64, first.whole_files as u64),
        (reported.pack_bytes, reported.new_chunks, reported.whole_files)
    );

    // The next one, built against the first as the feed serves it: only new
    // chunks are packed, at zstd's best, and one rewritten file goes in whole.
    let previous = parse_manifest(&read("manifest-9.0.0.json")).expect("the published manifest");
    assert_eq!(previous, first.manifest);
    rel.write_bundle(&tmp.path().join("2/Eos.app"), true);
    let second = build_release(&ReleaseInput {
        app_root: &tmp.path().join("2/Eos.app"),
        version: "9.0.1",
        platform: UpdatePlatform::DarwinArm64,
        previous: Some(&previous),
        out_dir: &out,
        notes: None,
        signing_key: &rel.private_key,
        released_at: &rel.released_at,
        level: None,
    })
    .expect("built");
    same(&out, "packs/darwin-arm64/9.0.1.pack", "feed/packs/darwin-arm64/9.0.1.pack");
    same(&out, "releases/9.0.1/darwin-arm64.manifest.json.zst", "feed/releases/9.0.1/darwin-arm64.manifest.json.zst");
    same(&out, "stable/darwin-arm64.json", "pointer-9.0.1.json");
    assert!(!out.join("notes/9.0.1.md").exists());
    let reported = &rel.built["9.0.1"];
    assert_eq!(second.files, reported.files);
    assert_eq!(
        (second.pack_bytes as u64, second.new_chunks as u64, second.whole_files as u64),
        (reported.pack_bytes, reported.new_chunks, reported.whole_files)
    );
    assert_eq!(second.whole_files, 1);
    assert_eq!(second.pointer_path, "stable/darwin-arm64.json");
}

#[test]
fn a_release_whose_bundle_did_not_change_packs_nothing() {
    let rel = release();
    let tmp = tempfile::tempdir().expect("dir");
    rel.write_bundle(&tmp.path().join("Eos.app"), false);
    let previous = parse_manifest(&read("manifest-9.0.0.json")).expect("manifest");
    let built = build_release(&ReleaseInput {
        app_root: &tmp.path().join("Eos.app"),
        version: "9.0.2",
        platform: UpdatePlatform::DarwinArm64,
        previous: Some(&previous),
        out_dir: &tmp.path().join("feed"),
        notes: Some(""),
        signing_key: &rel.private_key,
        released_at: &rel.released_at,
        level: None,
    })
    .expect("built");
    assert_eq!((built.new_chunks, built.pack_bytes), (0, 0));
    assert_eq!(built.files, ["releases/9.0.2/darwin-arm64.manifest.json.zst", "stable/darwin-arm64.json"]);
    assert!(!tmp.path().join("feed/packs").exists(), "no pack is written for nothing");
    assert_eq!(built.manifest.packs, ["packs/darwin-arm64/9.0.0.pack"]);
}

#[test]
fn a_key_that_is_no_key_stops_the_build_with_its_reason() {
    let rel = release();
    let tmp = tempfile::tempdir().expect("dir");
    rel.write_bundle(&tmp.path().join("Eos.app"), false);
    let err = build_release(&ReleaseInput {
        app_root: &tmp.path().join("Eos.app"),
        version: "9.0.0",
        platform: UpdatePlatform::DarwinArm64,
        previous: None,
        out_dir: &tmp.path().join("feed"),
        notes: None,
        signing_key: "AAAA",
        released_at: &rel.released_at,
        level: None,
    })
    .expect_err("no key");
    assert_eq!(err.to_string(), "the signing key is not an Ed25519 key in PKCS#8");
    assert!(!tmp.path().join("feed/stable").exists(), "no pointer without a signature");
}
