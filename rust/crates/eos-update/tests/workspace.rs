//! The staging workspace and the bundle indexer on throwaway folders, fed with
//! the fixture releases the TypeScript publisher wrote (`rust/fixtures/update`).

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use eos_contracts::update::{UpdateEntry, UpdateManifest, UpdateNotice, UpdateNoticeKind};
use eos_core::net::updates::{BundleIndexer, StageRequest, UpdateWorkspace};
use eos_domain::update::{
    FetchRange, FileStep, StagedUpdate, UpdateErrorCode, UpdatePlan, parse_manifest, plan_update,
};
use eos_testkit::update::{read, release};
use eos_update::{FsBundleIndexer, FsUpdateWorkspace, scan_bundle, tree_mismatch};

struct Rig {
    tmp: tempfile::TempDir,
    workspace: FsUpdateWorkspace,
    manifest: Arc<UpdateManifest>,
    plan: Arc<UpdatePlan>,
}

impl Rig {
    /// 9.0.0 installed under `<tmp>/Applications/Eos.app`, 9.0.1 planned.
    async fn new() -> Self {
        let tmp = tempfile::tempdir().expect("dir");
        let installed = tmp.path().join("Applications/Eos.app");
        release().write_bundle(&installed, false);
        let manifest = Arc::new(parse_manifest(&read("manifest-9.0.1.json")).expect("manifest"));
        let index = FsBundleIndexer.index(&installed).await.expect("indexed");
        let plan = Arc::new(plan_update(&index, &manifest));
        let workspace = FsUpdateWorkspace::new(tmp.path().join("home/.eos/updates"), true);
        Self { tmp, workspace, manifest, plan }
    }

    fn installed(&self) -> String {
        self.tmp.path().join("Applications/Eos.app").to_string_lossy().into_owned()
    }

    fn range_bytes(&self, range: &FetchRange) -> Vec<u8> {
        let pack = read(&format!("feed/{}", self.manifest.packs[range.pack as usize]));
        pack[range.offset as usize..(range.offset + range.length) as usize].to_vec()
    }

    async fn fetch_all(&self) {
        for range in &self.plan.ranges {
            assert!(!self.workspace.has_range("9.0.1", *range).await);
            self.workspace
                .put_range("9.0.1", *range, self.range_bytes(range), self.manifest.clone())
                .await
                .expect("kept");
            assert!(self.workspace.has_range("9.0.1", *range).await);
        }
    }

    fn request(&self) -> StageRequest {
        StageRequest {
            version: "9.0.1".into(),
            manifest: self.manifest.clone(),
            plan: self.plan.clone(),
            installed_root: self.installed(),
        }
    }
}

#[tokio::test]
async fn the_new_bundle_is_built_beside_the_installed_one_and_matches_its_manifest() {
    let rig = Rig::new().await;
    let rel = release();
    assert!(rig.plan.files.iter().any(|s| matches!(s, FileStep::Copy { .. })));
    assert!(rig.plan.files.iter().any(|s| matches!(s, FileStep::Assemble { .. })));
    assert!(rig.plan.files.iter().any(|s| matches!(s, FileStep::Whole { .. })));
    rig.fetch_all().await;

    let staged = rig.workspace.stage(rig.request()).await.expect("staged");
    let staged = Path::new(&staged);
    assert_eq!(staged, rig.workspace.dir().join("staged/9.0.1/Eos.app"), "same volume: staged under the update folder");
    assert_eq!(tree_mismatch(&rig.manifest.entries, &scan_bundle(staged, false).expect("scan"), true), None);

    // Byte for byte what the second release holds, modes and links included.
    for entry in &rel.tree {
        let path = staged.join(&entry.path);
        if let Some(target) = &entry.link {
            assert_eq!(fs::read_link(&path).expect("link"), Path::new(target));
        } else if !entry.dir {
            assert!(fs::read(&path).expect("file") == rel.file_bytes(entry, true), "{}", entry.path);
            let mode = fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode, entry.mode.unwrap_or(0o644), "{}", entry.path);
        }
    }
    // The installed app was only read.
    let installed = scan_bundle(Path::new(&rig.installed()), false).expect("scan");
    let first = parse_manifest(&read("manifest-9.0.0.json")).expect("manifest");
    assert_eq!(tree_mismatch(&first.entries, &installed, true), None);

    // Staging again starts from nothing and gives the same tree.
    fs::write(staged.join("Contents/stray"), "left over").expect("stray");
    let again = rig.workspace.stage(rig.request()).await.expect("staged again");
    assert!(!Path::new(&again).join("Contents/stray").exists());
}

