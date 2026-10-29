// In-app updates on Windows: Eos Setup's `--apply <apply.json>` mode. The app
// leaves apply.json in %USERPROFILE%\.eos\updates, copies this exe (its
// uninstaller) next to it under another name and quits. This stops what is
// left of Eos, swaps the verified staged folder in for the installed one — the
// installer gives Eos a folder of its own, so the whole folder moves — carries
// the install record and the uninstaller across, opens the new version and
// waits for it to report in (boot-ok). If it doesn't, the old folder goes back.
// result.json says how it ended. The file names match contracts/src/update.ts
// UPDATE_FILES.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::install;

const BOOT_OK: &str = "boot-ok";
const RESULT: &str = "result.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    version: String,
    from: String,
    staged: PathBuf,
    target: PathBuf,
    dir: PathBuf,
    boot_timeout_ms: u64,
    log: PathBuf,
}

pub fn apply(pending_path: &Path) {
    let Some(p) = fs::read(pending_path).ok().and_then(|b| serde_json::from_slice::<Pending>(&b).ok()) else { return };
    let log = |msg: &str| {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p.log) {
            let _ = writeln!(f, "{msg}");
        }
    };
    log(&format!("apply {} -> {}", p.from, p.version));

    install::stop_running_eos();
    let aside = p.dir.join("previous");
    let _ = fs::remove_dir_all(&aside);
    let _ = fs::create_dir_all(&aside);
    let previous = aside.join(p.target.file_name().unwrap_or_default());

    if let Err(e) = rename_retrying(&p.target, &previous) {
        log(&format!("could not set the installed version aside: {e}"));
        finish(&p, pending_path, "rolled-back", &log);
        let _ = install::launch(&p.target);
        return;
    }
    if let Err(e) = rename_retrying(&p.staged, &p.target) {
        log(&format!("could not move the new version in: {e}"));
        let _ = rename_retrying(&previous, &p.target);
        finish(&p, pending_path, "rolled-back", &log);
        let _ = install::launch(&p.target);
        return;
    }
    if let Err(e) = install::carry_over(&previous, &p.target, &p.version) {
        log(&format!("could not carry the install record over: {e}"));
    }

    let _ = fs::remove_file(p.dir.join(BOOT_OK));
    let _ = install::launch(&p.target);
    if wait_for_boot(&p) {
        log(&format!("{} is up", p.version));
        finish(&p, pending_path, "updated", &log);
        return;
    }

    log(&format!("{} did not come up in {} ms, going back to {}", p.version, p.boot_timeout_ms, p.from));
    install::stop_running_eos();
    let failed = p.dir.join(format!("failed-{}", p.version));
    let _ = fs::remove_dir_all(&failed);
    if rename_retrying(&p.target, &failed).is_ok() && rename_retrying(&previous, &p.target).is_ok() {
        let _ = install::set_display_version(&p.from);
    }
    let _ = fs::remove_dir_all(&failed);
    finish(&p, pending_path, "rolled-back", &log);
    let _ = install::launch(&p.target);
}

fn finish(p: &Pending, pending_path: &Path, kind: &str, log: &dyn Fn(&str)) {
    let result = serde_json::json!({ "kind": kind, "version": p.version, "from": p.from });
    let _ = fs::write(p.dir.join(RESULT), result.to_string());
    let _ = fs::remove_file(pending_path);
    log(&format!("done: {kind}"));
}

fn wait_for_boot(p: &Pending) -> bool {
    let until = Instant::now() + Duration::from_millis(p.boot_timeout_ms);
    let marker = p.dir.join(BOOT_OK);
    while Instant::now() < until {
        let booted = fs::read(&marker)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(|s| s == p.version))
            .unwrap_or(false);
        if booted {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

// A folder can't move while anything inside it is open; a just-killed Eos
// lets go of its files within moments.
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..20 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}
