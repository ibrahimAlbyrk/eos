//! The `eos` command on the PATH: `<bin dir>/eos` links to this checkout's
//! launcher (`scripts/eos`). A link to another Eos launcher (another checkout,
//! or the TypeScript app's `manager/bin/eos`) is replaced; anything else
//! there is left alone.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Every launcher of this command says so in its text.
pub(crate) const LAUNCHER_MARKER: &str = "eos-launcher";
/// Where the TypeScript app's launcher lived in its checkout.
const TYPESCRIPT_LAUNCHER: &str = "manager/bin/eos";

/// What was found at `<bin dir>/eos` and done about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Linked {
    Created,
    AlreadyThere,
    /// The link pointed at this other launcher.
    Replaced(PathBuf),
    /// Not ours to change: a file, a folder, or a link to something else.
    LeftAlone(String),
}

/// The folder `eos` goes in: `$EOS_BIN_DIR`, else `~/.local/bin`.
pub(crate) fn bin_dir(env: Option<PathBuf>, home: Option<&Path>) -> Option<PathBuf> {
    env.filter(|dir| !dir.as_os_str().is_empty()).or_else(|| home.map(|home| home.join(".local/bin")))
}

/// Whether `target` is a launcher of this command, or the TypeScript app's.
fn is_launcher(target: &Path) -> bool {
    if target.ends_with(TYPESCRIPT_LAUNCHER) {
        return true;
    }
    fs::read_to_string(target).is_ok_and(|text| text.contains(LAUNCHER_MARKER))
}

/// Makes `<bin_dir>/eos` a link to `launcher`, by the rules above.
pub(crate) fn ensure(bin_dir: &Path, launcher: &Path) -> io::Result<Linked> {
    let link = bin_dir.join("eos");
    let found = match fs::symlink_metadata(&link) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(bin_dir)?;
            std::os::unix::fs::symlink(launcher, &link)?;
            return Ok(Linked::Created);
        }
        Err(e) => return Err(e),
    };
    if !found.file_type().is_symlink() {
        return Ok(Linked::LeftAlone(format!("{} is not a link", link.display())));
    }
    let target = fs::read_link(&link)?;
    let target = if target.is_absolute() { target } else { bin_dir.join(target) };
    if target == launcher || fs::canonicalize(&target).ok() == fs::canonicalize(launcher).ok() {
        return Ok(Linked::AlreadyThere);
    }
    if !is_launcher(&target) {
        return Ok(Linked::LeftAlone(format!(
            "{} links to {}, not to an Eos launcher",
            link.display(),
            target.display()
        )));
    }
    // A new link beside it, renamed over the old one: there is always an `eos`.
    let next = bin_dir.join(".eos.next");
    let _ = fs::remove_file(&next);
    std::os::unix::fs::symlink(launcher, &next)?;
    fs::rename(&next, &link)?;
    Ok(Linked::Replaced(target))
}

