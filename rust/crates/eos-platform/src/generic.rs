//! Any system without an adapter of its own: the claude binary's file login
//! store, no system trash, sleep control or secret store, no desktop integration.

use std::fs::Permissions;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::Error;
use crate::host::{
    AppUpdatePlatform, Argv, CredentialStore, DefaultApp, Desktop, HostFeatures, HostPlatform, KeepAwake, OpenTarget,
    SpawnCommand, TerminalShell,
};
use crate::paths::home_dir;
use crate::process;
use crate::shell::PosixShell;

#[derive(Debug)]
pub(crate) struct Generic {
    shell: PosixShell,
}

pub(crate) static GENERIC: Generic = Generic { shell: PosixShell::from_env() };

/// The claude binary's file store (`<dir>/.credentials.json`): what it uses
/// wherever there is no system keychain.
#[derive(Debug)]
struct FileCredentials;

impl CredentialStore for FileCredentials {
    fn read_claude_store(&self, store_dir: Option<&Path>) -> Option<String> {
        let dir = match store_dir {
            Some(dir) => dir.to_owned(),
            None => home_dir()?.join(".claude"),
        };
        std::fs::read_to_string(dir.join(".credentials.json")).ok()
    }

    fn write_claude_store(&self, store_dir: &Path, json: &str) -> Result<(), Error> {
        let file = store_dir.join(".credentials.json");
        std::fs::write(&file, json)?;
        if let Some(private) = owner_only() {
            std::fs::set_permissions(&file, private)?;
        }
        Ok(())
    }

    fn clear_claude_store(&self, store_dir: &Path) {
        let _ = std::fs::remove_file(store_dir.join(".credentials.json"));
    }

    fn read_secret(&self, _service: &str) -> Option<String> {
        None
    }

    fn write_secret(&self, _service: &str, _secret: &str) -> Result<(), Error> {
        Err(Error::Unsupported("secret storage"))
    }

    fn delete_secret(&self, _service: &str) {}
}

#[derive(Debug)]
struct NoDesktop;

impl Desktop for NoDesktop {
    fn open_path(&self, _path: &Path) -> Result<(), Error> {
        Err(Error::Unsupported("opening a path in another app"))
    }

    fn reveal_path(&self, _path: &Path) -> Result<(), Error> {
        Err(Error::Unsupported("revealing a path in the file manager"))
    }

    fn open_in(
        &self,
        _target: OpenTarget<'_>,
        _path: &Path,
        _line: Option<u32>,
        _column: Option<u32>,
    ) -> Result<(), Error> {
        Err(Error::Unsupported("opening a path in another app"))
    }

    fn app_installed(&self, _app_name: &str) -> bool {
        false
    }

    fn default_app(&self, _file: &Path) -> Option<DefaultApp> {
        None
    }

    fn render_app_icon(&self, _bundle_path: &Path, _out: &Path) -> Result<(), Error> {
        Err(Error::Unsupported("app icons"))
    }

    fn render_scaled_image(&self, _image: &Path, _width: u32, _height: u32, _out: &Path) -> Result<(), Error> {
        Err(Error::Unsupported("scaling images"))
    }
}

impl HostPlatform for Generic {
    fn os(&self) -> &'static str {
        std::env::consts::OS
    }

    fn features(&self) -> HostFeatures {
        HostFeatures { remote: true, posix_shell: true }
    }

    fn friendly_computer_name(&self) -> Option<String> {
        None
    }

    fn fd_ceiling(&self) -> Option<u64> {
        None
    }

    fn native_recursive_watch(&self) -> bool {
        false
    }

    fn credentials(&self) -> &dyn CredentialStore {
        &FileCredentials
    }

    fn trash(&self, _path: &Path) -> Result<(), Error> {
        Err(Error::Unsupported("the system trash"))
    }

    fn keep_awake(&self, _pid: u32) -> Result<KeepAwake, Error> {
        Err(Error::Unsupported("keeping the computer awake"))
    }

    fn shell(&self) -> &dyn TerminalShell {
        &self.shell
    }

    fn script_shell(&self) -> Option<PathBuf> {
        Some(PathBuf::from("/bin/sh"))
    }

    fn executable_names(&self, name: &str) -> Vec<String> {
        vec![name.to_owned()]
    }

    fn spawn_command(&self, file: &str, args: &[String]) -> SpawnCommand {
        SpawnCommand { file: file.to_owned(), args: args.to_vec(), verbatim_arguments: false }
    }

    fn isolate_command(&self, command: &mut Command) {
        process::isolate_command(command);
    }

    fn kill_process_tree(&self, pid: u32) -> Result<(), Error> {
        process::kill_process_tree(pid)
    }

    fn process_alive(&self, pid: u32) -> bool {
        process::process_alive(pid)
    }

    fn chromium_browsers(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn location_helper(&self, _resources: &Path, _wait_seconds: u32) -> Option<Argv> {
        None
    }

    fn app_updates(&self) -> Option<&dyn AppUpdatePlatform> {
        None
    }

    fn desktop(&self) -> &dyn Desktop {
        &NoDesktop
    }

    fn private_file_permissions(&self) -> Option<Permissions> {
        owner_only()
    }
}

/// `rw-------` where files have permission bits.
pub(crate) fn owner_only() -> Option<Permissions> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_without_an_adapter_offers_the_bare_minimum() {
        let host: &dyn HostPlatform = &GENERIC;
        assert!(matches!(host.keep_awake(1), Err(Error::Unsupported(_))));
        assert!(matches!(host.trash(Path::new("/nowhere")), Err(Error::Unsupported(_))));
        assert!(matches!(host.credentials().write_secret("svc", "s"), Err(Error::Unsupported(_))));
        assert_eq!(host.credentials().read_secret("svc"), None);
        assert!(host.app_updates().is_none());
        assert!(host.chromium_browsers().is_empty());
        assert!(matches!(host.desktop().open_path(Path::new("/nowhere")), Err(Error::Unsupported(_))));
        assert_eq!(host.executable_names("claude"), ["claude"]);
    }

    #[test]
    fn the_claude_login_is_a_file_in_the_store_folder() {
        let dir = tempfile::tempdir().expect("dir");
        let creds = GENERIC.credentials();
        assert_eq!(creds.read_claude_store(Some(dir.path())), None);
        std::fs::write(dir.path().join(".credentials.json"), "{\"a\":1}").expect("write");
        assert_eq!(creds.read_claude_store(Some(dir.path())).as_deref(), Some("{\"a\":1}"));
        creds.clear_claude_store(dir.path());
        creds.clear_claude_store(dir.path());
        assert_eq!(creds.read_claude_store(Some(dir.path())), None);
    }
}
