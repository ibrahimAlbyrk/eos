//! Plugin folders on disk: one per plugin under `root`, watched recursively so
//! any edit inside a folder reports that plugin's id.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use eos_contracts::PLUGIN_MANIFEST_FILE;
use eos_core::Error;
use eos_core::plugin::{OnPluginChange, PluginFolder, PluginWorkspace, WatchGuard};
use notify::{EventKind, RecursiveMode, Watcher};

/// Never part of a plugin's own source; watching them would only add noise.
const IGNORED_NAMES: [&str; 3] = ["node_modules", ".git", "dist"];
/// How far below a plugin folder a change is still noticed.
const WATCH_DEPTH: usize = 6;
/// For this long after a watch begins the system may still deliver changes
/// made just before it; those are told apart by their time and dropped.
const HISTORY_WINDOW: Duration = Duration::from_secs(3);

#[derive(Debug)]
pub struct FsPluginWorkspace {
    root: PathBuf,
}

impl FsPluginWorkspace {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

/// The plugin a changed path belongs to: its first segment below the root,
/// unless the path is one the watch leaves out (a dot-file or dot-folder,
/// `node_modules`, `dist`, deeper than the watch goes).
fn changed_plugin(relative: &Path) -> Option<&str> {
    let mut segments = Vec::new();
    for part in relative.components() {
        segments.push(part.as_os_str().to_str()?);
    }
    let watched = !segments.is_empty()
        && segments.len() <= WATCH_DEPTH + 1
        && segments.iter().all(|name| !name.starts_with('.') && !IGNORED_NAMES.contains(name));
    watched.then(|| segments[0])
}

/// Whether what happened to `path` happened before `began`: it is still
/// there, and neither it nor the folder holding it (which a create, a move
/// or a delete touches) was modified since. A path that is gone is news.
fn predates(path: &Path, began: SystemTime) -> bool {
    let untouched =
        |path: &Path| fs::symlink_metadata(path).and_then(|meta| meta.modified()).is_ok_and(|at| at < began);
    untouched(path) && path.parent().is_none_or(untouched)
}

fn top_level_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| entries.flatten().filter_map(|entry| entry.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    names.sort_unstable();
    names
}

impl PluginWorkspace for FsPluginWorkspace {
    fn root(&self) -> &Path {
        &self.root
    }

    fn list(&self) -> Vec<PluginFolder> {
        let Ok(entries) = fs::read_dir(&self.root) else { return Vec::new() };
        let mut ids: Vec<String> = entries
            .flatten()
            // A real folder, not a link to one.
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.'))
            .collect();
        ids.sort_unstable();
        ids.iter().filter_map(|id| self.read(id)).collect()
    }

