//! Putting an app at its place and keeping the one it replaces.
//!
//! The new app is first moved beside the installed one (`.<name>.installing`,
//! a copy when it lies on another volume), so the swap itself is two renames in
//! one folder: the installed app aside (`.<name>.replaced`), the new one in.
//! A failure up to there is undone and leaves the installed app as it was.
//! Then the replaced app goes to the keep place, over what was kept before
//! (only one previous app is kept); if that fails it stays aside, and the
//! caller says where.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The file operations a swap is made of.
pub(crate) trait Disk {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Copies an app bundle with everything macOS keeps on its files.
    fn copy(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
}

/// The disk as it is: `ditto` copies (it keeps links, modes, extended
/// attributes and signatures, as Finder does).
#[derive(Debug, Clone, Copy)]
pub(crate) struct RealDisk;

impl Disk for RealDisk {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        let status = Command::new("/usr/bin/ditto").arg(from).arg(to).stdin(Stdio::null()).status()?;
        if status.success() { Ok(()) } else { Err(io::Error::other(format!("ditto ended with {status}"))) }
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
            Ok(_) => fs::remove_file(path),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Where an app goes, and where the app it replaces is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Slots {
    pub(crate) dest: PathBuf,
    pub(crate) keep: PathBuf,
}

impl Slots {
    /// `<dest folder>/.<name>.installing`: the new app, just before it goes in.
    pub(crate) fn staged(&self) -> PathBuf {
        beside(&self.dest, "installing")
    }

    /// `<dest folder>/.<name>.replaced`: the installed app, just after it came out.
    pub(crate) fn aside(&self) -> PathBuf {
        beside(&self.dest, "replaced")
    }

    /// `<keep folder>/.<name>.old`: what was kept, while the replaced app takes its place.
    fn old(&self) -> PathBuf {
        beside(&self.keep, "old")
    }

