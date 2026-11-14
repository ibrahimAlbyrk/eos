//! `cargo xtask install`: builds Eos from this checkout and installs it as the
//! user's app, keeping the app it replaces; `--restore` puts that one back.
//!
//! ```text
//! cargo xtask install [--no-open] [--identity <name | ->] [--dest <Eos.app>]
//! cargo xtask install --restore [--no-open] [--dest <Eos.app>]
//! ```
//!
//! Install: `host/scripts/setup.sh`, `bundle.sh release` with the app's
//! identity and no update channel, `sign.sh` (a Developer ID identity when
//! the keychain holds one, else ad hoc; `--identity` picks another, `-` is ad
//! hoc); then the app at `--dest` (default `/Applications/Eos.app`) is asked
//! to quit, the TypeScript-era daemon is stopped through launchd, and once
//! nothing runs from the bundle the new app takes its place. The app it
//! replaced is kept at `<data folder>/updates/previous/Eos.app` — where the
//! in-app updater keeps the app an update replaced, so there is one previous
//! app whoever replaced it. `--restore` trades the two places again.
//!
//! The data folder is `$EOS_HOME`, else `~/.eos`, as for the app. Only on the
//! user's own `~/.eos` is launchd asked about the old daemon; on another
//! folder the app is opened with `EOS_HOME` set to it.
//!
//! An install also puts the `eos` command on the PATH: `$EOS_BIN_DIR/eos`
//! (default `~/.local/bin/eos`) links to this checkout's `scripts/eos` (see
//! `link.rs` for when an existing one is replaced).

mod build;
mod bundle;
pub(crate) mod link;
pub(crate) mod quit;
mod swap;
pub(crate) mod system;

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use eos_update::legacy::{LEGACY_DAEMON_LABEL, LegacyDaemon};

use self::build::{Built, DEVELOPER_ID, Signed};
use self::bundle::{AppInfo, Kind};
use self::quit::{Busy, QUIT_TIMEOUT, Stopped};
use self::swap::{Disk, Failed, Previous, RealDisk, Slots};
use self::system::{MacSystem, System};

pub(crate) const DEFAULT_DEST: &str = "/Applications/Eos.app";
/// The applier of an in-app update is waiting (`eos_update::handover`).
const APPLY_PENDING: &str = "updates/apply.json";
const USAGE: &str = "usage: cargo xtask install [--no-open] [--identity <name | ->] [--dest <Eos.app>]\n       cargo xtask install --restore [--no-open] [--dest <Eos.app>]";
const RESTORE: &str = "eos restore";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    restore: bool,
    open: bool,
    identity: Option<String>,
    dest: PathBuf,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut parsed = Args { restore: false, open: true, identity: None, dest: PathBuf::from(DEFAULT_DEST) };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().cloned().with_context(|| format!("{arg} needs a value\n{USAGE}"));
        match arg.as_str() {
            "--restore" => parsed.restore = true,
            "--no-open" => parsed.open = false,
            "--identity" => parsed.identity = Some(value()?),
            "--dest" => parsed.dest = PathBuf::from(value()?),
            other => bail!("unexpected argument {other}\n{USAGE}"),
        }
    }
    if parsed.restore && parsed.identity.is_some() {
        bail!("--restore builds nothing: --identity does not apply\n{USAGE}");
    }
    if !parsed.dest.is_absolute() || parsed.dest.extension().is_none_or(|e| e != "app") {
        bail!("--dest must be the absolute path of an .app");
    }
    Ok(parsed)
}

/// Where the install lives: the app's place, the keep place, the data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Place {
    slots: Slots,
    home: PathBuf,
    /// The data folder is the user's own `~/.eos`.
    own_home: bool,
}

impl Place {
    /// The app at `dest`, on the data folder the app itself would use.
    pub(crate) fn of(dest: PathBuf) -> Self {
        Self::new(dest, eos_platform::eos_home(), eos_platform::home_dir().as_deref())
    }

    pub(crate) fn dest(&self) -> &Path {
        &self.slots.dest
    }

    pub(crate) fn new(dest: PathBuf, home: PathBuf, user_home: Option<&Path>) -> Self {
        let own_home = user_home.is_some_and(|user| user.join(".eos") == home);
        let name = dest.file_name().map(PathBuf::from).unwrap_or_default();
        let keep = home.join("updates/previous").join(name);
        Self { slots: Slots { dest, keep }, home, own_home }
    }

