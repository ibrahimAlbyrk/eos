//! What the snapshots keep stays within its bounds: trees (the one used
//! longest ago, one nobody watches first, makes room), folders, patches by
//! bytes, a patch too large to keep, and a tree's state when its last watch ends.

mod support;

use std::time::Duration;

use eos_core::git::{GitDiffs, GitInfo, RepoState};
use eos_git::{SnapshotLimits, Snapshots};
use support::{Dir, adapter, commit_file, init_repo};

fn limits() -> SnapshotLimits {
    SnapshotLimits {
        trees: 3,
        folders: 4,
        keyed: 2,
        patch_bytes: 4_000,
        patch_max: 3_000,
        watched_age: Duration::from_secs(30),
        unwatched_age: Duration::from_secs(30),
    }
}

fn repos(n: usize) -> Vec<Dir> {
    (0..n)
        .map(|i| {
            let repo = init_repo("eos-snap-bounds-");
            commit_file(&repo.path, "a.txt", "a\n", "init");
            repo.write("a.txt", format!("{}\n", "changed line ".repeat(60 * (i + 1))));
            repo
        })
        .collect()
}

#[tokio::test]
async fn trees_and_folders_are_bounded_and_a_watched_tree_is_dropped_last() {
    let all = repos(5);
    let snap = Snapshots::with_limits(adapter(), limits());
    let watched = adapter().git_dirs(&all[0].path).await.expect("a repository");
    snap.watching(&watched, true);
    for repo in &all {
        snap.has_uncommitted_changes(&repo.path).await;
        assert!(snap.kept().trees <= 3 && snap.kept().folders <= 4, "{:?}", snap.kept());
    }
    // The watched tree outlived trees read after it.
    let before = snap.kept();
    snap.unwatching(&watched, true);
    let after = snap.kept();
    assert_eq!((before.trees - after.trees, after.watched), (1, 0), "{before:?} → {after:?}");
}

#[tokio::test]
async fn patches_are_kept_within_their_bytes() {
    let all = repos(4);
    let snap = Snapshots::with_limits(adapter(), limits());
    for repo in &all {
        let patch = snap.full_diff(&repo.path, None).await.expect("a patch");
        let kept = snap.kept().patch_bytes;
        assert!(kept <= 4_000, "{kept} bytes kept");
        if patch.len() > 3_000 {
            // Handed out, never kept.
            assert!(kept < patch.len(), "a patch over the one-patch limit was kept");
        }
    }
    assert!(snap.kept().patch_bytes > 0, "patches that fit are kept");
}

#[tokio::test]
async fn a_trees_state_goes_with_its_last_watch() {
    let repo = repos(1).remove(0);
    let snap = Snapshots::new(adapter());
    let dirs = adapter().git_dirs(&repo.path).await.expect("a repository");
    snap.watching(&dirs, true);
    snap.watching(&dirs, true);
    snap.changed_files(&repo.path, None).await;
    snap.full_diff(&repo.path, None).await;
    snap.unwatching(&dirs, true);
    assert_eq!(snap.kept().trees, 1, "one watch still holds it");
    snap.unwatching(&dirs, true);
    let kept = snap.kept();
    assert_eq!((kept.trees, kept.folders, kept.watched, kept.patch_bytes), (0, 0, 0, 0), "{kept:?}");
}
