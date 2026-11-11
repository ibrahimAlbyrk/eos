//! A plugin copied from a folder on this computer.

use std::fs;
use std::path::Path;

use eos_core::Error;
use eos_core::plugin::FetchedPlugin;

use crate::tarball::PackageLimits;

/// Never copied: they are not part of a plugin's own source.
const SKIPPED: [&str; 2] = ["node_modules", ".git"];

fn invalid(message: String) -> Error {
    Error::Validation(message)
}

struct Copy<'a> {
    source: &'a str,
    limits: PackageLimits,
    files: u64,
    bytes: u64,
}

impl Copy<'_> {
    fn folder(&mut self, from: &Path, to: &Path) -> Result<(), Error> {
        let failed = |path: &Path, e: std::io::Error| invalid(format!("couldn't copy {}: {e}", path.display()));
        fs::create_dir_all(to).map_err(|e| failed(to, e))?;
        for entry in fs::read_dir(from).map_err(|e| failed(from, e))? {
            let entry = entry.map_err(|e| failed(from, e))?;
            let name = entry.file_name();
            let text = name.to_string_lossy();
            if SKIPPED.contains(&text.as_ref()) || text.starts_with('.') {
                continue;
            }
            let src = entry.path();
            let kind = fs::symlink_metadata(&src).map_err(|e| failed(&src, e))?.file_type();
            if kind.is_symlink() {
                return Err(invalid(format!("{} is a link — not allowed in a plugin", src.display())));
            }
            if kind.is_dir() {
                self.folder(&src, &to.join(&name))?;
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            self.files += 1;
            self.bytes += fs::metadata(&src).map_err(|e| failed(&src, e))?.len();
            if self.files > self.limits.files || self.bytes > self.limits.bytes {
                return Err(invalid(format!("{} is too big for a plugin", self.source)));
            }
            fs::copy(&src, to.join(&name)).map_err(|e| failed(&src, e))?;
        }
        Ok(())
    }
}

/// Copies the folder at `path` into `dir`. Edits to the original do not follow.
pub(super) fn copy(path: &str, dir: &Path, limits: PackageLimits) -> Result<FetchedPlugin, Error> {
    let from = Path::new(path);
    if !from.is_absolute() {
        return Err(invalid(format!("{path} isn't a full path")));
    }
    let meta = fs::metadata(from).map_err(|_| invalid(format!("{path} doesn't exist")))?;
    if !meta.is_dir() {
        return Err(invalid(format!("{path} isn't a folder")));
    }
    Copy { source: path, limits, files: 0, bytes: 0 }.folder(from, dir)?;
    Ok(FetchedPlugin { resolved: path.to_owned(), integrity: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tarball::PACKAGE_LIMITS;

    const MANIFEST: &str = r#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("the folder")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    // infra/src/__tests__/plugin-install.test.ts: local plugin fetcher
    #[test]
    fn copies_the_folder_without_node_modules_git_or_dot_files() {
        let src = tempfile::tempdir().expect("a folder");
        fs::write(src.path().join("plugin.json"), MANIFEST).expect("a file");
        fs::create_dir_all(src.path().join("node_modules/x")).expect("folders");
        fs::write(src.path().join("node_modules/x/i.js"), "").expect("a file");
        fs::create_dir_all(src.path().join(".git")).expect("a folder");
        fs::write(src.path().join(".env"), "SECRET=1").expect("a file");
        fs::create_dir_all(src.path().join("src/.cache")).expect("folders");
        fs::write(src.path().join("src/ui.jsx"), "export default 1").expect("a file");
        let dir = tempfile::tempdir().expect("a folder");
        let path = src.path().to_string_lossy().into_owned();

        let got = copy(&path, dir.path(), PACKAGE_LIMITS).expect("copies");
        assert_eq!(got, FetchedPlugin { resolved: path, integrity: None });
        assert_eq!(names(dir.path()), ["plugin.json", "src"]);
        assert_eq!(names(&dir.path().join("src")), ["ui.jsx"]);
        assert_eq!(fs::read_to_string(dir.path().join("plugin.json")).expect("the copy"), MANIFEST);
    }

    #[test]
    fn refuses_links_relative_paths_and_what_is_not_a_folder() {
        let dir = tempfile::tempdir().expect("a folder");
        let message = |path: &str| copy(path, dir.path(), PACKAGE_LIMITS).expect_err("refused").to_string();
        assert_eq!(message("rel/dir"), "rel/dir isn't a full path");
        assert_eq!(message("/definitely/not/here"), "/definitely/not/here doesn't exist");

        let src = tempfile::tempdir().expect("a folder");
        let file = src.path().join("plugin.json");
        fs::write(&file, MANIFEST).expect("a file");
        assert_eq!(message(&file.to_string_lossy()), format!("{} isn't a folder", file.display()));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", src.path().join("hosts")).expect("a link");
            let link = src.path().join("hosts");
            assert_eq!(
                message(&src.path().to_string_lossy()),
                format!("{} is a link — not allowed in a plugin", link.display())
            );
            assert!(!dir.path().join("hosts").exists(), "the link's target was not copied");
        }
    }

    #[test]
    fn refuses_a_folder_past_the_limits() {
        let src = tempfile::tempdir().expect("a folder");
        for i in 0..4 {
            fs::write(src.path().join(format!("f{i}.js")), "12345").expect("a file");
        }
        let dir = tempfile::tempdir().expect("a folder");
        let path = src.path().to_string_lossy().into_owned();
        let many = copy(&path, dir.path(), PackageLimits { files: 3, bytes: 1000 }).expect_err("too many");
        assert_eq!(many.to_string(), format!("{path} is too big for a plugin"));
        let big = copy(&path, dir.path(), PackageLimits { files: 100, bytes: 12 }).expect_err("too big");
        assert_eq!(big.to_string(), format!("{path} is too big for a plugin"));
    }
}