    /// What the opened app is told when its data folder is not the user's own.
    pub(crate) fn named_home(&self) -> Option<&Path> {
        (!self.own_home).then_some(self.home.as_path())
    }
}

/// What stops an install before anything is touched.
fn preflight(place: &Place) -> anyhow::Result<()> {
    let folder = place.slots.dest.parent().unwrap_or(Path::new("/"));
    if !folder.is_dir() {
        bail!("there is no folder {}", folder.display());
    }
    let pending = place.home.join(APPLY_PENDING);
    if pending.exists() {
        bail!(
            "an update of Eos is being applied ({} exists): wait until Eos has restarted, then run this again. \
             If no update is running, delete that file.",
            pending.display()
        );
    }
    let leftovers = place.slots.leftovers();
    if !leftovers.is_empty() {
        let list: Vec<String> = leftovers.iter().map(|path| format!("  {}", path.display())).collect();
        bail!(
            "an earlier install was interrupted and left these behind:\n{}\nEach is an Eos app. Move them away or delete them, then run this again.",
            list.join("\n")
        );
    }
    Ok(())
}

/// What happened, for the person.
#[derive(Debug)]
struct Outcome {
    installed: AppInfo,
    /// The app that was at the place, and where it went.
    replaced: Option<(AppInfo, Previous)>,
    stopped: Stopped,
    /// `None`: not asked to open.
    opened: Option<Result<(), String>>,
}

/// Quits what runs from the place, puts `new` there and keeps what was there.
fn swap_in(new: &Path, place: &Place, open: bool, system: &dyn System, disk: &dyn Disk) -> anyhow::Result<Outcome> {
    preflight(place)?;
    let dest = &place.slots.dest;
    let was = swap::exists(dest).then(|| AppInfo::read(dest));
    if let Some(was) = &was {
        eprintln!("install: replacing {was} at {}", dest.display());
    }
    let stopped = quit::stop_everything_in(dest, system, place.own_home).map_err(|busy| refused(busy, dest))?;
    let kept = swap::put_in_place(new, &place.slots, disk).map_err(|failed| not_swapped(failed, place))?;
    let installed = AppInfo::read(dest);
    let opened = open.then(|| system.open(dest, place.named_home()).map_err(|e| e.to_string()));
    Ok(Outcome { installed, replaced: was.zip(kept), stopped, opened })
}

fn refused(busy: Busy, dest: &Path) -> anyhow::Error {
    let unchanged = "Nothing was changed.";
    match busy {
        Busy::Apps(pids) => anyhow::anyhow!(
            "Eos at {} was asked to quit and still runs after {} s (process {}); it may be asking you something. \
             Quit it, then run this again. {unchanged}",
            dest.display(),
            QUIT_TIMEOUT.as_secs(),
            pids.iter().map(u32::to_string).collect::<Vec<_>>().join(", ")
        ),
        Busy::Daemon => anyhow::anyhow!(
            "the TypeScript Eos daemon ({LEGACY_DAEMON_LABEL}) has not stopped yet. Run this again in a moment. {unchanged}"
        ),
        Busy::Processes(left) => {
            let list: Vec<String> = left.iter().map(|p| format!("  {} {}", p.pid, p.executable)).collect();
            anyhow::anyhow!(
                "these still run from {}:\n{}\nQuit them, then run this again. {unchanged}",
                dest.display(),
                list.join("\n")
            )
        }
    }
}

fn not_swapped(failed: Failed, place: &Place) -> anyhow::Error {
    let dest = place.slots.dest.display();
    match failed {
        Failed::Unchanged { step, error, new_left_at } => {
            let left = new_left_at
                .map(|at| {
                    format!(
                        " The app that was to go in was left at {}: move it away before running this again.",
                        at.display()
                    )
                })
                .unwrap_or_default();
            anyhow::anyhow!(
                "{step} failed: {error}. The app at {dest} is unchanged (open it again if it was running).{left}"
            )
        }
        Failed::Stranded { at, error } => anyhow::anyhow!(
            "moving the new app into place failed ({error}) and the app that was installed could not be put back. \
             It is at {}; put it back with: mv '{}' '{dest}'",
            at.display(),
            at.display()
        ),
    }
}

