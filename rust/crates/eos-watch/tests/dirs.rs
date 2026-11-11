//! The folder watcher on real folders and real system events.

mod support;

use std::fs;
use std::sync::Arc;

use eos_contracts::{FsChangeEventChangesItem, FsChangeKind};
use eos_core::SystemClock;
use eos_core::os::FileWatcher;
use eos_watch::DirWatcher;
use support::{Collected, Dir, open_fds, text, thread_count};

type Changes = Arc<Collected<FsChangeEventChangesItem>>;

fn watcher() -> (DirWatcher, Changes) {
    let changes: Changes = Collected::new();
    let sink = changes.clone();
    let watcher = DirWatcher::new(
        Arc::new(SystemClock),
        Arc::new(move |event| {
            assert!(!event.changes.is_empty(), "a batch is never empty");
            for change in event.changes {
                sink.push(change);
            }
        }),
    );
    (watcher, changes)
}

fn saw(changes: &Changes, dir: &Dir, kind: FsChangeKind, name: &str) -> bool {
    let path = text(&dir.join(name));
    changes.wait_for(|all| all.iter().any(|c| c.kind == kind && c.path == path))
}

#[test]
fn direct_entries_report_add_change_unlink_and_folders() {
    let dir = Dir::new();
    for name in ["f0.txt", "f1.txt", "f2.txt"] {
        dir.write(name, "x\n");
    }
    let (watcher, changes) = watcher();
    let _lease = watcher.watch(&dir.path);

    dir.write("f0.txt", "edited\n");
    assert!(saw(&changes, &dir, FsChangeKind::Change, "f0.txt"), "an edit is a change");

    // Editors save by writing a temporary file and renaming it over the target.
    dir.write("f1.txt.tmp", "saved\n");
    fs::rename(dir.join("f1.txt.tmp"), dir.join("f1.txt")).expect("rename");
    assert!(saw(&changes, &dir, FsChangeKind::Change, "f1.txt"), "an atomic save is a change");

    dir.write("new.txt", "n\n");
    assert!(saw(&changes, &dir, FsChangeKind::Add, "new.txt"));

    fs::remove_file(dir.join("f2.txt")).expect("remove");
    assert!(saw(&changes, &dir, FsChangeKind::Unlink, "f2.txt"));

    fs::create_dir(dir.join("sub")).expect("mkdir");
    assert!(saw(&changes, &dir, FsChangeKind::AddDir, "sub"));

    fs::remove_dir(dir.join("sub")).expect("rmdir");
    assert!(saw(&changes, &dir, FsChangeKind::UnlinkDir, "sub"));

    let watched = text(&dir.path);
    for change in changes.all() {
        assert_eq!(change.dir, watched);
        assert!(change.ts.as_f64() > 1_700_000_000_000.0);
    }
}

#[test]
fn a_rename_is_an_unlink_then_an_add_in_one_batch_order() {
    let dir = Dir::new();
    dir.write("created.txt", "made\n");
    let (watcher, changes) = watcher();
    let _lease = watcher.watch(&dir.path);
    fs::rename(dir.join("created.txt"), dir.join("renamed.txt")).expect("rename");
    assert!(saw(&changes, &dir, FsChangeKind::Add, "renamed.txt"));
    assert!(saw(&changes, &dir, FsChangeKind::Unlink, "created.txt"));
    let order: Vec<_> = changes.all().into_iter().map(|c| c.kind).collect();
    let (gone, came) = (
        order.iter().position(|k| *k == FsChangeKind::Unlink).expect("unlink"),
        order.iter().position(|k| *k == FsChangeKind::Add).expect("add"),
    );
    assert!(gone < came, "the old name goes before the new one arrives: {order:?}");
}

