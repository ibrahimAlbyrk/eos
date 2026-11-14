//! Whether this install may update itself, and from what: only a release build
//! (its `update.json` says so) running from an app bundle in a folder this user
//! can write to. Everything else is off, with the reason.

use std::fs;
use std::path::Path;

use eos_contracts::update::{UPDATE_BUILD_INFO_FILE, UpdateBuildInfo, UpdateOffReason};
use eos_contracts::validate;
use eos_domain::update::UpdateInstall;
use eos_platform::AppUpdatePlatform;

/// `platform` is what the system offers (`None`: Eos cannot update itself
/// there); `exec_path` is the running executable.
pub fn resolve_install(
    platform: Option<&dyn AppUpdatePlatform>,
    exec_path: &Path,
) -> Result<UpdateInstall, UpdateOffReason> {
    let platform = platform.ok_or(UpdateOffReason::Platform)?;
    // Not inside an app bundle: a build run from its target folder.
    let root = platform.bundle_root(exec_path).ok_or(UpdateOffReason::DevBuild)?;
    let info = fs::read(platform.resources_dir(&root).join(UPDATE_BUILD_INFO_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|value| validate::parse::<UpdateBuildInfo>(&value).ok())
        .ok_or(UpdateOffReason::DevBuild)?;

    // The swap renames the bundle in its folder and the bundle itself.
    let writable = root.parent().is_some_and(eos_platform::can_write) && eos_platform::can_write(&root);
    if !writable {
        return Err(UpdateOffReason::ReadOnly);
    }
    let root = root.into_os_string().into_string().map_err(|_| UpdateOffReason::DevBuild)?;
    Ok(UpdateInstall { version: info.version.0, root, platform: info.platform })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use eos_contracts::update::UpdatePlatform;

    use super::*;

    /// A system whose apps are `<name>.app/Contents/MacOS/<exe>`, as macOS lays them out.
    #[derive(Debug)]
    struct Bundles;

    impl AppUpdatePlatform for Bundles {
        fn feed_platform(&self) -> &'static str {
            "darwin-arm64"
        }
        fn bundle_root(&self, exec_path: &Path) -> Option<PathBuf> {
            let app = exec_path.parent()?.parent()?.parent()?;
            app.extension().is_some_and(|e| e == "app").then(|| app.to_owned())
        }
        fn resources_dir(&self, bundle_root: &Path) -> PathBuf {
            bundle_root.join("Contents/Resources")
        }
        fn file_modes(&self) -> bool {
            true
        }
        fn verify_bundle(&self, _staged: &Path, _installed: &Path) -> Result<(), eos_platform::Error> {
            Ok(())
        }
    }

    fn app(dir: &Path, build_info: Option<&str>) -> PathBuf {
        let root = dir.join("Eos.app");
        fs::create_dir_all(root.join("Contents/MacOS")).expect("dirs");
        fs::create_dir_all(root.join("Contents/Resources")).expect("dirs");
        if let Some(info) = build_info {
            fs::write(root.join("Contents/Resources/update.json"), info).expect("write");
        }
        root.join("Contents/MacOS/Eos")
    }

    #[test]
    fn a_release_build_in_a_writable_folder_updates_itself() {
        let dir = tempfile::tempdir().expect("dir");
        let exe = app(dir.path(), Some(r#"{"version":"0.2.0","channel":"stable","platform":"darwin-arm64"}"#));
        let install = resolve_install(Some(&Bundles), &exe).expect("on");
        assert_eq!(install.version, "0.2.0");
        assert_eq!(install.platform, UpdatePlatform::DarwinArm64);
        assert_eq!(Path::new(&install.root), dir.path().join("Eos.app"));
    }

    #[test]
    fn everything_else_is_off_with_its_reason() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(resolve_install(None, Path::new("/x/Eos.app/Contents/MacOS/Eos")), Err(UpdateOffReason::Platform));
        assert_eq!(
            resolve_install(Some(&Bundles), Path::new("/repo/target/debug/eos")),
            Err(UpdateOffReason::DevBuild)
        );
        let exe = app(dir.path(), None);
        assert_eq!(resolve_install(Some(&Bundles), &exe), Err(UpdateOffReason::DevBuild), "no update.json");
        let exe = app(dir.path(), Some(r#"{"version":"0.2.0","channel":"nightly","platform":"darwin-arm64"}"#));
        assert_eq!(resolve_install(Some(&Bundles), &exe), Err(UpdateOffReason::DevBuild), "another channel");
        let exe = app(dir.path(), Some("{"));
        assert_eq!(resolve_install(Some(&Bundles), &exe), Err(UpdateOffReason::DevBuild), "not JSON");
    }

    #[cfg(unix)]
    #[test]
    fn an_app_in_a_folder_the_user_cannot_write_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let locked = dir.path().join("locked");
        fs::create_dir_all(&locked).expect("dir");
        let exe = app(&locked, Some(r#"{"version":"0.2.0","channel":"stable","platform":"darwin-arm64"}"#));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).expect("lock");
        let resolved = resolve_install(Some(&Bundles), &exe);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock");
        assert_eq!(resolved, Err(UpdateOffReason::ReadOnly));
    }
}