/// The lines that tell the person what was done.
fn describe(outcome: &Outcome, place: &Place, built: Option<&Built>) -> Vec<String> {
    let dest = place.slots.dest.display();
    let mut lines = Vec::new();
    if outcome.stopped.daemon == Some(LegacyDaemon::Stopped) {
        lines.push("Stopped the TypeScript Eos daemon (launchd).".to_owned());
    }
    match built {
        Some(built) => {
            let from = built
                .commit
                .as_ref()
                .map(|(sha, dirty)| {
                    format!(", built from {sha}{}", if *dirty { " with uncommitted changes" } else { "" })
                })
                .unwrap_or_default();
            lines.push(format!("Installed {} at {dest}{from}.", outcome.installed));
        }
        None => lines.push(format!("Put back {} at {dest}.", outcome.installed)),
    }
    match &outcome.replaced {
        None => lines.push("Nothing was installed there before, so nothing is kept.".to_owned()),
        Some((was, Previous::Kept)) => {
            lines.push(format!("The app it replaced, {was}, is kept at {}.", place.slots.keep.display()));
            lines.push(format!(
                "To go back to it: {RESTORE} (or cargo xtask install --restore); run it again to come back."
            ));
        }
        Some((was, Previous::Aside { at, error })) => lines.push(format!(
            "The app it replaced, {was}, could not be moved to {} ({error}) and is at {}: move it there yourself \
             (mv '{}' '{}') or delete it.",
            place.slots.keep.display(),
            at.display(),
            at.display(),
            place.slots.keep.display()
        )),
    }
    if outcome.installed.kind == Kind::TypeScript {
        let when = if matches!(outcome.opened, Some(Ok(()))) { "now that it opens" } else { "when you open it" };
        lines.push(format!("It starts its daemon again {when}."));
    }
    if matches!(outcome.installed.kind, Kind::Rust { from_source: true }) {
        lines.push("A build from source does not update itself: run this command again for a newer one.".to_owned());
    }
    if let Some(built) = built {
        match &built.signed {
            Signed::Identity(name) => lines.push(format!("Signed with your \"{name}\" identity.")),
            Signed::AdHoc { fallback } => {
                let why = if *fallback {
                    format!(" (no \"{DEVELOPER_ID}\" identity in the keychain)")
                } else {
                    String::new()
                };
                lines.push(format!(
                    "Signed ad hoc{why}. It opens as usual (a build made on this Mac carries no quarantine flag, so \
                     Gatekeeper does not check it), but an ad hoc signature changes with every build: macOS may ask \
                     again for location, local network and keychain access after each install."
                ));
            }
        }
    }
    match &outcome.opened {
        Some(Ok(())) if place.own_home => lines.push("Opened it.".to_owned()),
        Some(Ok(())) => lines.push(format!("Opened it on the data folder {}.", place.home.display())),
        Some(Err(e)) => lines.push(format!("Could not open it ({e}): open {dest} yourself.")),
        None => {}
    }
    lines
}

/// The checkout this xtask was built from.
pub(crate) fn checkout() -> anyhow::Result<&'static Path> {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().context("the xtask folder has no parent")
}

/// Links the `eos` command to this checkout's launcher and says how it went.
fn link_command(rust_dir: &Path) -> String {
    let home = eos_platform::home_dir();
    let Some(bin) = link::bin_dir(std::env::var_os("EOS_BIN_DIR").map(PathBuf::from), home.as_deref()) else {
        return "The eos command was not linked: there is no home folder.".to_owned();
    };
    let linked = link::ensure(&bin, &rust_dir.join("scripts/eos"));
    link::describe(&linked, &bin, std::env::var("PATH").ok().as_deref())
}

