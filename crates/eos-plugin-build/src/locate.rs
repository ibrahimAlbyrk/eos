//! Where the esbuild binary is.

use std::path::{Path, PathBuf};

use crate::ESBUILD_VERSION;

/// The binary the app ships (`bundled`: its full path, when the app has
/// one), else — in a development checkout — the pinned release
/// `host/scripts/setup.sh` fetched into the host's work folder. `None`:
/// plugins with a UI cannot be built, and each says so.
pub fn locate(bundled: Option<&Path>, checkout: Option<&Path>) -> Option<PathBuf> {
    bundled.filter(|path| path.is_file()).map(Path::to_owned).or_else(|| checkout.and_then(fetched_by_setup))
}

fn fetched_by_setup(checkout: &Path) -> Option<PathBuf> {
    let binary = checkout.join(format!("host/.work/tools/esbuild-{ESBUILD_VERSION}/esbuild"));
    binary.is_file().then_some(binary)
}

/// The repository this crate was compiled in, for a development build's
/// fallback. A release build has no checkout to look in.
pub fn dev_checkout() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).map(Path::to_owned)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn the_bundled_binary_wins_and_a_missing_one_falls_back() {
        let temp = tempfile::tempdir().expect("a folder");
        let bundled = temp.path().join("esbuild");
        let fetched = temp.path().join(format!("repo/host/.work/tools/esbuild-{ESBUILD_VERSION}/esbuild"));
        fs::create_dir_all(fetched.parent().expect("a parent")).expect("folders");
        fs::write(&fetched, "").expect("a file");
        let repo = temp.path().join("repo");

        assert_eq!(locate(Some(&bundled), Some(&repo)), Some(fetched.clone()), "the bundled path is not there yet");
        fs::write(&bundled, "").expect("a file");
        assert_eq!(locate(Some(&bundled), Some(&repo)), Some(bundled));
        assert_eq!(locate(None, Some(&repo)), Some(fetched));
        assert_eq!(locate(None, None), None);
        assert_eq!(locate(None, Some(temp.path())), None, "nothing fetched here");
    }

    #[test]
    fn a_development_build_knows_its_checkout() {
        let checkout = dev_checkout().expect("tests are development builds");
        assert!(checkout.join("crates/eos-plugin-build").is_dir());
    }
}