#[test]
fn nested_changes_and_ignored_names_are_not_reported() {
    let dir = Dir::new();
    fs::create_dir(dir.join("sub")).expect("mkdir");
    let (watcher, changes) = watcher();
    let _lease = watcher.watch(&dir.path);

    dir.write("sub/nested.txt", "n\n");
    fs::create_dir(dir.join("node_modules")).expect("mkdir");
    dir.write(".DS_Store", "x");
    // A change that is reported, made after the quiet ones: once it has
    // arrived, anything the quiet ones caused would have arrived too.
    dir.write("marker.txt", "m\n");
    assert!(saw(&changes, &dir, FsChangeKind::Add, "marker.txt"));
    let reported: Vec<String> = changes.all().into_iter().map(|c| c.path).collect();
    assert_eq!(reported, [text(&dir.join("marker.txt"))]);
}

#[test]
fn a_folder_stays_watched_until_its_last_lease_is_dropped() {
    let (first, second) = (Dir::new(), Dir::new());
    let (watcher, changes) = watcher();
    let (a, b) = (watcher.watch(&first.path), watcher.watch(&first.path));
    let _other = watcher.watch(&second.path);
    assert_eq!(watcher.watched(), 2, "two leases on one folder share a watch");

    drop(a);
    first.write("still.txt", "x");
    assert!(saw(&changes, &first, FsChangeKind::Add, "still.txt"), "one lease is still held");

    drop(b);
    assert_eq!(watcher.watched(), 1);
    first.write("unseen.txt", "x");
    second.write("marker.txt", "m");
    assert!(saw(&changes, &second, FsChangeKind::Add, "marker.txt"));
    assert!(!changes.all().iter().any(|c| c.path.ends_with("unseen.txt")), "a released folder reports nothing");
}

#[test]
fn a_folder_that_is_not_there_can_be_watched_and_released() {
    let dir = Dir::new();
    let (watcher, _changes) = watcher();
    let lease = watcher.watch(&dir.join("missing"));
    assert_eq!(watcher.watched(), 1);
    drop(lease);
    assert_eq!(watcher.watched(), 0);
}

#[test]
fn closing_ends_every_watch_and_later_watches_do_nothing() {
    let dir = Dir::new();
    let (watcher, changes) = watcher();
    let lease = watcher.watch(&dir.path);
    watcher.close_all();
    assert_eq!(watcher.watched(), 0);
    drop(lease);
    let late = watcher.watch(&dir.path);
    assert_eq!(watcher.watched(), 0);
    drop(late);
    assert_eq!(changes.len(), 0);
}

// A descriptor per watched file would push a large checkout past the limit
// at which the system refuses to start any child process.
#[test]
fn a_large_folder_costs_no_descriptor_per_file() {
    let dir = Dir::new();
    for i in 0..500 {
        dir.write(&format!("f{i}.txt"), "x\n");
    }
    let (watcher, changes) = watcher();
    let before = open_fds();
    let _lease = watcher.watch(&dir.path);
    dir.write("f1.txt", "y\n");
    assert!(saw(&changes, &dir, FsChangeKind::Change, "f1.txt"));
    let opened = open_fds().saturating_sub(before);
    assert!(opened < 20, "the watch opened {opened} descriptors for a 500-file folder");
}

#[test]
fn a_dropped_watcher_gives_back_its_thread_and_descriptors() {
    let dir = Dir::new();
    // The first watcher of a process may leave shared system machinery behind;
    // it is created and dropped before anything is measured.
    drop(watcher().0.watch(&dir.path));
    let (fds, threads) = (open_fds(), thread_count());
    for round in 0..40 {
        let (watcher, changes) = watcher();
        let lease = watcher.watch(&dir.path);
        if round % 10 == 0 {
            dir.write(&format!("round-{round}.txt"), "x");
            assert!(saw(&changes, &dir, FsChangeKind::Add, &format!("round-{round}.txt")));
        }
        // The watcher goes first: the lease it handed out must not keep it alive.
        drop(watcher);
        drop(lease);
    }
    let leaked = open_fds().saturating_sub(fds);
    assert!(leaked < 5, "{leaked} descriptors were left open after 40 watchers");
    if let (Some(before), Some(after)) = (threads, thread_count()) {
        assert!(after < before + 5, "threads grew from {before} to {after} after 40 watchers");
    }
}
