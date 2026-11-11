//! Folders of the Files panel: each watched folder's direct entries.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use eos_contracts::{FsChangeEvent, FsChangeEventChangesItem, FsChangeKind, Num};
use eos_core::Clock;
use eos_core::os::{FileWatcher, FsChangeSink, WatchLease};
use eos_domain::fs_ignore::is_ignored;

use crate::source::{Reactor, Source};

/// Changes are gathered this long from the first one, then sent as one batch.
const WINDOW: Duration = Duration::from_millis(120);

struct Watched {
    /// The folder as the caller named it: what events carry.
    dir: PathBuf,
    /// Its real path: what the system reports changes under.
    real: PathBuf,
    refs: usize,
    /// Name → is a folder, as of the last batch.
    entries: HashMap<String, bool>,
    /// Names the system reported since the last batch, in the order reported.
    touched: Vec<String>,
}

#[derive(Default)]
struct State {
    /// In the order they were first watched: the order of a batch.
    watched: Vec<Watched>,
    closed: bool,
}

struct Core {
    state: Mutex<State>,
    clock: Arc<dyn Clock>,
    sink: FsChangeSink,
}

/// The names in a folder with whether each is a folder; ignored names left
/// out. A folder that cannot be read has none.
fn list_entries(dir: &Path) -> HashMap<String, bool> {
    let Ok(entries) = fs::read_dir(dir) else { return HashMap::new() };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            (!is_ignored(&name)).then_some((name, entry.file_type().is_ok_and(|kind| kind.is_dir())))
        })
        .collect()
}

/// What happened to `name`, given what it is now (`None`: gone) and what it
/// was. The system's own event type is not trusted: an edit can arrive as a
/// rename.
fn diff_entry(entries: &mut HashMap<String, bool>, name: &str, is_dir: Option<bool>) -> Option<FsChangeKind> {
    let was_dir = entries.get(name).copied();
    let Some(is_dir) = is_dir else {
        // Came and went inside one window (an editor's temporary file): nothing to say.
        return was_dir.map(|was_dir| {
            entries.remove(name);
            if was_dir { FsChangeKind::UnlinkDir } else { FsChangeKind::Unlink }
        });
    };
    entries.insert(name.to_owned(), is_dir);
    match (was_dir == Some(is_dir), is_dir) {
        (false, true) => Some(FsChangeKind::AddDir),
        (false, false) => Some(FsChangeKind::Add),
        (true, false) => Some(FsChangeKind::Change),
        // A folder's own metadata changing is not a change of its entry.
        (true, true) => None,
    }
}

impl Core {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Reactor for Core {
    fn on_path(&self, path: &Path) -> bool {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
            return false;
        };
        if is_ignored(name) {
            return false;
        }
        let mut state = self.state();
        let mut any = false;
        for watched in state.watched.iter_mut().filter(|w| w.real == parent) {
            if !watched.touched.iter().any(|t| t == name) {
                watched.touched.push(name.to_owned());
            }
            any = true;
        }
        any
    }

    // Events were lost: every watched folder is read again and compared with
    // what was known. Additions and removals are found; edits in place are not.
    fn on_overflow(&self) -> bool {
        let dirs: Vec<PathBuf> = self.state().watched.iter().map(|w| w.dir.clone()).collect();
        let mut any = false;
        for dir in dirs {
            let now = list_entries(&dir);
            let mut state = self.state();
            let Some(watched) = state.watched.iter_mut().find(|w| w.dir == dir) else { continue };
            let changed: Vec<String> = now
                .iter()
                .filter(|(name, is_dir)| watched.entries.get(*name) != Some(is_dir))
                .map(|(name, _)| name.clone())
                .chain(watched.entries.keys().filter(|name| !now.contains_key(*name)).cloned())
                .collect();
            for name in changed {
                if !watched.touched.contains(&name) {
                    watched.touched.push(name);
                    any = true;
                }
            }
        }
        any
    }

    fn flush(&self) {
        let ts = Num::from(self.clock.now_ms());
        let touched: Vec<(PathBuf, Vec<String>)> = self
            .state()
            .watched
            .iter_mut()
            .filter(|w| !w.touched.is_empty())
            .map(|w| (w.dir.clone(), std::mem::take(&mut w.touched)))
            .collect();
        let mut changes = Vec::new();
        for (dir, names) in touched {
            for name in names {
                let path = dir.join(&name);
                // The link itself, never what it points at.
                let is_dir = fs::symlink_metadata(&path).ok().map(|meta| meta.is_dir());
                let mut state = self.state();
                let Some(watched) = state.watched.iter_mut().find(|w| w.dir == dir) else { break };
                if let Some(kind) = diff_entry(&mut watched.entries, &name, is_dir) {
                    changes.push(FsChangeEventChangesItem {
                        kind,
                        path: path.to_string_lossy().into_owned(),
                        dir: dir.to_string_lossy().into_owned(),
                        ts,
                    });
                }
            }
        }
        if !changes.is_empty() {
            (self.sink)(FsChangeEvent { changes });
        }
    }
}

