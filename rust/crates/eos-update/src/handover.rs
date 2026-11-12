//! What the app leaves for the applier, and for the version that follows it
//! (`app/src/main/updates.ts`, `app/src/main/platform/darwin/update.ts`).
//!
//! Applying an update: the app writes `apply.json`, starts the applier
//! (`eos-apply`, a small program shipped beside the app's executable) detached
//! from a copy outside the bundle — the bundle is about to move — and quits.
//! The applier swaps the bundles and opens the new version, which calls
//! [`mark_booted`] once it is up; without that mark inside the deadline the
//! applier puts the old version back.
//!
//! The files and their formats are the TypeScript-era ones
//! (`eos_contracts::update::update_files`), so an app of either era works with
//! an applier of either era.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::update::{UpdateApply, update_files};
use eos_core::BoxFuture;
use eos_core::net::updates::UpdateApplier;
use serde::Serialize;

use crate::fsx;

/// How long the new version gets to report in. Its first start includes
/// opening the data folder (a snapshot, any migration), so the deadline is generous.
pub const BOOT_TIMEOUT: Duration = Duration::from_secs(120);

/// The applier's file name, beside the app's executable and in the update folder.
pub const APPLIER_NAME: &str = "eos-apply";

/// What `apply.json` holds (camelCase, as the TypeScript app writes it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApply {
    pub version: String,
    pub from: String,
    pub staged: String,
    pub target: String,
    /// The update folder.
    pub dir: String,
    pub app_pid: u32,
    pub boot_timeout_ms: u64,
    pub log: String,
}

/// Where the hand-over happens.
#[derive(Debug, Clone)]
pub struct Handover {
    /// The update folder (`~/.eos/updates`).
    pub updates_dir: PathBuf,
    /// The applier inside the installed app.
    pub applier: PathBuf,
    /// The applier's log (`~/.eos/logs/app-update.log`).
    pub log: PathBuf,
}

impl Handover {
    /// For an app whose applier ships beside its executable.
    pub fn beside(exec_path: &Path, home: &Path) -> Self {
        Self {
            updates_dir: home.join("updates"),
            applier: exec_path.with_file_name(APPLIER_NAME),
            log: home.join("logs").join("app-update.log"),
        }
    }
}

fn text(path: &Path) -> io::Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a path that is not text"))
}

/// Leaves `apply.json` and starts the applier detached. The caller quits
/// right after: the applier waits for process `app_pid` to exit.
pub fn start_applier(apply: &UpdateApply, handover: &Handover, app_pid: u32) -> io::Result<()> {
    let dir = &handover.updates_dir;
    fs::create_dir_all(dir)?;
    let pending = PendingApply {
        version: apply.version.0.clone(),
        from: apply.from.0.clone(),
        staged: apply.staged.clone(),
        target: apply.target.clone(),
        dir: text(dir)?,
        app_pid,
        boot_timeout_ms: u64::try_from(BOOT_TIMEOUT.as_millis()).unwrap_or(120_000),
        log: text(&handover.log)?,
    };
    // A plain copy of the bytes, not a clone: a clone would carry the bundle's
    // extended attributes (a quarantine flag among them) to a file that then
    // has to run on its own. The signature is inside the file and stays valid.
    let copy = dir.join(APPLIER_NAME);
    fsx::remove_all(&copy)?;
    fs::write(&copy, fs::read(&handover.applier)?)?;
    fsx::set_mode(&copy, 0o755)?;

    // Only once there is an applier to start: a later start of the app must
    // not report in to nobody.
    let pending_path = dir.join(update_files::PENDING);
    fs::write(&pending_path, serde_json::to_vec(&pending).map_err(io::Error::other)?)?;

    let mut command = Command::new(&copy);
    command.arg(&pending_path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Its own process group: it must outlive this app.
    eos_platform::isolate_command(&mut command);
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&pending_path);
            Err(e)
        }
    }
}

/// A file in the update folder that makes this version withhold its mark, so
/// the applier puts the previous version back: the way to rehearse a rollback
/// with the very build that will be released (`docs/first-rust-release.md`).
pub const REHEARSE_ROLLBACK_FILE: &str = "rehearse-rollback";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootMark {
    /// No applier is waiting: this start does not follow an update.
    NotWaited,
    /// The waiting applier was told.
    Written,
    /// An applier is waiting and was deliberately not told (a rehearsal).
    Withheld,
}

/// Tells a waiting applier that `version` is up: writes the `boot-ok` mark
/// when an `apply.json` says an applier is waiting.
///
/// Call it once the core is ready and the window is up. Before it, the new
/// version must have changed nothing in the data folder that the previous
/// version cannot read: without the mark the applier puts that version back.
pub fn mark_booted(updates_dir: &Path, version: &str) -> io::Result<BootMark> {
    if !updates_dir.join(update_files::PENDING).exists() {
        return Ok(BootMark::NotWaited);
    }
    if updates_dir.join(REHEARSE_ROLLBACK_FILE).exists() {
        return Ok(BootMark::Withheld);
    }
    let mark = serde_json::json!({ "version": version }).to_string();
    fsx::write_then_rename(&updates_dir.join(update_files::BOOT_OK), ".tmp", mark.as_bytes())?;
    Ok(BootMark::Written)
}

