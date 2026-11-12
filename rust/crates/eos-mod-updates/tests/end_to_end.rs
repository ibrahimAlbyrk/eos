//! One release to the next over the real adapter: a feed built by the release
//! builder and served over HTTP on loopback, the real bundle indexer and
//! staging workspace on throwaway bundles
//! (`infra/src/__tests__/update.test.ts`, "update feed + workspace, end to end").
//! Only the system's bundle check and the shell's hand-over are stand-ins:
//! nothing here is signed, and nothing is swapped.

#![cfg(unix)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::update::{UpdateEntry, UpdateManifest, UpdatePhase, UpdatePlatform, UpdateRestartRequestWhen};
use eos_domain::update::{UpdateErrorCode, UpdateInstall};
use eos_mod_updates::{
    Cancel, CheckTrigger, DownloadDeps, DownloadProgress, UpdateDeps, UpdateService, check_for_update, download_update,
};
use eos_testkit::update::server::FeedServer;
use eos_testkit::update::{noise, release};
use eos_testkit::{FakeBundleCheck, FakeTopLevelAgents, FakeUpdateApplier};
use eos_update::{
    Ed25519Keys, FsBundleIndexer, FsUpdateWorkspace, HttpUpdateFeed, ReleaseInput, build_release, public_key_of,
    scan_bundle, tree_mismatch,
};

/// Repeats farther apart than a chunk: whole, the file compresses far better
/// than cut into chunks (like a bundle that inlines the same module twice).
fn long_repeats(seed: u32) -> Vec<u8> {
    let block = noise(100_000, seed);
    (0..6)
        .flat_map(|i| {
            let mut copy = block.clone();
            copy[i * 1000] ^= 0xff;
            copy
        })
        .collect()
}

fn make_bundle(root: &Path, files: &[(&str, &[u8], u32)], link: (&str, &str)) {
    for (path, bytes, mode) in files {
        let abs = root.join(path);
        fs::create_dir_all(abs.parent().expect("parent")).expect("dirs");
        fs::write(&abs, bytes).expect("file");
        fs::set_permissions(&abs, fs::Permissions::from_mode(*mode)).expect("mode");
    }
    std::os::unix::fs::symlink(link.1, root.join(link.0)).expect("link");
}

/// Two versions of an app, the feed that holds both, and its server.
struct Rig {
    tmp: tempfile::TempDir,
    server: FeedServer,
    edited: Vec<u8>,
    second: UpdateManifest,
    keys: Ed25519Keys,
}

impl Rig {
    async fn new() -> Self {
        let tmp = tempfile::tempdir().expect("dir");
        let rel = release();
        let shared = noise(2_000_000, 7);
        let mut edited = shared[..1_000_000].to_vec();
        edited.extend_from_slice(b"signature moved");
        edited.extend_from_slice(&shared[1_000_000..]);
        let (v1, v2, feed) = (tmp.path().join("v1/Eos.app"), tmp.path().join("v2/Eos.app"), tmp.path().join("feed"));
        make_bundle(
            &v1,
            &[
                ("Contents/MacOS/Eos", &shared, 0o644),
                ("Contents/Resources/ui.js", &long_repeats(2), 0o644),
                ("Contents/Resources/gone.txt", b"old", 0o644),
            ],
            ("Contents/Current", "MacOS"),
        );
        make_bundle(
            &v2,
            &[
                ("Contents/MacOS/Eos", &edited, 0o755),
                ("Contents/Resources/ui.js", &long_repeats(3), 0o644),
                ("Contents/Resources/new.txt", b"new", 0o644),
            ],
            ("Contents/Current", "Resources"),
        );
        let input = |app_root, version, previous, notes| ReleaseInput {
            app_root,
            version,
            platform: UpdatePlatform::DarwinArm64,
            previous,
            out_dir: &feed,
            notes,
            signing_key: &rel.private_key,
            released_at: "2026-10-29T12:00:00.000Z",
            level: Some(3),
        };
        let first = build_release(&input(&v1, "0.1.1", None, None)).expect("first release");
        let second =
            build_release(&input(&v2, "0.1.2", Some(&first.manifest), Some("# 0.1.2\n"))).expect("second release");
        assert!(second.pack_bytes < first.pack_bytes / 2, "{} vs {}", second.pack_bytes, first.pack_bytes);
        assert_eq!(second.whole_files, 1, "ui.js was rewritten: cheaper whole");
        assert_eq!(public_key_of(&rel.private_key).expect("key"), rel.public_key);

        let server = FeedServer::serve(&feed).await;
        let keys = Ed25519Keys::new(&[&rel.public_key]).expect("keys");
        Self { tmp, server, edited, second: second.manifest, keys }
    }

    fn installed(&self) -> PathBuf {
        self.tmp.path().join("v1/Eos.app")
    }

    fn deps(&self) -> DownloadDeps {
        let base = self.server.base.clone();
        let feed = HttpUpdateFeed::new(Arc::new(move || base.clone())).expect("client");
        DownloadDeps {
            feed: Arc::new(feed.with_backoff([Duration::ZERO; 3])),
            indexer: Arc::new(FsBundleIndexer),
            workspace: Arc::new(FsUpdateWorkspace::new(self.tmp.path().join("updates"), true)),
            bundle_check: Arc::new(FakeBundleCheck::default()),
        }
    }

