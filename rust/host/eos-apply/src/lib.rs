//! The in-app update applier (macOS).
//!
//! Runs detached, from a copy outside the app bundle, after the app has left
//! `apply.json` and quit: puts the installed app aside, renames the verified
//! staged copy into its place and opens it. If the new version does not report
//! in — it writes the `boot-ok` marker once its core is ready and its window is
//! up — the old app goes back and opens instead. Either way `result.json` says
//! how it ended, for the app to show. The app that was set aside is deleted
//! only by the next update.
//!
//! Files, all in the update folder (`~/.eos/updates`), in the formats the
//! TypeScript-era app and applier use, so either era's app works with either
//! era's applier:
//!
//! | File | Written by | Holds |
//! |---|---|---|
//! | `apply.json` | the app, before it quits | [`Pending`] |
//! | `boot-ok` | the new app, once it is up | `{"version": "<its version>"}` |
//! | `result.json` | the applier | `{"kind": "updated" \| "rolled-back", "version", "from"}` |
//! | `previous/<App>.app` | the applier | the app it replaced |
//!
//! Usage: `eos-apply <apply.json>`.

mod system;

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub use system::MacSystem;

/// The applier is waiting for this version to come up.
pub const PENDING_FILE: &str = "apply.json";
/// The new app came up (its version inside).
pub const BOOT_OK_FILE: &str = "boot-ok";
/// How the last swap ended.
pub const RESULT_FILE: &str = "result.json";

/// How long the app gets to exit after it started the applier.
const APP_EXIT_TIMEOUT: Duration = Duration::from_secs(30);
const APP_EXIT_POLL: Duration = Duration::from_millis(200);
const BOOT_POLL: Duration = Duration::from_millis(500);
/// After the failed version's processes were stopped, before its bundle is moved.
const AFTER_STOP: Duration = Duration::from_millis(500);

/// What the app leaves in `apply.json`. Fields this applier does not use (the
/// TypeScript-era app also writes its launchd label and the user id) are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    /// The version being installed, and the one it replaces.
    pub version: String,
    pub from: String,
    /// The verified new bundle.
    pub staged: PathBuf,
    /// The installed bundle (`/Applications/Eos.app`).
    pub target: PathBuf,
    /// The update folder.
    pub dir: PathBuf,
    /// The app that started the applier; the swap waits for it to exit.
    pub app_pid: u32,
    /// How long the new version gets to write `boot-ok`.
    pub boot_timeout: Duration,
    pub log: PathBuf,
}

impl Pending {
    pub fn read(path: &Path) -> io::Result<Self> {
        Self::parse(&fs::read(path)?)
            .map_err(|what| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {what}", path.display())))
    }

    pub fn parse(json: &[u8]) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
        let text = |key: &str| {
            value
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or(format!("no {key}"))
        };
        let number = |key: &str| value.get(key).and_then(serde_json::Value::as_u64).ok_or(format!("no {key}"));
        let path = |key: &str| {
            let path = PathBuf::from(text(key)?);
            if path.is_absolute() { Ok(path) } else { Err(format!("{key} is not an absolute path")) }
        };
        let pending = Self {
            version: text("version")?,
            from: text("from")?,
            staged: path("staged")?,
            target: path("target")?,
            dir: path("dir")?,
            app_pid: u32::try_from(number("appPid")?).map_err(|_| "appPid is not a process id".to_owned())?,
            boot_timeout: Duration::from_millis(number("bootTimeoutMs")?),
            log: path("log")?,
        };
        if pending.target.file_name().is_none() {
            return Err("target has no name".to_owned());
        }
        Ok(pending)
    }
}

/// What the applier asks of the system it runs on.
pub trait System {
    fn process_alive(&self, pid: u32) -> bool;
    /// Launches the app at `app`.
    fn open(&self, app: &Path) -> io::Result<()>;
    /// Ends every process whose executable lies inside `bundle`; returns how many.
    fn stop_processes_in(&self, bundle: &Path) -> usize;
    fn sleep(&self, time: Duration);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The new version is in place and reported in.
    Updated,
    /// The previous version is (still, or again) in place.
    RolledBack,
}

impl Outcome {
    fn kind(self) -> &'static str {
        match self {
            Self::Updated => "updated",
            Self::RolledBack => "rolled-back",
        }
    }
}

struct Log<'a>(&'a Path);

impl Log<'_> {
    // No log, no matter: the swap goes on.
    fn line(&self, message: &str) {
        if let Some(parent) = self.0.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(self.0) {
            let _ = writeln!(file, "{} {message}", iso_now());
        }
    }
}

/// Swaps the staged app in, waits for it to report in and puts the old one
/// back when it does not. Never fails: whatever happens, an app is left at
/// `target`, opened, and `result.json` says which.
pub fn run(pending: &Pending, system: &dyn System) -> Outcome {
    let log = Log(&pending.log);
    log.line(&format!("apply {} → {}", pending.from, pending.version));
    wait_for_exit(pending.app_pid, system);

    let outcome = swap(pending, system, &log);
    finish(pending, outcome, &log);
    if outcome == Outcome::RolledBack {
        open(&pending.target, system, &log);
    }
    outcome
}

