//! Building the app from this checkout with the host workspace's own scripts
//! (setup, the release bundle, the signature), then a look at what was built.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};

use super::bundle::{APP_ID, AppInfo, Kind};

/// What `host/scripts/sign.sh` looks for by default.
pub(crate) const DEVELOPER_ID: &str = "Developer ID Application";
/// `sign.sh`'s name for an ad hoc signature.
pub(crate) const AD_HOC: &str = "-";

/// How the app was signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Signed {
    /// With the keychain's identity whose name holds this.
    Identity(String),
    /// Ad hoc; `fallback` when no Developer ID identity was there to use.
    AdHoc { fallback: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Built {
    pub(crate) app: PathBuf,
    pub(crate) signed: Signed,
    /// The checkout's commit, and whether it had uncommitted changes.
    pub(crate) commit: Option<(String, bool)>,
}

fn say(line: &str) {
    eprintln!("install: {line}");
}

fn run(command: &mut Command, what: &str) -> anyhow::Result<()> {
    let status = command.stdin(Stdio::null()).status().with_context(|| format!("could not start {what}"))?;
    if !status.success() {
        bail!("{what} failed ({status})");
    }
    Ok(())
}

/// `identity`: `sign.sh`'s identity (a part of its name, or `-` for ad hoc);
/// `None` is a Developer ID identity when the keychain holds one, else ad hoc.
pub(crate) fn build(rust_dir: &Path, identity: Option<&str>) -> anyhow::Result<Built> {
    let scripts = rust_dir.join("host/scripts");
    let commit = commit(rust_dir);
    if let Some((sha, dirty)) = &commit {
        say(&format!("building Eos from {sha}{}", if *dirty { " with uncommitted changes" } else { "" }));
    }
    // Always: it keeps what is in place, and rebuilds the dashboard when its sources changed.
    run(&mut Command::new(scripts.join("setup.sh")), "host/scripts/setup.sh")?;

    // A build from source: no update channel, so no `update.json` and no self-update.
    let out = Command::new(scripts.join("bundle.sh"))
        .arg("release")
        .env("EOS_BUNDLE_ID", APP_ID)
        .env_remove("EOS_UPDATE_CHANNEL")
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .context("could not start host/scripts/bundle.sh")?;
    if !out.status.success() {
        bail!("host/scripts/bundle.sh release failed ({})", out.status);
    }
    let app = String::from_utf8_lossy(&out.stdout).lines().last().map(PathBuf::from).unwrap_or_default();
    check_built(&app)?;

    let signed = sign(&scripts, &app, identity)?;
    let identifier = signature_identifier(&app);
    if identifier.as_deref() != Some(APP_ID) {
        bail!("the signature's identifier is {} instead of {APP_ID}", identifier.as_deref().unwrap_or("missing"));
    }
    Ok(Built { app, signed, commit })
}

/// A release bundle with the app's identity that does not update itself.
pub(crate) fn check_built(app: &Path) -> anyhow::Result<()> {
    let info = AppInfo::read(app);
    if info.id.as_deref() != Some(APP_ID) {
        bail!("{} is not a bundle of {APP_ID} (found {:?})", app.display(), info.id);
    }
    if !matches!(info.kind, Kind::Rust { from_source: true }) {
        bail!("{} is not a Rust app built from source ({:?})", app.display(), info.kind);
    }
    Ok(())
}

fn sign(scripts: &Path, app: &Path, identity: Option<&str>) -> anyhow::Result<Signed> {
    let (asked, signed) = match identity {
        Some(AD_HOC) => (AD_HOC, Signed::AdHoc { fallback: false }),
        Some(name) if has_identity(name) => (name, Signed::Identity(name.to_owned())),
        Some(name) => bail!("no signing identity matching \"{name}\" in the keychain"),
        None if has_identity(DEVELOPER_ID) => (DEVELOPER_ID, Signed::Identity(DEVELOPER_ID.to_owned())),
        None => {
            say(&format!("no \"{DEVELOPER_ID}\" identity in the keychain: signing ad hoc"));
            (AD_HOC, Signed::AdHoc { fallback: true })
        }
    };
    run(Command::new(scripts.join("sign.sh")).arg(app).arg(asked), "host/scripts/sign.sh")?;
    Ok(signed)
}

/// Whether the keychain holds a code-signing identity whose name contains
/// `name`. Its output (names and hashes) is never printed.
fn has_identity(name: &str) -> bool {
    Command::new("/usr/bin/security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).contains(name))
}

/// The top-level signature's identifier (`codesign -dv` writes it to stderr).
pub(crate) fn signature_identifier(app: &Path) -> Option<String> {
    let out = Command::new("/usr/bin/codesign").arg("-dv").arg(app).stdin(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    text.lines().find_map(|line| line.strip_prefix("Identifier=")).map(str::to_owned)
}

fn commit(rust_dir: &Path) -> Option<(String, bool)> {
    let git = |args: &[&str]| {
        let out = Command::new("git").arg("-C").arg(rust_dir).args(args).stdin(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let sha = git(&["rev-parse", "--short", "HEAD"])?;
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|status| !status.is_empty());
    Some((sha, dirty))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn bundle(app: &Path, id: &str, framework: &str) {
        fs::create_dir_all(app.join("Contents/Frameworks").join(framework)).expect("bundle");
        fs::write(
            app.join("Contents/Info.plist"),
            format!("<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>\n"),
        )
        .expect("plist");
    }

    #[test]
    fn only_a_source_build_with_the_apps_identity_is_installed() {
        let tmp = tempfile::tempdir().expect("tmp");
        let app = tmp.path().join("Eos.app");
        bundle(&app, APP_ID, "Chromium Embedded Framework.framework");
        check_built(&app).expect("a source build");

        fs::create_dir_all(app.join("Contents/Resources")).expect("resources");
        fs::write(app.join("Contents/Resources/update.json"), "{}").expect("update.json");
        assert!(check_built(&app).is_err(), "a build that updates itself is a release, not a build from source");

        let dev = tmp.path().join("Dev.app");
        bundle(&dev, "dev.eos.shell", "Chromium Embedded Framework.framework");
        assert!(check_built(&dev).is_err(), "a development identity shares nothing with the installed app");
    }
}