#[tokio::test]
async fn fetched_bytes_whose_chunks_do_not_match_are_refused_and_not_kept() {
    let rig = Rig::new().await;
    let range = rig.plan.ranges[0];
    let mut damaged = rig.range_bytes(&range);
    let middle = damaged.len() / 2;
    damaged[middle] ^= 0xff;
    let err = rig.workspace.put_range("9.0.1", range, damaged, rig.manifest.clone()).await.expect_err("refused");
    assert_eq!(err.code, UpdateErrorCode::Corrupt);
    assert!(err.message.starts_with("chunk ") && err.message.ends_with(" came down damaged"), "{}", err.message);
    assert!(!rig.workspace.has_range("9.0.1", range).await);

    let err = rig.workspace.put_range("9.0.1", range, b"junk".to_vec(), rig.manifest.clone()).await.expect_err("short");
    assert_eq!(err.code, UpdateErrorCode::Corrupt);
}

#[tokio::test]
async fn a_bundle_cannot_be_built_from_ranges_that_were_never_fetched() {
    let rig = Rig::new().await;
    let err = rig.workspace.stage(rig.request()).await.expect_err("nothing fetched");
    assert_eq!((err.code, err.message.as_str()), (UpdateErrorCode::Corrupt, "a needed chunk was never fetched"));
}

#[tokio::test]
async fn an_installed_file_that_changed_since_it_was_indexed_fails_the_build() {
    let rig = Rig::new().await;
    rig.fetch_all().await;
    // The binary is rebuilt from its own installed chunks plus one new one.
    fs::write(Path::new(&rig.installed()).join("Contents/MacOS/Eos"), vec![1u8; 150_000]).expect("overwrite");
    let err = rig.workspace.stage(rig.request()).await.expect_err("differs");
    assert_eq!(err.code, UpdateErrorCode::Corrupt);
    assert_eq!(err.message, "Contents/MacOS/Eos did not come out as the release has it");
}

#[test]
fn the_first_difference_between_a_tree_and_its_manifest_is_named() {
    let tmp = tempfile::tempdir().expect("dir");
    let root = tmp.path().join("Eos.app");
    release().write_bundle(&root, false);
    let manifest = parse_manifest(&read("manifest-9.0.0.json")).expect("manifest");
    let scan = || scan_bundle(&root, false).expect("scan");
    assert_eq!(tree_mismatch(&manifest.entries, &scan(), true), None);

    fs::set_permissions(root.join("Contents/MacOS/Eos"), fs::Permissions::from_mode(0o644)).expect("mode");
    assert_eq!(tree_mismatch(&manifest.entries, &scan(), true).as_deref(), Some("Contents/MacOS/Eos differs"));
    assert_eq!(
        tree_mismatch(&manifest.entries, &scan(), false),
        None,
        "where files keep no modes, they are not compared"
    );
    fs::set_permissions(root.join("Contents/MacOS/Eos"), fs::Permissions::from_mode(0o755)).expect("mode");

    fs::set_permissions(root.join("Contents/Resources"), fs::Permissions::from_mode(0o700)).expect("mode");
    assert_eq!(tree_mismatch(&manifest.entries, &scan(), true).as_deref(), Some("Contents/Resources has mode 700"));
    fs::set_permissions(root.join("Contents/Resources"), fs::Permissions::from_mode(0o755)).expect("mode");

    fs::remove_file(root.join("Contents/Resources/current")).expect("unlink");
    std::os::unix::fs::symlink("empty", root.join("Contents/Resources/current")).expect("link");
    assert_eq!(
        tree_mismatch(&manifest.entries, &scan(), true).as_deref(),
        Some("Contents/Resources/current links elsewhere")
    );

    fs::write(root.join("Contents/extra"), "x").expect("extra");
    let entries = manifest.entries.iter().filter(|e| matches!(e, UpdateEntry::File(_))).count();
    assert!(entries > 0);
    assert_eq!(
        tree_mismatch(&manifest.entries, &scan(), true),
        Some(format!("{} entries instead of {}", manifest.entries.len() + 1, manifest.entries.len()))
    );
}

