//! Where the esbuild binary is.

use std::fs;
use std::path::{Path, PathBuf};

/// The binary the app ships (`bundled`: its full path, when the app has
/// one), else — in a development checkout — the one `npm ci` put under
/// `infra/node_modules` for the TypeScript tree. `None`: plugins with a UI
/// cannot be built, and each says so.
pub fn locate(bundled: Option<&Path>, checkout: Option<&Path>) -> Option<PathBuf> {
    bundled.filter(|path| path.is_file()).map(Path::to_owned).or_else(|| checkout.and_then(installed_by_npm))
}

/// npm installs exactly one `@esbuild/<system>` package: the one for this
/// computer. Its binary is `bin/esbuild`, or `esbuild.exe` where programs
/// carry that suffix.
fn installed_by_npm(checkout: &Path) -> Option<PathBuf> {
    let packages = checkout.join("infra/node_modules/@esbuild");
    let mut found: Vec<PathBuf> = fs::read_dir(packages)
        .ok()?
        .flatten()
        .flat_map(|package| [package.path().join("bin/esbuild"), package.path().join("esbuild.exe")])
        .filter(|binary| binary.is_file())
        .collect();
    found.sort();
    found.into_iter().next()
}

/// The repository this crate was compiled in, for a development build's
/// fallback. A release build has no checkout to look in.
pub fn dev_checkout() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).map(Path::to_owned)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_binary_wins_and_a_missing_one_falls_back() {
        let temp = tempfile::tempdir().expect("a folder");
        let bundled = temp.path().join("esbuild");
        let npm = temp.path().join("repo/infra/node_modules/@esbuild/some-system/bin/esbuild");
        fs::create_dir_all(npm.parent().expect("a parent")).expect("folders");
        fs::write(&npm, "").expect("a file");
        let repo = temp.path().join("repo");

        assert_eq!(locate(Some(&bundled), Some(&repo)), Some(npm.clone()), "the bundled path is not there yet");
        fs::write(&bundled, "").expect("a file");
        assert_eq!(locate(Some(&bundled), Some(&repo)), Some(bundled));
        assert_eq!(locate(None, Some(&repo)), Some(npm));
        assert_eq!(locate(None, None), None);
        assert_eq!(locate(None, Some(temp.path())), None, "no node_modules here");
    }

    #[test]
    fn a_development_build_knows_its_checkout() {
        let checkout = dev_checkout().expect("tests are development builds");
        assert!(checkout.join("rust/crates/eos-plugin-build").is_dir());
    }
}
