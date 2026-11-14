//! The swap and the rollback, on throwaway bundle folders. The system is a
//! fake except in the last test, which stops a process this test started
//! itself from a throwaway bundle.

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use eos_apply::{BOOT_OK_FILE, MacSystem, Outcome, PENDING_FILE, Pending, RESULT_FILE, System, run};

/// A throwaway install: `<tmp>/Applications/Eos.app` holding `from`, a staged
/// `Eos.app` holding `version`, and the update folder with its `apply.json`.
struct Rig {
    _tmp: TempDir,
    pending: Pending,
}

/// A folder under the system's temp dir, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("eos-apply-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn bundle(root: &Path, version: &str) {
    fs::create_dir_all(root.join("Contents/MacOS")).expect("bundle");
    fs::write(root.join("Contents/version"), version).expect("version");
}

fn version_at(root: &Path) -> String {
    fs::read_to_string(root.join("Contents/version")).unwrap_or_else(|_| "nothing".to_owned())
}

impl Rig {
    fn new(name: &str) -> Self {
        let tmp = TempDir::new(name);
        let target = tmp.0.join("Applications/Eos.app");
        let dir = tmp.0.join("home/.eos/updates");
        let staged = dir.join("staged/0.2.0/Eos.app");
        bundle(&target, "0.1.5");
        bundle(&staged, "0.2.0");
        let pending = Pending {
            version: "0.2.0".into(),
            from: "0.1.5".into(),
            staged,
            target,
            log: tmp.0.join("home/.eos/logs/app-update.log"),
            app_pid: 4242,
            boot_timeout: Duration::from_secs(120),
            dir,
        };
        fs::write(pending.dir.join(PENDING_FILE), "{}").expect("apply.json");
        Self { _tmp: tmp, pending }
    }

    fn result(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.pending.dir.join(RESULT_FILE)).expect("result.json")).expect("json")
    }

    fn log(&self) -> String {
        fs::read_to_string(&self.pending.log).unwrap_or_default()
    }
}

/// What "opening" an app does in a test.
type OnOpen = Box<dyn Fn(&Path)>;

struct Fake {
    /// How many more times the app that started the applier is still alive.
    app_alive_for: Cell<u32>,
    opened: RefCell<Vec<String>>,
    stopped_in: RefCell<Vec<PathBuf>>,
    slept: Cell<Duration>,
    on_open: OnOpen,
    /// Runs on every sleep, with the time slept so far.
    on_sleep: Box<dyn Fn(Duration)>,
}

impl Fake {
    fn new(on_open: impl Fn(&Path) + 'static) -> Self {
        Self {
            app_alive_for: Cell::new(0),
            opened: RefCell::default(),
            stopped_in: RefCell::default(),
            slept: Cell::default(),
            on_open: Box::new(on_open),
            on_sleep: Box::new(|_| {}),
        }
    }
}

impl System for Fake {
    fn process_alive(&self, _pid: u32) -> bool {
        let left = self.app_alive_for.get();
        self.app_alive_for.set(left.saturating_sub(1));
        left > 0
    }

    fn open(&self, app: &Path) -> std::io::Result<()> {
        self.opened.borrow_mut().push(version_at(app));
        (self.on_open)(app);
        Ok(())
    }

    fn stop_processes_in(&self, bundle: &Path) -> usize {
        self.stopped_in.borrow_mut().push(bundle.to_owned());
        2
    }

    fn sleep(&self, time: Duration) {
        self.slept.set(self.slept.get() + time);
        (self.on_sleep)(self.slept.get());
    }
}

