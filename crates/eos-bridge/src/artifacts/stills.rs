//! JPEG stills of artifact views, one per `slug@version`. Versions are immutable, so a
//! versioned still never goes stale; `live` stands for no known version. The panel and the
//! peek paint one at once while the live view loads.

use std::path::{Path, PathBuf};

use base64::Engine;

/// The newest stills kept; older ones are removed after each write.
pub const KEEP: usize = 300;

#[derive(Debug, Clone)]
pub struct StillStore {
    dir: PathBuf,
}

fn clean(text: &str, keep: impl Fn(char) -> bool, max: usize) -> String {
    text.chars().map(|c| if keep(c) { c } else { '_' }).take(max).collect()
}

impl StillStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn file(&self, slug: &str, version: Option<&str>) -> PathBuf {
        let version = version
            .filter(|v| !v.is_empty())
            .map_or_else(|| "live".to_owned(), |v| clean(v, |c| c.is_ascii_alphanumeric() || "._-".contains(c), 96));
        let slug: String = slug.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join(format!("{slug}@{version}.jpg"))
    }

    pub fn has(&self, slug: &str, version: Option<&str>) -> bool {
        self.file(slug, version).is_file()
    }

    /// The still as a `data:` URL, or `None` when there is none.
    pub fn read(&self, slug: &str, version: Option<&str>) -> Option<String> {
        let bytes = std::fs::read(self.file(slug, version)).ok()?;
        Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    /// Writes through a temporary file, then keeps the newest [`KEEP`].
    pub fn write(&self, slug: &str, version: Option<&str>, jpeg: &[u8]) -> std::io::Result<()> {
        let file = self.file(slug, version);
        std::fs::create_dir_all(&self.dir)?;
        let tmp = file.with_extension("jpg.tmp");
        std::fs::write(&tmp, jpeg)?;
        std::fs::rename(&tmp, &file)?;
        prune(&self.dir, KEEP);
        Ok(())
    }
}

fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dated: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jpg"))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
        .collect();
    if dated.len() <= keep {
        return;
    }
    dated.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    for (_, path) in dated.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir as TestDir;

    #[test]
    fn a_still_is_kept_per_version_and_read_as_a_data_url() {
        let dir = TestDir::new("stills");
        let store = StillStore::new(dir.path().join("artifact-stills"));
        let slug = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
        assert!(!store.has(slug, Some("v_1")));
        assert_eq!(store.read(slug, Some("v_1")), None);
        store.write(slug, Some("v_1"), b"\xff\xd8jpeg").unwrap();
        assert!(store.has(slug, Some("v_1")));
        assert!(!store.has(slug, Some("v_2")) && !store.has(slug, None));
        assert_eq!(store.read(slug, Some("v_1")).unwrap(), "data:image/jpeg;base64,/9hqcGVn");
        store.write(slug, None, b"x").unwrap();
        assert!(dir.path().join(format!("artifact-stills/{slug}@live.jpg")).is_file());
    }

    #[test]
    fn names_never_leave_the_folder() {
        let store = StillStore::new("/stills");
        assert_eq!(store.file("../../etc", Some("../passwd")), PathBuf::from("/stills/etc@.._passwd.jpg"));
        assert_eq!(store.file("a/b", Some("v 1/2")), PathBuf::from("/stills/ab@v_1_2.jpg"));
    }

    #[test]
    fn only_the_newest_are_kept() {
        let dir = TestDir::new("stills-prune");
        for n in 0..5 {
            let file = dir.path().join(format!("s{n}@live.jpg"));
            std::fs::write(&file, b"x").unwrap();
            let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + n);
            std::fs::File::options().write(true).open(&file).unwrap().set_modified(at).unwrap();
        }
        prune(dir.path(), 3);
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["s2@live.jpg", "s3@live.jpg", "s4@live.jpg"]);
    }
}