    /// What an interrupted run left behind. Each may be someone's only copy of an
    /// app, so they are never removed here: the person decides.
    pub(crate) fn leftovers(&self) -> Vec<PathBuf> {
        [self.staged(), self.aside(), self.old()].into_iter().filter(|path| exists(path)).collect()
    }
}

/// `<folder>/.<name>.<what>`: hidden, and not an `.app`, so nothing launches it.
fn beside(app: &Path, what: &str) -> PathBuf {
    let name = app.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    app.with_file_name(format!(".{name}.{what}"))
}

pub(crate) fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Where the replaced app ended up.
#[derive(Debug)]
pub(crate) enum Previous {
    /// At the keep place.
    Kept,
    /// It could not be moved to the keep place and is still beside the new one.
    Aside { at: PathBuf, error: io::Error },
}

/// Why nothing was swapped.
#[derive(Debug)]
pub(crate) enum Failed {
    /// The installed app is as it was. `new_left_at` is where the app that was
    /// to go in stayed, when it could not be moved back to where it came from.
    Unchanged { step: &'static str, error: io::Error, new_left_at: Option<PathBuf> },
    /// The new app did not go in and the installed one could not be put back:
    /// it is at `at`.
    Stranded { at: PathBuf, error: io::Error },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Moved {
    Renamed,
    Copied,
}

/// Where a copy to `to` is made before it is renamed to `to`. Always an
/// unfinished copy whose original still exists, so it is removed freely.
fn partial(to: &Path) -> PathBuf {
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = name.strip_prefix('.').unwrap_or(&name);
    to.with_file_name(format!(".{name}.partial"))
}

/// Moves `from` to `to`: a rename, or across volumes a copy under a temporary
/// name renamed when complete. A copied `from` is left for the caller.
fn move_app(from: &Path, to: &Path, disk: &dyn Disk) -> io::Result<Moved> {
    match disk.rename(from, to) {
        Ok(()) => Ok(Moved::Renamed),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            let partial = partial(to);
            disk.remove(&partial)?;
            let copied = disk.copy(from, &partial).and_then(|()| disk.rename(&partial, to));
            if copied.is_err() {
                let _ = disk.remove(&partial);
            }
            copied.map(|()| Moved::Copied)
        }
        Err(e) => Err(e),
    }
}

/// Moves the app at `new` to `slots.dest`, and the app that was there to
/// `slots.keep` (`None`: nothing was there). `new` may be the keep place
/// itself (going back): the two apps then trade places.
pub(crate) fn put_in_place(new: &Path, slots: &Slots, disk: &dyn Disk) -> Result<Option<Previous>, Failed> {
    let (staged, aside) = (slots.staged(), slots.aside());
    let moved = move_app(new, &staged, disk).map_err(|error| Failed::Unchanged {
        step: "moving the new app beside the installed one",
        error,
        new_left_at: None,
    })?;
    // Undoing the staging: the new app back where it came from.
    let unstage = |step, error| {
        let back = match moved {
            Moved::Renamed => disk.rename(&staged, new),
            Moved::Copied => disk.remove(&staged),
        };
        let new_left_at = (back.is_err() && moved == Moved::Renamed).then(|| staged.clone());
        Failed::Unchanged { step, error, new_left_at }
    };

    let installed = exists(&slots.dest);
    if installed && let Err(error) = disk.rename(&slots.dest, &aside) {
        return Err(unstage("setting the installed app aside", error));
    }
    if let Err(error) = disk.rename(&staged, &slots.dest) {
        if installed && disk.rename(&aside, &slots.dest).is_err() {
            return Err(Failed::Stranded { at: aside, error });
        }
        return Err(unstage("moving the new app into place", error));
    }
    // The original of a copy is not needed any more (going back, this empties the
    // keep place for the app that was just replaced).
    if moved == Moved::Copied {
        let _ = disk.remove(new);
    }
    Ok(installed.then(|| keep(&aside, slots, disk)))
}

/// Moves the replaced app to the keep place, over what was kept before.
fn keep(aside: &Path, slots: &Slots, disk: &dyn Disk) -> Previous {
    let old = slots.old();
    if let Some(folder) = slots.keep.parent()
        && let Err(error) = fs::create_dir_all(folder)
    {
        return Previous::Aside { at: aside.to_owned(), error };
    }
    let had_kept = exists(&slots.keep);
    if had_kept && let Err(error) = disk.rename(&slots.keep, &old) {
        return Previous::Aside { at: aside.to_owned(), error };
    }
    match move_app(aside, &slots.keep, disk) {
        Ok(moved) => {
            if moved == Moved::Copied {
                let _ = disk.remove(aside);
            }
            if had_kept {
                let _ = disk.remove(&old);
            }
            Previous::Kept
        }
        Err(error) => {
            if had_kept {
                let _ = disk.rename(&old, &slots.keep);
            }
            Previous::Aside { at: aside.to_owned(), error }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    /// A fake app bundle: its name is in `Contents/which`.
    pub(crate) fn app(root: &Path, which: &str) {
        fs::create_dir_all(root.join("Contents/MacOS")).expect("bundle");
        fs::write(root.join("Contents/which"), which).expect("which");
        fs::write(root.join("Contents/MacOS/Eos"), "#!/bin/sh\n").expect("executable");
    }

    /// Which fake app is at `root`, or `-` when there is none.
    pub(crate) fn which(root: &Path) -> String {
        fs::read_to_string(root.join("Contents/which")).unwrap_or_else(|_| "-".to_owned())
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Op {
        Rename,
        Copy,
    }

    /// The real disk, with a failure planted on one operation (matched by its
    /// target, the first `times` times it is asked), and optionally every
    /// rename into or out of one folder treated as crossing volumes.
    #[derive(Debug)]
    pub(crate) struct FlakyDisk {
        pub(crate) fail: Option<(Op, PathBuf)>,
        pub(crate) times: Cell<u32>,
        /// Renames from or to below this folder cross volumes.
        pub(crate) other_volume: Option<PathBuf>,
        pub(crate) copies: RefCell<Vec<PathBuf>>,
    }

    impl Default for FlakyDisk {
        fn default() -> Self {
            Self { fail: None, times: Cell::new(1), other_volume: None, copies: RefCell::default() }
        }
    }

    impl FlakyDisk {
        pub(crate) fn failing(op: Op, target: PathBuf) -> Self {
            Self { fail: Some((op, target)), ..Self::default() }
        }

        fn planted(&self, op: Op, target: &Path) -> io::Result<()> {
            match &self.fail {
                Some((want, path)) if *want == op && path == target && self.times.get() > 0 => {
                    self.times.set(self.times.get() - 1);
                    Err(io::Error::other("planted failure"))
                }
                _ => Ok(()),
            }
        }
    }

    impl Disk for FlakyDisk {
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.planted(Op::Rename, to)?;
            if let Some(other) = &self.other_volume
                && from.starts_with(other) != to.starts_with(other)
            {
                return Err(io::Error::from(io::ErrorKind::CrossesDevices));
            }
            RealDisk.rename(from, to)
        }

        fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.planted(Op::Copy, to)?;
            self.copies.borrow_mut().push(to.to_owned());
            RealDisk.copy(from, to)
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            RealDisk.remove(path)
        }
    }

    /// `<tmp>/Applications/Eos.app`, `<tmp>/build/Eos.app` and the keep place
    /// `<tmp>/home/updates/previous/Eos.app`.
    pub(crate) struct Rig {
        pub(crate) tmp: tempfile::TempDir,
        pub(crate) slots: Slots,
        pub(crate) built: PathBuf,
    }

    impl Rig {
        pub(crate) fn new() -> Self {
            let tmp = tempfile::tempdir().expect("tmp");
            let slots = Slots {
                dest: tmp.path().join("Applications/Eos.app"),
                keep: tmp.path().join("home/updates/previous/Eos.app"),
            };
            fs::create_dir_all(tmp.path().join("Applications")).expect("Applications");
            let built = tmp.path().join("build/Eos.app");
            app(&built, "new");
            Self { tmp, slots, built }
        }

        pub(crate) fn installed(&self, which: &str) -> &Self {
            app(&self.slots.dest, which);
            self
        }

        pub(crate) fn kept(&self, which: &str) -> &Self {
            app(&self.slots.keep, which);
            self
        }

        /// Every hidden working name is gone.
        pub(crate) fn assert_clean(&self) {
            let mut left = self.slots.leftovers();
            left.extend([partial(&self.slots.staged()), partial(&self.slots.keep)]);
            left.retain(|path| exists(path));
            assert!(left.is_empty(), "left behind: {left:?}");
        }
    }

    #[test]
    fn the_new_app_goes_in_and_the_replaced_one_is_kept() {
        let rig = Rig::new();
        rig.installed("old");
        let kept = put_in_place(&rig.built, &rig.slots, &FlakyDisk::default()).expect("swapped");
        assert!(matches!(kept, Some(Previous::Kept)), "{kept:?}");
        assert_eq!(which(&rig.slots.dest), "new");
        assert_eq!(which(&rig.slots.keep), "old");
        assert!(!exists(&rig.built), "the build was moved, not copied: no second copy stays behind");
        rig.assert_clean();
    }

    #[test]
    fn with_nothing_installed_nothing_is_kept() {
        let rig = Rig::new();
        let kept = put_in_place(&rig.built, &rig.slots, &FlakyDisk::default()).expect("swapped");
        assert!(kept.is_none(), "{kept:?}");
        assert_eq!(which(&rig.slots.dest), "new");
        assert!(!exists(&rig.slots.keep));
        rig.assert_clean();
    }

    #[test]
    fn only_one_previous_app_is_kept() {
        let rig = Rig::new();
        rig.installed("old").kept("older");
        put_in_place(&rig.built, &rig.slots, &FlakyDisk::default()).expect("swapped");
        assert_eq!(which(&rig.slots.keep), "old");
        let in_keep_folder: Vec<_> = fs::read_dir(rig.slots.keep.parent().expect("folder")).expect("list").collect();
        assert_eq!(in_keep_folder.len(), 1, "the older one is gone");
        rig.assert_clean();
    }

    #[test]
    fn going_back_trades_the_two_apps_and_again_trades_them_back() {
        let rig = Rig::new();
        rig.installed("rust").kept("typescript");
        put_in_place(&rig.slots.keep, &rig.slots, &FlakyDisk::default()).expect("back");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("typescript".into(), "rust".into()));
        put_in_place(&rig.slots.keep, &rig.slots, &FlakyDisk::default()).expect("forth");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("rust".into(), "typescript".into()));
        rig.assert_clean();
    }

