//! Where an install waits for review, and how it moves in: under the plugins
//! folder (`root`) in dot-folders the plugin watcher ignores —
//!
//! ```text
//! .staging/<stagingId>/   a fetched plugin (regenerable: cleared at start)
//! .trash/<id>-<time>/     a replaced or removed plugin (kept, never deleted)
//! ```
//!
//! Both sit on the same volume as the plugin folders, so moving one in or
//! out is a rename: a plugin folder is whole or absent, never half-copied.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::PLUGIN_MANIFEST_FILE;
use eos_core::plugin::{NewStage, PluginStaging, StagedFolder};
use eos_core::{Clock, Error, Ids};

pub struct FsPluginStaging {
    root: PathBuf,
    staging_root: PathBuf,
    trash_root: PathBuf,
    ids: Arc<dyn Ids>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FsPluginStaging {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FsPluginStaging").field("root", &self.root).finish_non_exhaustive()
    }
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |e| Error::Storage(format!("{}: {e}", path.display()))
}

/// `st-` and lower-case letters or digits: nothing that could name another folder.
fn is_staging_id(id: &str) -> bool {
    id.strip_prefix("st-")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// Files and their bytes below `dir`; links and special files are not counted.
fn measure(dir: &Path, files: &mut u64, bytes: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            measure(&entry.path(), files, bytes);
        } else if kind.is_file() {
            *files += 1;
            *bytes += entry.metadata().map_or(0, |m| m.len());
        }
    }
}

/// Moves `from` in as `target`. A plugin already at `target` goes to
/// `trash_to` first, and comes back if the move in fails: all or nothing.
fn swap_in(from: &Path, target: &Path, trash_to: &Path) -> Result<(), Error> {
    let replaced = target.exists();
    if replaced {
        move_to(target, trash_to)?;
    }
    if let Err(e) = fs::rename(from, target) {
        if replaced && let Err(back) = fs::rename(trash_to, target) {
            tracing::error!(plugin = %target.display(), kept = %trash_to.display(), error = %back,
                "a replaced plugin could not be put back; it is in the trash folder");
        }
        return Err(io(target)(e));
    }
    Ok(())
}

fn move_to(from: &Path, to: &Path) -> Result<(), Error> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(io(parent))?;
    }
    fs::rename(from, to).map_err(io(from))
}

impl FsPluginStaging {
    /// `root`: the plugins folder.
    pub fn new(root: impl Into<PathBuf>, ids: Arc<dyn Ids>, clock: Arc<dyn Clock>) -> Self {
        let root = root.into();
        Self { staging_root: root.join(".staging"), trash_root: root.join(".trash"), root, ids, clock }
    }

    fn plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, Error> {
        if plugin_id.is_empty() || plugin_id.starts_with('.') || plugin_id.contains(['/', '\\']) {
            return Err(Error::Validation(format!("not a plugin id: {plugin_id}")));
        }
        Ok(self.root.join(plugin_id))
    }

    fn must_dir(&self, id: &str) -> Result<PathBuf, Error> {
        self.dir(id).ok_or_else(|| Error::not_found("staged plugin", id))
    }

    fn trash_path(&self, plugin_id: &str) -> PathBuf {
        self.trash_root.join(format!("{plugin_id}-{}", self.clock.now_ms()))
    }
}

impl PluginStaging for FsPluginStaging {
    fn create(&self) -> Result<NewStage, Error> {
        let id = self.ids.plugin_staging_id();
        let dir = self.staging_root.join(&id);
        fs::create_dir_all(&dir).map_err(io(&dir))?;
        Ok(NewStage { id, dir })
    }

    fn dir(&self, id: &str) -> Option<PathBuf> {
        let dir = self.staging_root.join(id);
        (is_staging_id(id) && dir.exists()).then_some(dir)
    }

    fn inspect(&self, id: &str) -> Result<StagedFolder, Error> {
        let dir = self.must_dir(id)?;
        let (mut files, mut bytes) = (0, 0);
        measure(&dir, &mut files, &mut bytes);
        let mut top_files: Vec<String> = fs::read_dir(&dir)
            .map_err(io(&dir))?
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        top_files.sort_unstable();
        Ok(StagedFolder {
            manifest_text: fs::read_to_string(dir.join(PLUGIN_MANIFEST_FILE)).ok(),
            top_files,
            files,
            bytes,
        })
    }

    fn discard(&self, id: &str) {
        if let Some(dir) = self.dir(id)
            && let Err(e) = fs::remove_dir_all(&dir)
        {
            tracing::warn!(stage = id, error = %e, "a staged install could not be removed");
        }
    }