/// An app that reports in as `version` the moment it is opened.
fn boots_as(dir: &Path, version: &'static str) -> impl Fn(&Path) + 'static {
    let marker = dir.join(BOOT_OK_FILE);
    move |_| fs::write(&marker, format!(r#"{{"version":"{version}"}}"#)).expect("boot-ok")
}

#[test]
fn the_new_version_takes_the_place_and_the_old_one_is_kept_aside() {
    let rig = Rig::new("updated");
    // A copy an older update set aside: replaced, not piled up.
    bundle(&rig.pending.dir.join("previous/Old.app"), "0.1.4");
    let system = Fake::new(boots_as(&rig.pending.dir, "0.2.0"));

    assert_eq!(run(&rig.pending, &system), Outcome::Updated);
    assert_eq!(version_at(&rig.pending.target), "0.2.0");
    assert_eq!(version_at(&rig.pending.dir.join("previous/Eos.app")), "0.1.5");
    assert!(!rig.pending.dir.join("previous/Old.app").exists());
    assert!(!rig.pending.staged.exists());
    assert_eq!(rig.result(), serde_json::json!({ "kind": "updated", "version": "0.2.0", "from": "0.1.5" }));
    assert!(!rig.pending.dir.join(PENDING_FILE).exists(), "apply.json is gone once the swap ended");
    assert_eq!(*system.opened.borrow(), ["0.2.0"]);
    assert!(system.stopped_in.borrow().is_empty());
    assert!(rig.log().contains("apply 0.1.5 → 0.2.0") && rig.log().contains("done: updated"), "{}", rig.log());
}

#[test]
fn a_version_that_does_not_report_in_is_stopped_and_the_old_one_comes_back() {
    let rig = Rig::new("rolled-back");
    // A marker left by an earlier update must not count for this one.
    fs::write(rig.pending.dir.join(BOOT_OK_FILE), r#"{"version":"0.2.0"}"#).expect("stale marker");
    let system = Fake::new(|_| {});

    assert_eq!(run(&rig.pending, &system), Outcome::RolledBack);
    assert_eq!(version_at(&rig.pending.target), "0.1.5");
    assert!(!rig.pending.dir.join("previous/Eos.app").exists());
    assert!(!rig.pending.dir.join("failed-0.2.0.app").exists());
    assert_eq!(rig.result(), serde_json::json!({ "kind": "rolled-back", "version": "0.2.0", "from": "0.1.5" }));
    assert!(!rig.pending.dir.join(PENDING_FILE).exists());
    assert_eq!(*system.opened.borrow(), ["0.2.0", "0.1.5"], "the new one was tried, then the old one opened");
    assert_eq!(system.stopped_in.borrow().as_slice(), std::slice::from_ref(&rig.pending.target));
    assert!(system.slept.get() >= rig.pending.boot_timeout, "it waited the whole deadline");
    assert!(rig.log().contains("did not come up in 120000 ms"), "{}", rig.log());
}

#[test]
fn another_versions_marker_does_not_count() {
    let rig = Rig::new("wrong-version");
    let system = Fake::new(boots_as(&rig.pending.dir, "0.1.5"));
    assert_eq!(run(&rig.pending, &system), Outcome::RolledBack);
    assert_eq!(version_at(&rig.pending.target), "0.1.5");
}

#[test]
fn a_half_written_marker_is_read_again() {
    let rig = Rig::new("half-written");
    let marker = rig.pending.dir.join(BOOT_OK_FILE);
    let half = marker.clone();
    let mut system = Fake::new(move |_| fs::write(&half, r#"{"vers"#).expect("half"));
    system.on_sleep = Box::new(move |slept| {
        if slept >= Duration::from_secs(40) {
            fs::write(&marker, r#"{"version":"0.2.0"}"#).expect("whole");
        }
    });
    assert_eq!(run(&rig.pending, &system), Outcome::Updated);
    assert!(system.slept.get() < Duration::from_secs(41));
}

#[test]
fn the_swap_waits_for_the_app_to_exit() {
    let rig = Rig::new("waits");
    let system = Fake::new(boots_as(&rig.pending.dir, "0.2.0"));
    system.app_alive_for.set(3);
    assert_eq!(run(&rig.pending, &system), Outcome::Updated);
    assert_eq!(system.slept.get(), Duration::from_millis(600));
}

#[test]
fn a_staged_copy_that_is_gone_leaves_the_installed_app_in_place() {
    let rig = Rig::new("no-staged");
    fs::remove_dir_all(&rig.pending.staged).expect("remove staged");
    let system = Fake::new(|_| {});
    assert_eq!(run(&rig.pending, &system), Outcome::RolledBack);
    assert_eq!(version_at(&rig.pending.target), "0.1.5");
    assert_eq!(*system.opened.borrow(), ["0.1.5"]);
    assert_eq!(rig.result()["kind"], "rolled-back");
    assert!(rig.log().contains("could not move the new version in"), "{}", rig.log());
}

#[test]
fn an_installed_app_that_cannot_be_set_aside_is_left_alone() {
    let rig = Rig::new("no-previous");
    // The place for the previous app is taken by something that is no folder
    // and cannot be removed as one.
    let mut pending = rig.pending.clone();
    pending.target = rig.pending.target.join("Contents/missing/Eos.app");
    let system = Fake::new(|_| {});
    assert_eq!(run(&pending, &system), Outcome::RolledBack);
    assert_eq!(version_at(&rig.pending.target), "0.1.5");
    assert_eq!(version_at(&rig.pending.staged), "0.2.0", "the staged copy was not touched");
    assert!(rig.log().contains("could not set the installed app aside"), "{}", rig.log());
}

/// Not a test of its own: what the copies of this test binary run in the test
/// below (macOS refuses to run a copy of a system tool, so the stand-in for an
/// app's executable is this binary).
#[test]
#[ignore = "run only as the stand-in process of the test below"]
fn stand_in_process() {
    if std::env::var_os("EOS_APPLY_TEST_STAND_IN").is_some() {
        std::thread::sleep(Duration::from_secs(60));
    }
}

/// The real process stop, on processes this test starts itself from throwaway
/// bundles: copies of this test binary under `<tmp>/<App>.app/Contents/MacOS`.
#[test]
fn processes_running_from_a_failed_bundle_are_stopped_and_others_are_not() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};

    let tmp = TempDir::new("stop");
    let app = tmp.0.join("Eos.app");
    let other = tmp.0.join("Other.app");
    let this = std::env::current_exe().expect("this test binary");
    let spawn = |root: &Path| {
        let exe = root.join("Contents/MacOS/Eos");
        fs::create_dir_all(root.join("Contents/MacOS")).expect("bundle");
        fs::copy(&this, &exe).expect("copy");
        Command::new(exe)
            .args(["stand_in_process", "--exact", "--ignored"])
            .env("EOS_APPLY_TEST_STAND_IN", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn")
    };
    let (mut inside, mut outside) = (spawn(&app), spawn(&other));

    let stopped = MacSystem.stop_processes_in(&app);
    // Whatever was found, the process this test started must not outlive it.
    let _ = inside.kill();
    let status = inside.wait().expect("reaped");
    let outside_alive = MacSystem.process_alive(outside.id());
    outside.kill().expect("stop our own process");
    outside.wait().expect("reaped");

    assert_eq!(stopped, 1, "exactly the process running from the bundle");
    assert_eq!(status.signal(), Some(9), "it was killed");
    assert!(outside_alive, "a process from another bundle was left alone");
    assert!(!MacSystem.process_alive(inside.id()));
}
