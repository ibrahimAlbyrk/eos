//! The feed client against a local server (`infra/src/__tests__/update.test.ts`,
//! "http update feed").

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::update::{UpdatePlatform, UpdatePointerManifest};
use eos_core::net::updates::UpdateFeed;
use eos_domain::update::UpdateErrorCode;
use eos_testkit::update::server::FeedServer;
use eos_testkit::update::{read, sha256_hex};
use eos_update::HttpUpdateFeed;

fn feed(base: &str) -> HttpUpdateFeed {
    let base = base.to_owned();
    HttpUpdateFeed::new(Arc::new(move || base.clone())).expect("client").with_backoff([Duration::ZERO; 3])
}

/// The fixture feed with a pointer in place, as the publisher leaves it.
fn fixture_feed(version: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("dir");
    for file in [
        "releases/9.0.0/darwin-arm64.manifest.json.zst",
        "releases/9.0.1/darwin-arm64.manifest.json.zst",
        "packs/darwin-arm64/9.0.0.pack",
        "packs/darwin-arm64/9.0.1.pack",
        "notes/9.0.0.md",
    ] {
        let to = dir.path().join(file);
        fs::create_dir_all(to.parent().expect("parent")).expect("dirs");
        fs::write(to, read(&format!("feed/{file}"))).expect("copy");
    }
    fs::create_dir_all(dir.path().join("stable")).expect("dirs");
    fs::write(dir.path().join("stable/darwin-arm64.json"), read(&format!("pointer-{version}.json"))).expect("pointer");
    dir
}

#[tokio::test]
async fn the_pointer_the_manifest_a_range_and_the_notes_come_down_as_published() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    // A trailing slash on the feed's address must not double up.
    let feed = feed(&format!("{}/", server.base));

    let signed = feed.pointer(UpdatePlatform::DarwinArm64).await.expect("fetched").expect("a pointer");
    assert_eq!(serde_json::to_vec(&signed).expect("json"), read("pointer-9.0.1.json"));
    assert_eq!(
        feed.pointer(UpdatePlatform::Win32X64).await.expect("fetched"),
        None,
        "no release for that platform yet"
    );

    let packed = read("feed/releases/9.0.1/darwin-arm64.manifest.json.zst");
    let reference = UpdatePointerManifest {
        path: "releases/9.0.1/darwin-arm64.manifest.json.zst".into(),
        sha256: sha256_hex(&packed),
        size: packed.len() as i64,
    };
    let manifest = feed.manifest(&reference).await.expect("a manifest");
    assert_eq!(serde_json::to_vec(&manifest).expect("json"), read("manifest-9.0.1.json"));

    let pack = read("feed/packs/darwin-arm64/9.0.1.pack");
    let part = feed.range("packs/darwin-arm64/9.0.1.pack", 100, 5000).await.expect("a range");
    assert_eq!(part, pack[100..5100]);
    assert_eq!(feed.text("notes/9.0.0.md", 64 * 1024).await.expect("notes"), "first\n");
}

#[tokio::test]
async fn a_server_error_is_retried_and_a_lasting_one_is_a_network_failure() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    let feed = feed(&server.base);

    server.answer_next_with(&[503, 429]);
    assert!(feed.pointer(UpdatePlatform::DarwinArm64).await.expect("third time lucky").is_some());
    assert_eq!(server.requests(), 3);

    server.answer_next_with(&[500, 502, 503, 504]);
    let err = feed.pointer(UpdatePlatform::DarwinArm64).await.expect_err("gave up");
    assert_eq!((err.code, err.transient()), (UpdateErrorCode::Network, true));
    assert_eq!(err.message, "stable/darwin-arm64.json: the feed answered 504");
    assert_eq!(server.requests(), 7, "one attempt and three retries");

    // Nothing listens there: no answer at all is a network failure too.
    drop(server);
    let down = feed.pointer(UpdatePlatform::DarwinArm64).await.expect_err("down");
    assert_eq!(down.code, UpdateErrorCode::Network);
}

#[tokio::test]
async fn a_refusal_is_not_retried() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    let feed = feed(&server.base);
    server.answer_next_with(&[403]);
    let err = feed.pointer(UpdatePlatform::DarwinArm64).await.expect_err("refused");
    assert_eq!(
        (err.code, err.message.as_str()),
        (UpdateErrorCode::BadRelease, "stable/darwin-arm64.json: the feed answered 403")
    );
    assert_eq!(server.requests(), 1);
    // Only the pointer may be missing: a missing pack is a broken release.
    let err = feed.range("packs/darwin-arm64/none.pack", 0, 4).await.expect_err("missing");
    assert_eq!(err.code, UpdateErrorCode::BadRelease);
}

#[tokio::test]
async fn a_server_that_ignores_ranges_is_refused() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    server.ignore_ranges();
    let err = feed(&server.base).range("packs/darwin-arm64/9.0.1.pack", 0, 4).await.expect_err("refused");
    assert_eq!(err.code, UpdateErrorCode::BadRelease);
    assert_eq!(err.message, "the feed ignored a range request for packs/darwin-arm64/9.0.1.pack");
}

#[tokio::test]
async fn a_manifest_that_is_not_the_one_its_pointer_names_is_refused() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    let feed = feed(&server.base);
    let packed = read("feed/releases/9.0.1/darwin-arm64.manifest.json.zst");
    let path = "releases/9.0.1/darwin-arm64.manifest.json.zst".to_owned();

    let wrong_hash = UpdatePointerManifest { path: path.clone(), sha256: "0".repeat(64), size: packed.len() as i64 };
    let err = feed.manifest(&wrong_hash).await.expect_err("refused");
    assert_eq!((err.code, err.message.as_str()), (UpdateErrorCode::Corrupt, "the manifest does not match its pointer"));

    // More bytes than the pointer promised are not even read.
    let too_small = UpdatePointerManifest { path, sha256: sha256_hex(&packed), size: 10 };
    let err = feed.manifest(&too_small).await.expect_err("refused");
    assert_eq!(err.code, UpdateErrorCode::BadRelease);
    assert!(err.message.contains("where at most 10 fit"), "{}", err.message);

    // A file that is not a manifest at all, though its hash matches.
    fs::write(dir.path().join("releases/junk.zst"), b"junk").expect("write");
    let junk = UpdatePointerManifest { path: "releases/junk.zst".into(), sha256: sha256_hex(b"junk"), size: 4 };
    let err = feed.manifest(&junk).await.expect_err("refused");
    assert_eq!(err.message, "the manifest does not unpack");
}

#[tokio::test]
async fn an_oversized_pointer_and_a_pointer_that_is_not_one_are_refused() {
    let dir = fixture_feed("9.0.1");
    let server = FeedServer::serve(dir.path()).await;
    let feed = feed(&server.base);
    fs::write(dir.path().join("stable/darwin-arm64.json"), vec![b' '; 40_000]).expect("write");
    let err = feed.pointer(UpdatePlatform::DarwinArm64).await.expect_err("too large");
    assert_eq!(err.message, "the feed sent 40000 bytes where at most 32768 fit");
    fs::write(dir.path().join("stable/darwin-arm64.json"), "{}").expect("write");
    let err = feed.pointer(UpdatePlatform::DarwinArm64).await.expect_err("malformed");
    assert_eq!(err.message, "the release pointer is malformed");
}