    fn clear(&self) {
        if let Err(e) = fs::remove_dir_all(&self.staging_root)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(error = %e, "staged installs could not be cleared");
        }
    }

    fn promote(&self, id: &str, plugin_id: &str) -> Result<(), Error> {
        let from = self.must_dir(id)?;
        let target = self.plugin_dir(plugin_id)?;
        swap_in(&from, &target, &self.trash_path(plugin_id))
    }

    fn trash(&self, plugin_id: &str) -> Result<(), Error> {
        move_to(&self.plugin_dir(plugin_id)?, &self.trash_path(plugin_id))
    }

    fn has(&self, plugin_id: &str) -> bool {
        // A link to a folder is not a plugin folder.
        self.plugin_dir(plugin_id).is_ok_and(|dir| fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::{FakeClock, SeqIds};

    const MANIFEST: &str = r#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;

    fn staging(root: &Path, now: i64) -> FsPluginStaging {
        FsPluginStaging::new(root, Arc::new(SeqIds::new()), Arc::new(FakeClock::at(now)))
    }

    // FsPluginStaging
    #[test]
    fn promotes_a_stage_into_the_plugins_folder_trashing_what_it_replaces() {
        let root = tempfile::tempdir().expect("a folder");
        let staging = staging(root.path(), 7);
        fs::create_dir(root.path().join("clock")).expect("a folder");
        fs::write(root.path().join("clock/plugin.json"), "old").expect("a file");
        let stage = staging.create().expect("a stage");
        assert!(stage.id.starts_with("st-") && stage.dir == root.path().join(".staging").join(&stage.id));
        fs::write(stage.dir.join("plugin.json"), MANIFEST).expect("a file");
        assert_eq!(
            staging.inspect(&stage.id).expect("inspects"),
            StagedFolder {
                manifest_text: Some(MANIFEST.to_owned()),
                top_files: vec!["plugin.json".to_owned()],
                files: 1,
                bytes: MANIFEST.len() as u64
            }
        );
        staging.promote(&stage.id, "clock").expect("promotes");
        assert_eq!(fs::read_to_string(root.path().join("clock/plugin.json")).expect("the new one"), MANIFEST);
        assert_eq!(fs::read_to_string(root.path().join(".trash/clock-7/plugin.json")).expect("the old one"), "old");
        assert_eq!(staging.dir(&stage.id), None);
    }

    #[test]
    fn trashes_a_plugin_and_clears_stages_left_from_before() {
        let root = tempfile::tempdir().expect("a folder");
        let staging = staging(root.path(), 9);
        fs::create_dir(root.path().join("notes")).expect("a folder");
        assert!(staging.has("notes"));
        staging.trash("notes").expect("trashes");
        assert!(!staging.has("notes"));
        assert!(root.path().join(".trash/notes-9").exists());
        let stage = staging.create().expect("a stage");
        staging.clear();
        assert_eq!(staging.dir(&stage.id), None);
        staging.clear();
        assert_eq!(staging.trash("../x").expect_err("refused").to_string(), "not a plugin id: ../x");
    }

    #[test]
    fn ids_that_would_name_another_folder_are_refused() {
        let root = tempfile::tempdir().expect("a folder");
        let staging = staging(root.path(), 1);
        fs::create_dir_all(root.path().join(".staging")).expect("a folder");
        fs::create_dir_all(root.path().join("clock")).expect("a folder");
        for id in ["../clock", "st-../clock", "st-", "st-AB", "", ".", "st-ab/..", "clock"] {
            assert_eq!(staging.dir(id), None, "{id:?}");
            assert!(staging.inspect(id).is_err(), "{id:?}");
            assert!(staging.promote(id, "x").is_err(), "{id:?}");
            staging.discard(id);
        }
        assert!(root.path().join("clock").exists(), "discarding a bad id removes nothing");

        let stage = staging.create().expect("a stage");
        for plugin in ["", ".trash", "..", "a/b", "a\\b", ".staging"] {
            assert!(staging.promote(&stage.id, plugin).is_err(), "{plugin:?}");
            assert!(staging.trash(plugin).is_err(), "{plugin:?}");
            assert!(!staging.has(plugin), "{plugin:?}");
        }
        assert!(stage.dir.exists(), "a refused promote leaves the stage");
    }

    #[test]
    fn a_failed_move_in_puts_the_old_plugin_back() {
        let root = tempfile::tempdir().expect("a folder");
        let target = root.path().join("clock");
        fs::create_dir(&target).expect("a folder");
        fs::write(target.join("plugin.json"), "old").expect("a file");
        let trash_to = root.path().join(".trash/clock-1");
        // The stage is gone by the time it should move in.
        let error = swap_in(&root.path().join(".staging/st-gone"), &target, &trash_to).expect_err("fails");
        assert!(matches!(error, Error::Storage(_)), "{error:?}");
        assert_eq!(fs::read_to_string(target.join("plugin.json")).expect("still there"), "old");
        assert!(!trash_to.exists(), "nothing is left in the trash");
    }

    #[test]
    fn a_stage_moves_in_whole() {
        let root = tempfile::tempdir().expect("a folder");
        let staging = staging(root.path(), 3);
        let stage = staging.create().expect("a stage");
        fs::create_dir_all(stage.dir.join("src/deep")).expect("folders");
        for i in 0..50 {
            fs::write(stage.dir.join(format!("src/deep/f{i}.js")), "x").expect("a file");
        }
        fs::write(stage.dir.join("plugin.json"), MANIFEST).expect("a file");
        staging.promote(&stage.id, "clock").expect("promotes");
        // One rename: the folder appears with everything in it, and the stage is gone.
        assert_eq!(fs::read_dir(root.path().join("clock/src/deep")).expect("the folder").count(), 50);
        assert_eq!(fs::read_dir(root.path().join(".staging")).expect("the folder").count(), 0);
        assert!(!root.path().join(".trash").exists(), "nothing was replaced");
    }

    #[test]
    fn links_are_not_counted_and_a_linked_folder_is_no_plugin() {
        let root = tempfile::tempdir().expect("a folder");
        let staging = staging(root.path(), 1);
        let stage = staging.create().expect("a stage");
        fs::write(stage.dir.join("a.js"), "12345").expect("a file");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", stage.dir.join("hosts")).expect("a link");
            std::os::unix::fs::symlink(root.path(), root.path().join("linked")).expect("a link");
            assert!(!staging.has("linked"));
        }
        let folder = staging.inspect(&stage.id).expect("inspects");
        assert_eq!((folder.files, folder.bytes), (1, 5));
    }
}
