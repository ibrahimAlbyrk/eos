//! macOS's own word on a staged app (`infra/src/update/MacAppBundleCheck.ts`):
//! signed by the same developer team as the installed one, its signature
//! intact all the way down, and Gatekeeper would open it (the notarization
//! ticket is stapled, so this needs no network).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::error::Error;
use crate::host::AppUpdatePlatform;
use crate::tool;

const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub(crate) struct MacAppUpdates;

/// `TeamIdentifier=` in what `codesign -dv` prints; ad-hoc signatures say "not set".
fn team_in(codesign_details: &str) -> Option<&str> {
    codesign_details
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|team| !team.is_empty() && *team != "not set")
}

// codesign prints its details on stderr.
fn team_of(app: &Path) -> Option<String> {
    let out = tool::run_ok(
        "codesign",
        Command::new("/usr/bin/codesign").args(["-dv", "--verbose=2"]).arg(app),
        None,
        TIMEOUT,
    )
    .ok()?;
    team_in(&out.stderr).map(str::to_owned)
}

fn check(tool_name: &'static str, command: &mut Command, message: &str) -> Result<(), Error> {
    match tool::run(tool_name, command, None, TIMEOUT) {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(Error::RejectedBundle(match out.last_error_line() {
            Some(detail) => format!("{message}: {detail}"),
            None => message.to_owned(),
        })),
        Err(_) => Err(Error::RejectedBundle(message.to_owned())),
    }
}

impl AppUpdatePlatform for MacAppUpdates {
    fn feed_platform(&self) -> &'static str {
        "darwin-arm64"
    }

    // …/Eos.app/Contents/MacOS/Eos → …/Eos.app
    fn bundle_root(&self, exec_path: &Path) -> Option<PathBuf> {
        let macos = exec_path.parent()?;
        let contents = macos.parent()?;
        let app = contents.parent()?;
        let named = |p: &Path, name: &str| p.file_name().is_some_and(|n| n == name);
        let is_app = app.extension().is_some_and(|e| e == "app") && app.file_stem().is_some_and(|s| !s.is_empty());
        (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| app.to_owned())
    }

    fn file_modes(&self) -> bool {
        true
    }

    fn verify_bundle(&self, staged: &Path, installed: &Path) -> Result<(), Error> {
        // Clones carry the installed files' quarantine flag; the staged copy is
        // the app as it was notarized, so the flag goes before macOS judges it.
        let _ = tool::run(
            "xattr",
            Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(staged),
            None,
            TIMEOUT,
        );
        let Some(team) = team_of(installed) else {
            return Err(Error::RejectedBundle(
                "the installed app has no developer signature to compare with".to_owned(),
            ));
        };
        if team_of(staged).as_deref() != Some(team.as_str()) {
            return Err(Error::RejectedBundle("the new version is signed by a different developer".to_owned()));
        }
        check(
            "codesign",
            Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(staged),
            "the new version's signature does not verify",
        )?;
        check(
            "spctl",
            Command::new("/usr/sbin/spctl").args(["--assess", "--type", "execute"]).arg(staged),
            "Gatekeeper would not open the new version",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_is_three_levels_above_its_executable() {
        let updates = MacAppUpdates;
        assert_eq!(
            updates.bundle_root(Path::new("/Applications/Eos.app/Contents/MacOS/Eos")),
            Some(PathBuf::from("/Applications/Eos.app"))
        );
        assert_eq!(
            updates.bundle_root(Path::new("/Users/me/My Apps/Eos Dev.app/Contents/MacOS/eos")),
            Some(PathBuf::from("/Users/me/My Apps/Eos Dev.app"))
        );
        assert_eq!(updates.bundle_root(Path::new("/usr/local/bin/eos")), None);
        assert_eq!(updates.bundle_root(Path::new("/Applications/Eos.app/Contents/Helpers/eos")), None);
        assert_eq!(updates.bundle_root(Path::new("/Applications/Eos/Contents/MacOS/Eos")), None);
        assert_eq!(updates.feed_platform(), "darwin-arm64");
        assert!(updates.file_modes());
    }

    #[test]
    fn the_team_is_read_from_codesign_details() {
        let signed = "Executable=/Applications/Eos.app/Contents/MacOS/Eos\nIdentifier=dev.eos\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2\n";
        assert_eq!(team_in(signed), Some("AB12CD34EF"));
        assert_eq!(team_in("Identifier=dev.eos\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_in("code object is not signed at all\n"), None);
    }

    #[test]
    fn an_installed_app_without_a_developer_signature_cannot_vouch_for_an_update() {
        let dir = tempfile::tempdir().expect("dir");
        let (staged, installed) = (dir.path().join("staged/Eos.app"), dir.path().join("installed/Eos.app"));
        std::fs::create_dir_all(&staged).expect("staged");
        std::fs::create_dir_all(&installed).expect("installed");
        let err = MacAppUpdates.verify_bundle(&staged, &installed).expect_err("rejected");
        assert!(
            matches!(&err, Error::RejectedBundle(m) if m == "the installed app has no developer signature to compare with"),
            "{err}"
        );
    }
}