    /// The staged bundle is the second release, byte for byte.
    fn assert_staged(&self, staged: &Path) {
        assert_eq!(tree_mismatch(&self.second.entries, &scan_bundle(staged, false).expect("scan"), true), None);
        assert!(fs::read(staged.join("Contents/MacOS/Eos")).expect("binary") == self.edited);
        assert_eq!(fs::read_link(staged.join("Contents/Current")).expect("link"), Path::new("Resources"));
        assert!(!staged.join("Contents/Resources/gone.txt").exists());
        assert!(self.second.entries.iter().any(|e| matches!(e, UpdateEntry::Link(_))));
    }
}

#[derive(Default)]
struct Totals(std::sync::Mutex<Vec<(i64, i64)>>);

impl DownloadProgress for Totals {
    fn progress(&self, done: i64, total: i64) {
        self.0.lock().expect("lock").push((done, total));
    }
    fn staging(&self) {}
}

#[tokio::test(flavor = "multi_thread")]
async fn one_version_updates_to_the_next_fetching_only_what_changed() {
    let rig = Rig::new().await;
    let deps = rig.deps();
    let mac = UpdatePlatform::DarwinArm64;

    let pointer =
        check_for_update(deps.feed.as_ref(), &rig.keys, mac, "0.1.1").await.expect("checked").expect("a newer release");
    assert_eq!(pointer.version.0, "0.1.2");
    assert_eq!(check_for_update(deps.feed.as_ref(), &rig.keys, mac, "0.1.2").await.expect("checked"), None);
    // Signed by a key this app does not trust: refused before anything else is read.
    let strangers = Ed25519Keys::trusted().expect("the app's own keys");
    let refused = check_for_update(deps.feed.as_ref(), &strangers, mac, "0.1.1").await.expect_err("refused");
    assert_eq!(refused.code, UpdateErrorCode::BadSignature);

    let progress = Totals::default();
    let before = rig.server.served_bytes();
    let installed = rig.installed().to_string_lossy().into_owned();
    let staged = download_update(&deps, &pointer, &installed, &progress, &Cancel::default()).await.expect("staged");
    let fetched = rig.server.served_bytes() - before;
    let seen = progress.0.lock().expect("lock").clone();
    let total = seen[0].1;
    assert_eq!(seen[0], (0, total));
    assert_eq!(seen.last(), Some(&(total, total)));
    assert!(total > 0 && total < 400_000, "planned {total}");
    assert!(fetched < 600_000, "served {fetched}");
    assert_eq!((staged.bytes, staged.notes.as_deref()), (total, Some("# 0.1.2\n")));
    assert!(staged.full > 2_000_000, "the whole release would have cost {}", staged.full);
    rig.assert_staged(Path::new(&staged.path));
    assert_eq!(deps.workspace.staged().await, Some(staged.clone()));

    // Once more: every range is already on disk, so only the manifest and the
    // notes come down again and the bundle is rebuilt from what was kept.
    let before = rig.server.served_bytes();
    let again =
        download_update(&deps, &pointer, &installed, &Totals::default(), &Cancel::default()).await.expect("staged");
    let fetched_again = rig.server.served_bytes() - before;
    assert!(fetched_again < 10_000, "a resumed download served {fetched_again}");
    assert_eq!(again, staged);
    rig.assert_staged(Path::new(&again.path));

    // The installed app was only read.
    assert!(rig.installed().join("Contents/Resources/gone.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_download_stops_and_keeps_what_it_fetched() {
    let rig = Rig::new().await;
    let deps = rig.deps();
    let pointer = check_for_update(deps.feed.as_ref(), &rig.keys, UpdatePlatform::DarwinArm64, "0.1.1")
        .await
        .expect("checked")
        .expect("a newer release");
    let cancel = Cancel::default();
    cancel.cancel();
    let installed = rig.installed().to_string_lossy().into_owned();
    let stopped = download_update(&deps, &pointer, &installed, &Totals::default(), &cancel).await;
    assert!(stopped.is_err() && cancel.is_cancelled());
    assert_eq!(deps.workspace.staged().await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_service_takes_a_release_from_the_feed_to_the_hand_over() {
    let rig = Rig::new().await;
    let h = common::harness(common::Setup::default());
    let applier = Arc::new(FakeUpdateApplier::default());
    let svc = UpdateService::new(UpdateDeps {
        install: Ok(UpdateInstall {
            version: "0.1.1".into(),
            root: rig.installed().to_string_lossy().into_owned(),
            platform: UpdatePlatform::DarwinArm64,
        }),
        download: rig.deps(),
        signature: Arc::new(rig.keys.clone()),
        agents: Arc::new(FakeTopLevelAgents::default()),
        applier: applier.clone(),
        config: h.config.clone(),
        bus: h.kernel.bus.clone(),
        clock: h.clock.clone(),
        spread: Arc::new(|| 0.5),
    });
    svc.check(CheckTrigger::Manual).await;
    let ready = svc.state();
    assert_eq!(ready.status.phase, UpdatePhase::Ready, "{:?}", ready.status.error);
    assert_eq!(ready.notes.as_deref(), Some("# 0.1.2\n"));
    assert!(ready.status.bytes.is_some_and(|bytes| bytes > 0 && bytes < 400_000));

    assert!(svc.restart(UpdateRestartRequestWhen::Now).await);
    for _ in 0..200 {
        if !applier.applied().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let applied = applier.applied();
    assert_eq!(applied.len(), 1);
    assert_eq!((applied[0].version.0.as_str(), applied[0].from.0.as_str()), ("0.1.2", "0.1.1"));
    assert_eq!(Path::new(&applied[0].target), rig.installed());
    rig.assert_staged(Path::new(&applied[0].staged));
}