/// The hand-over as the port the update feature calls: starts the applier,
/// then asks the shell to quit.
pub struct ApplierLauncher {
    handover: Handover,
    quit: Arc<dyn Fn() + Send + Sync>,
}

impl std::fmt::Debug for ApplierLauncher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApplierLauncher").field("handover", &self.handover).finish_non_exhaustive()
    }
}

impl ApplierLauncher {
    /// `quit` makes the app exit (its normal shutdown); it is called only
    /// after the applier started.
    pub fn new(handover: Handover, quit: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { handover, quit }
    }
}

impl UpdateApplier for ApplierLauncher {
    fn apply<'a>(&'a self, apply: &'a UpdateApply) -> BoxFuture<'a, Result<(), String>> {
        let (apply, handover) = (apply.clone(), self.handover.clone());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || start_applier(&apply, &handover, std::process::id()))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("the updater could not start: {e}"))?;
            (self.quit)();
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::update::AppVersion;

    use super::*;

    fn apply(dir: &Path) -> UpdateApply {
        UpdateApply {
            version: AppVersion("0.2.0".into()),
            from: AppVersion("0.1.5".into()),
            staged: dir.join("updates/staged/0.2.0/Eos.app").to_string_lossy().into_owned(),
            target: dir.join("Applications/Eos.app").to_string_lossy().into_owned(),
        }
    }

    /// A stand-in applier: a script that records what it was started with.
    #[cfg(unix)]
    fn fake_applier(dir: &Path) -> PathBuf {
        let path = dir.join("bundle").join(APPLIER_NAME);
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(&path, "#!/bin/sh\nprintf '%s' \"$1\" > \"$(dirname \"$0\")/started-with\"\n").expect("script");
        path
    }

    #[cfg(unix)]
    #[test]
    fn the_applier_is_started_from_a_copy_with_what_it_needs_in_apply_json() {
        let tmp = tempfile::tempdir().expect("dir");
        let handover = Handover {
            updates_dir: tmp.path().join("updates"),
            applier: fake_applier(tmp.path()),
            log: tmp.path().join("logs/app-update.log"),
        };
        start_applier(&apply(tmp.path()), &handover, 4242).expect("started");

        let pending_path = handover.updates_dir.join("apply.json");
        let pending: serde_json::Value =
            serde_json::from_slice(&fs::read(&pending_path).expect("apply.json")).expect("json");
        assert_eq!(
            pending,
            serde_json::json!({
                "version": "0.2.0",
                "from": "0.1.5",
                "staged": tmp.path().join("updates/staged/0.2.0/Eos.app"),
                "target": tmp.path().join("Applications/Eos.app"),
                "dir": tmp.path().join("updates"),
                "appPid": 4242,
                "bootTimeoutMs": 120_000,
                "log": tmp.path().join("logs/app-update.log"),
            })
        );

        // The copy ran, not the file in the bundle, and it got apply.json's path.
        let started_with = handover.updates_dir.join("started-with");
        for _ in 0..200 {
            if started_with.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fs::read_to_string(&started_with).expect("the copy ran"), pending_path.to_string_lossy());
        assert!(!tmp.path().join("bundle/started-with").exists());
    }

    #[test]
    fn an_applier_that_cannot_start_leaves_no_pending_swap() {
        let tmp = tempfile::tempdir().expect("dir");
        let handover = Handover::beside(&tmp.path().join("Eos.app/Contents/MacOS/Eos"), &tmp.path().join("home"));
        assert_eq!(handover.applier, tmp.path().join("Eos.app/Contents/MacOS/eos-apply"));
        assert!(start_applier(&apply(tmp.path()), &handover, 1).is_err(), "there is no applier to copy");
        assert!(!handover.updates_dir.join("apply.json").exists());
    }

    #[test]
    fn the_mark_is_written_only_while_an_applier_waits() {
        let tmp = tempfile::tempdir().expect("dir");
        assert_eq!(mark_booted(tmp.path(), "0.2.0").expect("checked"), BootMark::NotWaited);
        assert!(!tmp.path().join("boot-ok").exists());

        fs::write(tmp.path().join("apply.json"), "{}").expect("pending");
        fs::write(tmp.path().join("rehearse-rollback"), "").expect("rehearsal");
        assert_eq!(mark_booted(tmp.path(), "0.2.0").expect("checked"), BootMark::Withheld);
        assert!(!tmp.path().join("boot-ok").exists(), "a rehearsed rollback gets no mark");

        fs::remove_file(tmp.path().join("rehearse-rollback")).expect("end of rehearsal");
        assert_eq!(mark_booted(tmp.path(), "0.2.0").expect("marked"), BootMark::Written);
        // Exactly what the TypeScript-era applier reads.
        assert_eq!(fs::read_to_string(tmp.path().join("boot-ok")).expect("mark"), r#"{"version":"0.2.0"}"#);
    }
}