fn swap(pending: &Pending, system: &dyn System, log: &Log<'_>) -> Outcome {
    let Some(name) = pending.target.file_name() else { return Outcome::RolledBack };
    let previous_dir = pending.dir.join("previous");
    let previous = previous_dir.join(name);
    let _ = remove_all(&previous_dir);
    if let Err(e) = fs::create_dir_all(&previous_dir).and_then(|()| fs::rename(&pending.target, &previous)) {
        log.line(&format!("could not set the installed app aside: {e}"));
        return Outcome::RolledBack;
    }
    if let Err(e) = fs::rename(&pending.staged, &pending.target) {
        log.line(&format!("could not move the new version in: {e}"));
        if let Err(e) = fs::rename(&previous, &pending.target) {
            log.line(&format!("could not put the installed app back: {e}"));
        }
        return Outcome::RolledBack;
    }

    let _ = fs::remove_file(pending.dir.join(BOOT_OK_FILE));
    open(&pending.target, system, log);
    if wait_for_boot(pending, system) {
        log.line(&format!("{} is up", pending.version));
        return Outcome::Updated;
    }

    log.line(&format!(
        "{} did not come up in {} ms — going back to {}",
        pending.version,
        pending.boot_timeout.as_millis(),
        pending.from
    ));
    let stopped = system.stop_processes_in(&pending.target);
    if stopped > 0 {
        log.line(&format!("stopped {stopped} processes of the failed version"));
    }
    system.sleep(AFTER_STOP);
    let failed = pending.dir.join(format!("failed-{}.app", pending.version));
    let _ = remove_all(&failed);
    let back = fs::rename(&pending.target, &failed).and_then(|()| fs::rename(&previous, &pending.target));
    if let Err(e) = back {
        log.line(&format!("could not put the previous version back: {e}"));
    }
    let _ = remove_all(&failed);
    Outcome::RolledBack
}

fn finish(pending: &Pending, outcome: Outcome, log: &Log<'_>) {
    let result = serde_json::json!({ "kind": outcome.kind(), "version": pending.version, "from": pending.from });
    if let Err(e) = fs::write(pending.dir.join(RESULT_FILE), result.to_string()) {
        log.line(&format!("could not write the result: {e}"));
    }
    let _ = fs::remove_file(pending.dir.join(PENDING_FILE));
    log.line(&format!("done: {}", outcome.kind()));
}

fn wait_for_exit(pid: u32, system: &dyn System) {
    let mut waited = Duration::ZERO;
    while waited < APP_EXIT_TIMEOUT && system.process_alive(pid) {
        system.sleep(APP_EXIT_POLL);
        waited += APP_EXIT_POLL;
    }
}

fn wait_for_boot(pending: &Pending, system: &dyn System) -> bool {
    let marker = pending.dir.join(BOOT_OK_FILE);
    let mut waited = Duration::ZERO;
    loop {
        if booted(&marker, &pending.version) {
            return true;
        }
        if waited >= pending.boot_timeout {
            return false;
        }
        system.sleep(BOOT_POLL);
        waited += BOOT_POLL;
    }
}

/// The marker names the version that was installed. A marker that does not
/// parse may be half-written: look again.
fn booted(marker: &Path, version: &str) -> bool {
    fs::read(marker)
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .is_some_and(|value| value.get("version").and_then(|v| v.as_str()) == Some(version))
}

fn open(app: &Path, system: &dyn System, log: &Log<'_>) {
    if let Err(e) = system.open(app) {
        log.line(&format!("could not open {}: {e}", app.display()));
    }
}

fn remove_all(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// The time as `2026-11-11T09:30:00Z`.
fn iso_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    iso(secs)
}

fn iso(secs: u64) -> String {
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_time_is_a_civil_date() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_794_355_200), "2026-11-11T00:00:00Z");
        assert_eq!(iso(1_709_251_199), "2024-02-29T23:59:59Z");
    }

    #[test]
    fn what_the_typescript_app_leaves_is_read_and_what_is_missing_is_named() {
        let ts = br#"{"version":"0.2.0","from":"0.1.5","staged":"/u/.eos/updates/staged/0.2.0/Eos.app","target":"/Applications/Eos.app","dir":"/u/.eos/updates","appPid":4242,"daemonLabel":"com.ibrahimalbyrk.eos.daemon","uid":501,"bootTimeoutMs":120000,"log":"/u/.eos/logs/app-update.log"}"#;
        let pending = Pending::parse(ts).expect("parsed");
        assert_eq!(pending.version, "0.2.0");
        assert_eq!(pending.target, PathBuf::from("/Applications/Eos.app"));
        assert_eq!(pending.app_pid, 4242);
        assert_eq!(pending.boot_timeout, Duration::from_secs(120));

        assert_eq!(Pending::parse(br#"{"version":"0.2.0"}"#), Err("no from".to_owned()));
        let relative = String::from_utf8_lossy(ts).replace("/Applications/Eos.app", "Eos.app");
        assert_eq!(Pending::parse(relative.as_bytes()), Err("target is not an absolute path".to_owned()));
        assert!(Pending::parse(b"not json").is_err());
    }
}