pub(crate) fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let place = Place::of(args.dest.clone());
    preflight(&place)?;
    let (system, disk) = (MacSystem, RealDisk);
    let (outcome, built) = if args.restore {
        let keep = &place.slots.keep;
        if !keep.join("Contents/Info.plist").is_file() {
            bail!("no previous app is kept at {}: there is nothing to go back to", keep.display());
        }
        (swap_in(keep, &place, args.open, &system, &disk)?, None)
    } else {
        let built = build::build(checkout()?, args.identity.as_deref())?;
        (swap_in(&built.app, &place, args.open, &system, &disk)?, Some(built))
    };
    println!();
    for line in describe(&outcome, &place, built.as_ref()) {
        println!("{line}");
    }
    if built.is_some() {
        println!("{}", link_command(checkout()?));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::build::AD_HOC;
    use super::quit::tests::FakeSystem;
    use super::swap::tests::{FlakyDisk, Op, Rig, app, which};
    use super::*;

    fn args(list: &[&str]) -> anyhow::Result<Args> {
        parse_args(&list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
    }

    fn place(rig: &Rig, own_home: bool) -> Place {
        let home = rig.slots.keep.parent().and_then(Path::parent).and_then(Path::parent).expect("home").to_owned();
        Place { slots: rig.slots.clone(), home, own_home }
    }

    #[test]
    fn the_options_are_read_and_the_defaults_are_the_users_app() {
        let plain = args(&[]).expect("plain");
        assert_eq!(plain, Args { restore: false, open: true, identity: None, dest: PathBuf::from(DEFAULT_DEST) });
        let all = args(&["--no-open", "--identity", "-", "--dest", "/tmp/x/Eos.app"]).expect("all");
        assert_eq!(
            (all.open, all.identity.as_deref(), all.dest),
            (false, Some(AD_HOC), PathBuf::from("/tmp/x/Eos.app"))
        );
        assert!(args(&["--restore"]).expect("restore").restore);
        assert!(args(&["--restore", "--identity", "-"]).is_err());
        assert!(args(&["--dest", "Eos.app"]).is_err(), "relative");
        assert!(args(&["--dest", "/Applications/Eos"]).is_err(), "not an app");
        assert!(args(&["--dest"]).is_err());
        assert!(args(&["--force"]).is_err());
    }

    #[test]
    fn the_previous_app_is_kept_where_the_in_app_updater_keeps_it() {
        let place =
            Place::new(PathBuf::from(DEFAULT_DEST), PathBuf::from("/Users/me/.eos"), Some(Path::new("/Users/me")));
        assert_eq!(place.slots.keep, PathBuf::from("/Users/me/.eos/updates/previous/Eos.app"));
        assert!(place.own_home);
        assert_eq!(place.named_home(), None);
        let other = Place::new(PathBuf::from("/tmp/a/Eos.app"), PathBuf::from("/tmp/h"), Some(Path::new("/Users/me")));
        assert!(!other.own_home, "launchd is never asked about another data folder");
        assert_eq!(other.named_home(), Some(Path::new("/tmp/h")));
    }

    #[test]
    fn installing_quits_the_app_stops_the_old_daemon_swaps_keeps_and_opens() {
        let rig = Rig::new();
        rig.installed("old");
        let place = place(&rig, true);
        let system = FakeSystem { daemon: LegacyDaemon::Stopped, ..FakeSystem::new(true) };
        let outcome = swap_in(&rig.built, &place, true, &system, &FlakyDisk::default()).expect("installed");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("new".into(), "old".into()));
        assert_eq!(
            system.calls(),
            ["apps", "quit 4242", "apps", "stop daemon", "processes", &format!("open {}", rig.slots.dest.display())]
        );
        let text = describe(&outcome, &place, None).join("\n");
        assert!(text.contains("Stopped the TypeScript Eos daemon"), "{text}");
        assert!(text.contains(&format!("is kept at {}", rig.slots.keep.display())), "{text}");
        assert!(text.contains(RESTORE), "{text}");
        rig.assert_clean();
    }

    #[test]
    fn on_another_data_folder_launchd_is_not_asked_and_the_app_opens_on_that_folder() {
        let rig = Rig::new();
        let place = place(&rig, false);
        let system = FakeSystem::new(false);
        swap_in(&rig.built, &place, true, &system, &FlakyDisk::default()).expect("installed");
        let calls = system.calls();
        assert!(!calls.contains(&"stop daemon".to_owned()), "{calls:?}");
        assert_eq!(calls.last(), Some(&format!("open {} EOS_HOME={}", rig.slots.dest.display(), place.home.display())));
    }

    #[test]
    fn an_app_that_does_not_quit_leaves_everything_as_it_was() {
        let rig = Rig::new();
        rig.installed("old");
        let system = FakeSystem { quits_after: None, ..FakeSystem::new(true) };
        let error = swap_in(&rig.built, &place(&rig, true), true, &system, &FlakyDisk::default()).expect_err("busy");
        assert!(error.to_string().contains("Nothing was changed"), "{error}");
        assert_eq!((which(&rig.slots.dest), which(&rig.built)), ("old".into(), "new".into()));
        assert!(!system.calls().iter().any(|c| c.starts_with("open")), "nothing is opened");
    }

    #[test]
    fn a_failed_swap_says_the_installed_app_is_unchanged() {
        let rig = Rig::new();
        rig.installed("old");
        let disk = FlakyDisk::failing(Op::Rename, rig.slots.dest.clone());
        let error = swap_in(&rig.built, &place(&rig, true), true, &FakeSystem::new(false), &disk).expect_err("planted");
        assert!(error.to_string().contains("is unchanged"), "{error}");
        assert_eq!(which(&rig.slots.dest), "old");
    }

    #[test]
    fn going_back_and_forth_trades_the_installed_and_the_kept_app() {
        let rig = Rig::new();
        rig.installed("rust").kept("typescript");
        let place = place(&rig, true);
        let system = FakeSystem::new(false);
        let outcome = swap_in(&rig.slots.keep, &place, false, &system, &FlakyDisk::default()).expect("back");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("typescript".into(), "rust".into()));
        assert!(describe(&outcome, &place, None)[0].starts_with("Put back"));
        swap_in(&rig.slots.keep, &place, false, &system, &FlakyDisk::default()).expect("forth");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.keep)), ("rust".into(), "typescript".into()));
        assert!(!system.calls().iter().any(|c| c.starts_with("open")), "--no-open");
    }

    #[test]
    fn a_waiting_update_or_an_interrupted_install_stops_it_before_anything_runs() {
        let rig = Rig::new();
        rig.installed("old");
        let place = place(&rig, true);
        fs::create_dir_all(place.home.join("updates")).expect("updates");
        fs::write(place.home.join(APPLY_PENDING), "{}").expect("apply.json");
        let system = FakeSystem::new(true);
        let error = swap_in(&rig.built, &place, true, &system, &FlakyDisk::default()).expect_err("pending");
        assert!(error.to_string().contains("being applied"), "{error}");
        assert!(system.calls().is_empty(), "the app was not even asked to quit");
        fs::remove_file(place.home.join(APPLY_PENDING)).expect("gone");

        app(&rig.slots.aside(), "older");
        let error = swap_in(&rig.built, &place, true, &system, &FlakyDisk::default()).expect_err("leftover");
        assert!(error.to_string().contains(&rig.slots.aside().display().to_string()), "{error}");
        assert_eq!((which(&rig.slots.dest), which(&rig.slots.aside())), ("old".into(), "older".into()));
    }

    #[test]
    fn the_report_names_a_restored_typescript_app_and_an_ad_hoc_signature() {
        let rig = Rig::new();
        let place = place(&rig, true);
        let ts = AppInfo { id: None, version: Some("0.1.5".into()), kind: Kind::TypeScript };
        let outcome = Outcome {
            installed: ts.clone(),
            replaced: None,
            stopped: Stopped { apps: 0, daemon: None },
            opened: Some(Ok(())),
        };
        let text = describe(&outcome, &place, None).join("\n");
        assert!(text.contains("Put back Eos 0.1.5 (the TypeScript app)"), "{text}");
        assert!(text.contains("starts its daemon again now that it opens"), "{text}");

        let rust = AppInfo { id: None, version: Some("0.0.1".into()), kind: Kind::Rust { from_source: true } };
        let outcome = Outcome {
            installed: rust,
            replaced: Some((ts, Previous::Kept)),
            stopped: Stopped { apps: 1, daemon: Some(LegacyDaemon::NotLoaded) },
            opened: None,
        };
        let built = Built {
            app: rig.built.clone(),
            signed: Signed::AdHoc { fallback: true },
            commit: Some(("1a2b3c4".into(), true)),
        };
        let text = describe(&outcome, &place, Some(&built)).join("\n");
        assert!(text.contains("built from 1a2b3c4 with uncommitted changes"), "{text}");
        assert!(text.contains("does not update itself"), "{text}");
        assert!(text.contains("Signed ad hoc (no \"Developer ID Application\" identity"), "{text}");
        assert!(!text.contains("Stopped the TypeScript"), "it was not running: {text}");
    }
}