    fn read(&self, id: &str) -> Option<PluginFolder> {
        if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
            return None;
        }
        let dir = self.root.join(id);
        if !fs::metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            return None;
        }
        Some(PluginFolder {
            id: id.to_owned(),
            manifest_text: fs::read_to_string(dir.join(PLUGIN_MANIFEST_FILE)).ok(),
            files: top_level_names(&dir),
            dir,
        })
    }

    fn watch(&self, on_change: OnPluginChange) -> Result<WatchGuard, Error> {
        fs::create_dir_all(&self.root).map_err(Error::storage)?;
        // The watcher reports real paths; a root reached through a link would never match them.
        let root = fs::canonicalize(&self.root).map_err(Error::storage)?;
        let watched = root.clone();
        let began = (Instant::now(), SystemTime::now());
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let settling = began.0.elapsed() < HISTORY_WINDOW;
            let mut told: Vec<&str> = Vec::new();
            for path in event.paths.iter().filter(|path| !(settling && predates(path, began.1))) {
                let plugin = path.strip_prefix(&watched).ok().and_then(changed_plugin);
                if let Some(id) = plugin.filter(|id| !told.contains(id)) {
                    told.push(id);
                    on_change(id);
                }
            }
        })
        .map_err(Error::storage)?;
        watcher.watch(&root, RecursiveMode::Recursive).map_err(Error::storage)?;
        Ok(Box::new(watcher))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn lists_plugin_folders_and_reads_one() {
        let root = tempfile::tempdir().expect("a folder");
        let workspace = FsPluginWorkspace::new(root.path());
        assert!(workspace.list().is_empty());
        assert!(FsPluginWorkspace::new(root.path().join("missing")).list().is_empty());

        fs::create_dir_all(root.path().join("clock/src")).expect("folders");
        fs::write(root.path().join("clock/plugin.json"), r#"{"id":"clock","name":"Clock"}"#).expect("a file");
        fs::write(root.path().join("clock/ui.jsx"), "").expect("a file");
        fs::create_dir_all(root.path().join("bare")).expect("a folder");
        fs::create_dir_all(root.path().join(".staging/st-1")).expect("a folder");
        fs::write(root.path().join("stray.txt"), "").expect("a file");

        let folders = workspace.list();
        assert_eq!(folders.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["bare", "clock"]);
        assert_eq!(folders[0].manifest_text, None);
        assert_eq!(
            folders[1],
            PluginFolder {
                id: "clock".into(),
                dir: root.path().join("clock"),
                manifest_text: Some(r#"{"id":"clock","name":"Clock"}"#.into()),
                files: vec!["plugin.json".into(), "src".into(), "ui.jsx".into()],
            }
        );
        for id in ["", ".staging", "../clock", "clock/src", "stray.txt", "nope"] {
            assert_eq!(workspace.read(id), None, "{id:?}");
        }
    }

    #[test]
    fn a_changed_path_names_its_plugin_unless_it_is_noise() {
        fn plugin(path: &str) -> Option<&str> {
            changed_plugin(Path::new(path))
        }
        assert_eq!(plugin("clock/ui.jsx"), Some("clock"));
        assert_eq!(plugin("clock"), Some("clock"));
        assert_eq!(plugin("clock/a/b/c/d/e/f.js"), Some("clock"));
        assert_eq!(plugin("clock/a/b/c/d/e/f/g.js"), None, "deeper than the watch goes");
        assert_eq!(plugin(""), None, "the root itself");
        for noise in [
            ".staging/st-1/ui.jsx",
            ".trash/clock-1",
            "clock/node_modules/x/index.js",
            "clock/.git/HEAD",
            "clock/dist/out.js",
            "clock/.ui.jsx.swp",
            "clock/src/.cache/x",
        ] {
            assert_eq!(plugin(noise), None, "{noise}");
        }
    }

    #[test]
    fn what_happened_before_the_watch_began_is_not_news() {
        let root = tempfile::tempdir().expect("a folder");
        let dir = root.path().join("clock");
        fs::create_dir(&dir).expect("a folder");
        fs::write(dir.join("ui.jsx"), "old").expect("a file");
        fs::write(root.path().join("moved.jsx"), "old").expect("a file");
        let before = SystemTime::now() - Duration::from_secs(60);
        for old in [dir.join("ui.jsx"), root.path().join("moved.jsx"), dir.clone()] {
            fs::File::open(&old).expect("opens").set_modified(before).expect("sets the time");
        }
        let began = SystemTime::now() - Duration::from_secs(30);
        assert!(predates(&dir.join("ui.jsx"), began), "written before, in a folder untouched since");

        // An edit, a file that is gone, and an old file moved in are all news.
        assert!(!predates(&dir.join("gone.jsx"), began));
        fs::rename(root.path().join("moved.jsx"), dir.join("moved.jsx")).expect("moves");
        assert!(!predates(&dir.join("moved.jsx"), began), "its own time is old, its folder's is not");
        fs::File::open(&dir).expect("opens").set_modified(before).expect("sets the time");
        fs::write(dir.join("ui.jsx"), "new").expect("a file");
        assert!(!predates(&dir.join("ui.jsx"), began));
    }

    #[test]
    fn an_edit_inside_a_folder_reports_that_plugin() {
        let root = tempfile::tempdir().expect("a folder");
        fs::create_dir_all(root.path().join("plugins/clock")).expect("folders");
        let workspace = FsPluginWorkspace::new(root.path().join("plugins"));
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let guard = workspace
            .watch(Arc::new(move |id: &str| {
                let _ = tx.lock().expect("the sender").send(id.to_owned());
            }))
            .expect("watches");

        let wait_for = |want: &str| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(id) if id == want => return,
                    Ok(_) => {}
                    Err(_) => panic!("no change reported for {want}"),
                }
            }
        };
        fs::write(root.path().join("plugins/clock/ui.jsx"), "export default 1").expect("a file");
        wait_for("clock");
        fs::create_dir_all(root.path().join("plugins/notes")).expect("a folder");
        fs::write(root.path().join("plugins/notes/plugin.json"), "{}").expect("a file");
        wait_for("notes");
        fs::remove_dir_all(root.path().join("plugins/clock")).expect("removed");
        wait_for("clock");

        // After the watch is dropped nothing more arrives.
        drop(guard);
        while rx.try_recv().is_ok() {}
        fs::write(root.path().join("plugins/notes/ui.jsx"), "x").expect("a file");
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }
}