    #[test]
    fn a_failure_before_the_new_app_is_in_leaves_the_installed_one_as_it_was() {
        let targets: [fn(&Slots) -> PathBuf; 3] = [Slots::staged, Slots::aside, |s| s.dest.clone()];
        for target in targets {
            let rig = Rig::new();
            rig.installed("old").kept("older");
            let disk = FlakyDisk::failing(Op::Rename, target(&rig.slots));
            let failed = put_in_place(&rig.built, &rig.slots, &disk).expect_err("planted");
            assert!(matches!(failed, Failed::Unchanged { new_left_at: None, .. }), "{failed:?}");
            assert_eq!(which(&rig.slots.dest), "old");
            assert_eq!(which(&rig.slots.keep), "older", "what was kept stays kept");
            assert_eq!(which(&rig.built), "new", "the new app is back where it was built");
            rig.assert_clean();
        }
    }

    #[test]
    fn going_back_and_failing_leaves_both_apps_where_they_were() {
        let rig = Rig::new();
        rig.installed("rust").kept("typescript");
        let disk = FlakyDisk::failing(Op::Rename, rig.slots.dest.clone());
        put_in_place(&rig.slots.keep, &rig.slots, &disk).expect_err("planted");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("rust".into(), "typescript".into()));
        rig.assert_clean();
    }