struct Inner {
    core: Arc<Core>,
    /// `None` when the system watcher could not start, and after `close_all`.
    source: Mutex<Option<Source>>,
}

/// The `FileWatcher` port: shallow, ref-counted folder watches whose changes
/// arrive at the sink in batches.
pub struct DirWatcher {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for DirWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirWatcher").field("watched", &self.watched()).finish()
    }
}

impl DirWatcher {
    /// `sink` receives each batch on the watcher's own thread and must not block.
    pub fn new(clock: Arc<dyn Clock>, sink: FsChangeSink) -> Self {
        let core = Arc::new(Core { state: Mutex::new(State::default()), clock, sink });
        let source = match Source::start("eos-dir-watch", core.clone(), WINDOW) {
            Ok(source) => Some(source),
            Err(error) => {
                tracing::error!(%error, "the folder watcher could not start; the Files panel will not update live");
                None
            }
        };
        Self { inner: Arc::new(Inner { core, source: Mutex::new(source) }) }
    }

    /// How many folders hold a system watch.
    pub fn watched(&self) -> usize {
        self.inner.core.state().watched.len()
    }
}

impl Inner {
    fn source(&self) -> MutexGuard<'_, Option<Source>> {
        self.source.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn release(&self, dir: &Path) {
        // The source lock is taken first everywhere, so a watch and a release
        // of one folder cannot cross.
        let mut source = self.source();
        let mut state = self.core.state();
        let Some(at) = state.watched.iter().position(|w| w.dir == dir) else { return };
        state.watched[at].refs -= 1;
        if state.watched[at].refs > 0 {
            return;
        }
        let gone = state.watched.remove(at);
        let shared = state.watched.iter().any(|w| w.real == gone.real);
        drop(state);
        if !shared && let Some(source) = source.as_mut() {
            source.unwatch(&gone.real);
        }
    }
}

impl FileWatcher for DirWatcher {
    fn watch(&self, dir: &Path) -> WatchLease {
        let mut source = self.inner.source();
        let mut state = self.inner.core.state();
        if state.closed {
            return WatchLease::new(|| {});
        }
        if let Some(watched) = state.watched.iter_mut().find(|w| w.dir == dir) {
            watched.refs += 1;
        } else {
            // A folder that vanished before the watch started has nothing to report.
            let real = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned());
            let already = state.watched.iter().any(|w| w.real == real);
            if !already
                && let Some(source) = source.as_mut()
                && let Err(error) = source.watch(&real, false)
            {
                tracing::debug!(dir = %dir.display(), %error, "a folder could not be watched");
            }
            state.watched.push(Watched {
                dir: dir.to_owned(),
                real,
                refs: 1,
                entries: list_entries(dir),
                touched: Vec::new(),
            });
        }
        let (inner, dir): (Weak<Inner>, PathBuf) = (Arc::downgrade(&self.inner), dir.to_owned());
        WatchLease::new(move || {
            if let Some(inner) = inner.upgrade() {
                inner.release(&dir);
            }
        })
    }

    fn close_all(&self) {
        let source = self.inner.source().take();
        {
            let mut state = self.inner.core.state();
            state.closed = true;
            state.watched.clear();
        }
        // Joined outside the locks: the thread may be waiting for them.
        drop(source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(pairs: &[(&str, bool)]) -> HashMap<String, bool> {
        pairs.iter().map(|(name, is_dir)| ((*name).to_owned(), *is_dir)).collect()
    }

    #[test]
    fn an_entry_is_compared_with_what_was_known() {
        let mut entries = known(&[("a.txt", false), ("src", true)]);
        assert_eq!(diff_entry(&mut entries, "new.txt", Some(false)), Some(FsChangeKind::Add));
        assert_eq!(diff_entry(&mut entries, "lib", Some(true)), Some(FsChangeKind::AddDir));
        assert_eq!(diff_entry(&mut entries, "a.txt", Some(false)), Some(FsChangeKind::Change));
        assert_eq!(diff_entry(&mut entries, "src", Some(true)), None, "a folder's own metadata is not a change");
        assert_eq!(diff_entry(&mut entries, "a.txt", None), Some(FsChangeKind::Unlink));
        assert_eq!(diff_entry(&mut entries, "src", None), Some(FsChangeKind::UnlinkDir));
        assert_eq!(diff_entry(&mut entries, "temp~", None), None, "came and went in one window");
        // A file replaced by a folder of the same name.
        assert_eq!(diff_entry(&mut entries, "new.txt", Some(true)), Some(FsChangeKind::AddDir));
        assert_eq!(entries, known(&[("new.txt", true), ("lib", true)]));
    }
}
