//! The `eos` command on the user's PATH (07 §4.4): `<bin dir>/eos` links to the helper the
//! app ships (`Contents/Helpers/eos`). An empty place, or a link to another app's helper, is
//! made this app's; a link to a developer's launcher (a checkout's `scripts/eos`, which
//! forwards these commands) is left; anything else is left and reported.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// What the app needs to put the command on the PATH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCommand {
    /// The helper inside the app.
    pub helper: PathBuf,
    /// Where the link goes: `~/.local/bin`.
    pub bin_dir: PathBuf,
    /// The user's home, whose shell profiles say what their PATH holds.
    pub home: PathBuf,
}

/// A developer's launcher says so in its text (`xtask`'s `LAUNCHER_MARKER`).
const LAUNCHER_MARKER: &str = "eos-launcher";
/// The profiles a login shell reads, where a PATH entry is added.
const PROFILES: [&str; 6] = [".zprofile", ".zshrc", ".zshenv", ".bash_profile", ".profile", ".config/fish/config.fish"];

/// Another Eos app's helper.
fn is_helper(target: &Path) -> bool {
    target.ends_with("Contents/Helpers/eos")
        && target.ancestors().nth(3).is_some_and(|app| app.extension().is_some_and(|e| e == "app"))
}

fn is_launcher(target: &Path) -> bool {
    fs::read_to_string(target).is_ok_and(|text| text.contains(LAUNCHER_MARKER))
}

fn target_of(link: &Path, bin_dir: &Path) -> Option<PathBuf> {
    let target = fs::read_link(link).ok()?;
    Some(if target.is_absolute() { target } else { bin_dir.join(target) })
}

fn same(a: &Path, b: &Path) -> bool {
    a == b || fs::canonicalize(a).ok().is_some_and(|a| Some(a) == fs::canonicalize(b).ok())
}

/// Whether a profile adds the folder to the PATH, or the app's own PATH holds it. The app
/// started from the Finder has the system's PATH only, so the profiles are read.
fn on_path(command: &CliCommand) -> bool {
    let named = |text: &str| {
        let dir = command.bin_dir.to_string_lossy();
        let short = command.bin_dir.strip_prefix(&command.home).map(|p| p.to_string_lossy().into_owned());
        text.contains(dir.as_ref())
            || short.is_ok_and(|s| text.contains(&format!("$HOME/{s}")) || text.contains(&format!("~/{s}")))
    };
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir == command.bin_dir))
        || PROFILES.iter().any(|p| fs::read_to_string(command.home.join(p)).is_ok_and(|text| named(&text)))
}

/// `{installed, path, onPath}`: `installed` when the command there runs this app (its helper,
/// or a developer's launcher that forwards).
pub fn state(command: &CliCommand) -> Value {
    let link = command.bin_dir.join("eos");
    let installed = target_of(&link, &command.bin_dir).is_some_and(|t| same(&t, &command.helper) || is_launcher(&t));
    json!({ "installed": installed, "path": link.to_string_lossy(), "onPath": on_path(command) })
}

/// Makes `<bin dir>/eos` the app's command, by the rules above; `Err`: one line on why not.
pub fn install(command: &CliCommand) -> Result<(), String> {
    let link = command.bin_dir.join("eos");
    let found = match fs::symlink_metadata(&link) {
        Ok(found) => found,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(&command.bin_dir).map_err(|e| e.to_string())?;
            return std::os::unix::fs::symlink(&command.helper, &link).map_err(|e| e.to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    if !found.file_type().is_symlink() {
        return Err(format!("{} is not a link: move it away to put Eos's command there", link.display()));
    }
    let Some(target) = target_of(&link, &command.bin_dir) else { return Err("the link cannot be read".into()) };
    if same(&target, &command.helper) || is_launcher(&target) {
        return Ok(());
    }
    if !is_helper(&target) {
        return Err(format!("{} runs {}, not Eos", link.display(), target.display()));
    }
    // A new link renamed over the old one: there is always an `eos`.
    let next = command.bin_dir.join(".eos.next");
    let _ = fs::remove_file(&next);
    std::os::unix::fs::symlink(&command.helper, &next).map_err(|e| e.to_string())?;
    fs::rename(&next, &link).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    fn command(dir: &Path) -> CliCommand {
        let helper = dir.join("Apps/Eos.app/Contents/Helpers/eos");
        fs::create_dir_all(helper.parent().unwrap()).unwrap();
        fs::write(&helper, "mach-o").unwrap();
        CliCommand { helper, bin_dir: dir.join("home/.local/bin"), home: dir.join("home") }
    }

    #[test]
    fn an_empty_place_or_another_apps_helper_becomes_this_apps_command() {
        let dir = Dir::new("cli-link");
        let cmd = command(dir.path());
        assert_eq!(state(&cmd)["installed"], false);
        install(&cmd).unwrap();
        assert_eq!(fs::read_link(cmd.bin_dir.join("eos")).unwrap(), cmd.helper);
        assert_eq!(state(&cmd)["installed"], true);

        let other = dir.path().join("Old/Eos.app/Contents/Helpers/eos");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::remove_file(cmd.bin_dir.join("eos")).unwrap();
        std::os::unix::fs::symlink(&other, cmd.bin_dir.join("eos")).unwrap();
        install(&cmd).unwrap();
        assert_eq!(fs::read_link(cmd.bin_dir.join("eos")).unwrap(), cmd.helper);
    }

    #[test]
    fn a_developers_launcher_and_anything_else_are_left() {
        let dir = Dir::new("cli-link-left");
        let cmd = command(dir.path());
        fs::create_dir_all(&cmd.bin_dir).unwrap();
        let launcher = dir.path().join("eos-rs/scripts/eos");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::write(&launcher, "#!/usr/bin/env bash\n# eos-launcher: forwards\n").unwrap();
        std::os::unix::fs::symlink(&launcher, cmd.bin_dir.join("eos")).unwrap();
        install(&cmd).unwrap();
        assert_eq!(fs::read_link(cmd.bin_dir.join("eos")).unwrap(), launcher, "it forwards: left");
        assert_eq!(state(&cmd)["installed"], true);

        fs::remove_file(cmd.bin_dir.join("eos")).unwrap();
        std::os::unix::fs::symlink("/usr/bin/true", cmd.bin_dir.join("eos")).unwrap();
        assert!(install(&cmd).unwrap_err().contains("not Eos"));
        fs::remove_file(cmd.bin_dir.join("eos")).unwrap();
        fs::write(cmd.bin_dir.join("eos"), "mine").unwrap();
        assert!(install(&cmd).is_err());
        assert_eq!(fs::read_to_string(cmd.bin_dir.join("eos")).unwrap(), "mine");
    }

    #[test]
    fn on_path_reads_the_shell_profiles() {
        let dir = Dir::new("cli-link-path");
        let cmd = command(dir.path());
        assert_eq!(state(&cmd)["onPath"], false);
        fs::create_dir_all(&cmd.home).unwrap();
        fs::write(cmd.home.join(".zprofile"), "export PATH=\"$HOME/.local/bin:$PATH\"\n").unwrap();
        assert_eq!(state(&cmd)["onPath"], true);
    }
}