    #[test]
    fn an_installed_app_that_cannot_be_put_back_is_named() {
        let rig = Rig::new();
        rig.installed("old");
        // The new app cannot go in, and neither can the old one go back.
        let disk = FlakyDisk::failing(Op::Rename, rig.slots.dest.clone());
        disk.times.set(2);
        match put_in_place(&rig.built, &rig.slots, &disk).expect_err("planted") {
            Failed::Stranded { at, .. } => {
                assert_eq!(at, rig.slots.aside());
                assert_eq!(which(&at), "old");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn across_volumes_the_apps_are_copied_and_the_swap_is_still_two_renames() {
        let rig = Rig::new();
        rig.installed("old").kept("older");
        // The build and the keep place lie on another volume than Applications.
        let disk = FlakyDisk { other_volume: Some(rig.tmp.path().join("Applications")), ..FlakyDisk::default() };
        let kept = put_in_place(&rig.built, &rig.slots, &disk).expect("swapped");
        assert!(matches!(kept, Some(Previous::Kept)), "{kept:?}");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("new".into(), "old".into()));
        assert!(!exists(&rig.built), "a copied build is removed once it is in");
        assert_eq!(disk.copies.borrow().len(), 2, "one copy in, one copy to the keep place");
        rig.assert_clean();
    }

    #[test]
    fn across_volumes_a_failed_copy_changes_nothing() {
        let rig = Rig::new();
        rig.installed("old");
        let disk = FlakyDisk {
            other_volume: Some(rig.tmp.path().join("Applications")),
            ..FlakyDisk::failing(Op::Copy, partial(&rig.slots.staged()))
        };
        let failed = put_in_place(&rig.built, &rig.slots, &disk).expect_err("planted");
        assert!(matches!(failed, Failed::Unchanged { .. }), "{failed:?}");
        assert_eq!((which(&rig.slots.dest), which(&rig.built)), ("old".into(), "new".into()));
        rig.assert_clean();
    }

    #[test]
    fn a_replaced_app_that_cannot_be_kept_stays_beside_the_new_one_and_the_kept_one_stays() {
        let rig = Rig::new();
        rig.installed("old").kept("older");
        let disk = FlakyDisk::failing(Op::Rename, rig.slots.keep.clone());
        let kept = put_in_place(&rig.built, &rig.slots, &disk).expect("the new app is in");
        match kept {
            Some(Previous::Aside { at, .. }) => {
                assert_eq!(at, rig.slots.aside());
                assert_eq!(which(&at), "old");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("new".into(), "older".into()));
        assert!(!exists(&rig.slots.old()));
    }

    #[test]
    fn leftovers_of_an_interrupted_run_are_found_and_never_removed() {
        let rig = Rig::new();
        app(&rig.slots.aside(), "old");
        app(&rig.slots.old(), "older");
        assert_eq!(rig.slots.leftovers(), vec![rig.slots.aside(), rig.slots.old()]);
        assert_eq!(rig.slots.staged(), rig.tmp.path().join("Applications/.Eos.app.installing"));
    }
}