/// The line that tells the person about it; `path` is `$PATH`.
pub(crate) fn describe(linked: &io::Result<Linked>, bin_dir: &Path, path: Option<&str>) -> String {
    let link = bin_dir.join("eos");
    let on_path = path.is_some_and(|path| std::env::split_paths(path).any(|dir| dir == bin_dir));
    let hint = if on_path { String::new() } else { format!(" Add {} to your PATH to run it.", bin_dir.display()) };
    match linked {
        Ok(Linked::Created) => format!("The eos command is at {}.{hint}", link.display()),
        Ok(Linked::AlreadyThere) => format!("The eos command at {} runs this checkout.{hint}", link.display()),
        Ok(Linked::Replaced(old)) => {
            format!("The eos command at {} runs this checkout now (it ran {}).{hint}", link.display(), old.display())
        }
        Ok(Linked::LeftAlone(why)) => {
            format!("The eos command was not linked: {why}. Move it away and run this again to get it.")
        }
        Err(e) => format!("The eos command could not be linked at {} ({e}).", link.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rig {
        _tmp: tempfile::TempDir,
        bin: PathBuf,
        launcher: PathBuf,
        root: PathBuf,
    }

    fn rig() -> Rig {
        let tmp = tempfile::tempdir().expect("tmp");
        let root = tmp.path().canonicalize().expect("root");
        let launcher = root.join("eos-rs/scripts/eos");
        fs::create_dir_all(launcher.parent().expect("scripts")).expect("scripts");
        fs::write(&launcher, format!("#!/usr/bin/env bash\n# {LAUNCHER_MARKER}\n")).expect("launcher");
        Rig { bin: root.join("home/.local/bin"), launcher, root, _tmp: tmp }
    }

    fn target(rig: &Rig) -> PathBuf {
        fs::read_link(rig.bin.join("eos")).expect("a link")
    }

    #[test]
    fn a_missing_command_is_linked_and_its_folder_made() {
        let rig = rig();
        assert_eq!(ensure(&rig.bin, &rig.launcher).expect("links"), Linked::Created);
        assert_eq!(target(&rig), rig.launcher);
        assert_eq!(ensure(&rig.bin, &rig.launcher).expect("again"), Linked::AlreadyThere);
    }

    #[test]
    fn the_typescript_launcher_is_replaced_even_when_its_checkout_is_gone() {
        let rig = rig();
        fs::create_dir_all(&rig.bin).expect("bin");
        let old = rig.root.join("eos/manager/bin/eos");
        std::os::unix::fs::symlink(&old, rig.bin.join("eos")).expect("old link");
        assert_eq!(ensure(&rig.bin, &rig.launcher).expect("links"), Linked::Replaced(old));
        assert_eq!(target(&rig), rig.launcher);
        assert!(!rig.bin.join(".eos.next").exists());
    }

    #[test]
    fn another_checkouts_launcher_is_replaced() {
        let rig = rig();
        let other = rig.root.join("other/scripts/eos");
        fs::create_dir_all(other.parent().expect("scripts")).expect("scripts");
        fs::write(&other, format!("# {LAUNCHER_MARKER}\n")).expect("other launcher");
        fs::create_dir_all(&rig.bin).expect("bin");
        std::os::unix::fs::symlink("../../../other/scripts/eos", rig.bin.join("eos")).expect("relative link");
        assert!(matches!(ensure(&rig.bin, &rig.launcher).expect("links"), Linked::Replaced(_)));
        assert_eq!(target(&rig), rig.launcher);
    }

    #[test]
    fn a_file_or_a_link_to_something_else_is_left_alone() {
        let rig = rig();
        fs::create_dir_all(&rig.bin).expect("bin");
        fs::write(rig.bin.join("eos"), "#!/bin/sh\necho mine\n").expect("a file");
        assert!(matches!(ensure(&rig.bin, &rig.launcher).expect("looks"), Linked::LeftAlone(_)));
        assert_eq!(fs::read_to_string(rig.bin.join("eos")).expect("kept"), "#!/bin/sh\necho mine\n");

        fs::remove_file(rig.bin.join("eos")).expect("gone");
        let tool = rig.root.join("opt/bin/eos");
        fs::create_dir_all(tool.parent().expect("bin")).expect("bin");
        fs::write(&tool, "another program called eos").expect("tool");
        std::os::unix::fs::symlink(&tool, rig.bin.join("eos")).expect("link");
        let linked = ensure(&rig.bin, &rig.launcher);
        assert!(matches!(linked, Ok(Linked::LeftAlone(_))));
        assert_eq!(target(&rig), tool);
        assert!(describe(&linked, &rig.bin, None).contains("was not linked"));
    }

    #[test]
    fn the_folder_is_the_override_else_the_users_local_bin_and_the_path_is_checked() {
        assert_eq!(bin_dir(Some("/t/bin".into()), Some(Path::new("/Users/me"))), Some(PathBuf::from("/t/bin")));
        assert_eq!(bin_dir(Some("".into()), Some(Path::new("/Users/me"))), Some(PathBuf::from("/Users/me/.local/bin")));
        let bin = Path::new("/Users/me/.local/bin");
        let on = describe(&Ok(Linked::Created), bin, Some("/usr/bin:/Users/me/.local/bin"));
        assert_eq!(on, "The eos command is at /Users/me/.local/bin/eos.");
        assert!(
            describe(&Ok(Linked::Created), bin, Some("/usr/bin")).contains("Add /Users/me/.local/bin to your PATH")
        );
    }
}