#[tokio::test]
async fn what_is_staged_is_remembered_until_cleared_and_other_versions_downloads_go() {
    let tmp = tempfile::tempdir().expect("dir");
    let workspace = FsUpdateWorkspace::new(tmp.path().join("updates"), true);
    assert_eq!(workspace.staged().await, None);

    let bundle = tmp.path().join("updates/staged/9.0.1/Eos.app");
    fs::create_dir_all(&bundle).expect("bundle");
    let staged = StagedUpdate {
        version: "9.0.1".into(),
        path: bundle.to_string_lossy().into_owned(),
        bytes: 800_000,
        full: 230_000_000,
        notes: Some("# notes".into()),
    };
    workspace.mark_staged(&staged).await.expect("recorded");
    // The record is the TypeScript app's: either era reads the other's.
    let record = fs::read_to_string(tmp.path().join("updates/staged.json")).expect("record");
    assert_eq!(
        record,
        format!(
            r##"{{"version":"9.0.1","path":"{}","bytes":800000,"full":230000000,"notes":"# notes"}}"##,
            bundle.display()
        )
    );
    assert_eq!(workspace.staged().await, Some(staged));

    for version in ["9.0.0", "9.0.1"] {
        fs::create_dir_all(tmp.path().join("updates/downloads").join(version)).expect("downloads");
    }
    fs::create_dir_all(tmp.path().join("updates/previous/Eos.app")).expect("previous");
    workspace.clear(Some("9.0.1")).await.expect("cleared");
    assert_eq!(workspace.staged().await, None);
    assert!(!tmp.path().join("updates/staged").exists());
    assert!(!tmp.path().join("updates/downloads/9.0.0").exists());
    assert!(tmp.path().join("updates/downloads/9.0.1").exists(), "the version being fetched keeps its ranges");
    workspace.clear(None).await.expect("cleared");
    assert!(!tmp.path().join("updates/downloads").exists());
    assert!(tmp.path().join("updates/previous/Eos.app").exists(), "the app set aside for a rollback stays");

    // A record whose bundle is gone (the applier moved it into place) counts for nothing.
    fs::write(tmp.path().join("updates/staged.json"), record).expect("stale record");
    assert_eq!(workspace.staged().await, None);
}

#[tokio::test]
async fn the_last_version_and_how_the_last_swap_ended_are_read_as_the_applier_left_them() {
    let tmp = tempfile::tempdir().expect("dir");
    let workspace = FsUpdateWorkspace::new(tmp.path().join("updates"), true);
    assert_eq!(workspace.last_version().await, None);
    workspace.set_last_version("0.1.5").await.expect("recorded");
    assert_eq!(workspace.last_version().await.as_deref(), Some("0.1.5"));
    fs::write(tmp.path().join("updates/last-version"), "0.1.4\n").expect("write");
    assert_eq!(workspace.last_version().await.as_deref(), Some("0.1.4"));

    assert_eq!(workspace.result().await, None);
    workspace.dismiss_result().await.expect("nothing to dismiss");
    // As either applier writes it.
    fs::write(tmp.path().join("updates/result.json"), r#"{"kind":"rolled-back","version":"0.2.0","from":"0.1.5"}"#)
        .expect("result");
    let result = workspace.result().await.expect("a result");
    assert!(!result.dismissed);
    assert_eq!(
        result.notice,
        UpdateNotice {
            kind: UpdateNoticeKind::RolledBack,
            version: eos_contracts::update::AppVersion("0.2.0".into()),
            from: eos_contracts::update::AppVersion("0.1.5".into()),
        }
    );
    workspace.dismiss_result().await.expect("dismissed");
    assert_eq!(
        fs::read_to_string(tmp.path().join("updates/result.json")).expect("result"),
        r#"{"kind":"rolled-back","version":"0.2.0","from":"0.1.5","dismissed":true}"#
    );
    assert!(workspace.result().await.expect("still there").dismissed);

    fs::write(tmp.path().join("updates/result.json"), r#"{"kind":"exploded"}"#).expect("junk");
    assert_eq!(workspace.result().await, None);
}
