//! Putting the app's screen saver where the system finds it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::copy::clone_copy_tree;
use crate::error::Error;

/// The screen saver's bundle, as the app ships it in its resources and as it is installed.
pub const SCREEN_SAVER_BUNDLE: &str = "Eos.saver";

/// Copies the saver bundle at `bundled` into `savers_dir` (the user's screen savers folder),
/// replacing an older copy of it, and returns where it now is. The copy is made beside the
/// old one first, so a failed copy leaves the old one in place.
pub fn install_screen_saver(bundled: &Path, savers_dir: &Path) -> Result<PathBuf, Error> {
    if !bundled.join("Contents").join("Info.plist").is_file() {
        return Err(Error::Io(io::Error::new(
            io::ErrorKind::NotFound,
            format!("the app holds no screen saver at {}", bundled.display()),
        )));
    }
    let name = bundled.file_name().unwrap_or(SCREEN_SAVER_BUNDLE.as_ref());
    fs::create_dir_all(savers_dir)?;
    let staged = savers_dir.join(format!(".{}.partial", name.to_string_lossy()));
    remove_any(&staged)?;
    let dest = savers_dir.join(name);
    let placed = clone_copy_tree(bundled, &staged, &|_| true).and_then(|()| {
        remove_any(&dest)?;
        fs::rename(&staged, &dest)
    });
    if let Err(e) = placed {
        let _ = remove_any(&staged);
        return Err(e.into());
    }
    Ok(dest)
}

/// Removes a file, link or folder; one that is not there is not an error.
fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saver(root: &Path, marker: &str) -> PathBuf {
        let bundle = root.join(SCREEN_SAVER_BUNDLE);
        fs::create_dir_all(bundle.join("Contents/MacOS")).expect("dirs");
        fs::create_dir_all(bundle.join("Contents/Resources")).expect("dirs");
        fs::write(bundle.join("Contents/Info.plist"), "<plist/>").expect("plist");
        fs::write(bundle.join("Contents/MacOS/EosSaver"), marker).expect("binary");
        bundle
    }

    #[test]
    fn a_fresh_install_creates_the_folder_and_copies_the_bundle() {
        let tmp = tempfile::tempdir().expect("tmp");
        let bundled = saver(&tmp.path().join("app"), "new");
        let savers = tmp.path().join("Library/Screen Savers");
        let dest = install_screen_saver(&bundled, &savers).expect("installed");
        assert_eq!(dest, savers.join(SCREEN_SAVER_BUNDLE));
        assert_eq!(fs::read_to_string(dest.join("Contents/MacOS/EosSaver")).expect("read"), "new");
        assert!(dest.join("Contents/Info.plist").is_file());
        let left: Vec<_> = fs::read_dir(&savers).expect("list").map(|e| e.expect("entry").file_name()).collect();
        assert_eq!(left, [SCREEN_SAVER_BUNDLE], "no staging left behind");
    }

    #[test]
    fn an_older_copy_is_replaced_whole() {
        let tmp = tempfile::tempdir().expect("tmp");
        let savers = tmp.path().join("Screen Savers");
        let old = saver(&savers, "old");
        fs::write(old.join("Contents/Resources/gone.png"), "x").expect("old file");
        let other = savers.join("Other.saver");
        fs::create_dir_all(&other).expect("other saver");
        let bundled = saver(&tmp.path().join("app"), "new");
        let dest = install_screen_saver(&bundled, &savers).expect("installed");
        assert_eq!(fs::read_to_string(dest.join("Contents/MacOS/EosSaver")).expect("read"), "new");
        assert!(!dest.join("Contents/Resources/gone.png").exists(), "nothing of the old copy stays");
        assert!(other.is_dir(), "other savers are left alone");
    }

    #[test]
    fn a_missing_bundle_or_an_unwritable_folder_fails_and_keeps_the_old_copy() {
        let tmp = tempfile::tempdir().expect("tmp");
        let savers = tmp.path().join("Screen Savers");
        saver(&savers, "old");
        let missing = install_screen_saver(&tmp.path().join("app/Eos.saver"), &savers).expect_err("no bundle");
        assert!(missing.to_string().contains("no screen saver"), "{missing}");
        assert_eq!(fs::read_to_string(savers.join("Eos.saver/Contents/MacOS/EosSaver")).expect("read"), "old");

        let bundled = saver(&tmp.path().join("app"), "new");
        let blocked = tmp.path().join("a file");
        fs::write(&blocked, "").expect("file");
        assert!(install_screen_saver(&bundled, &blocked.join("Screen Savers")).is_err());
    }
}
