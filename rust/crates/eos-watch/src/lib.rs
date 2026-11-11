//! Watching the file system, behind the core's two watcher ports.
//!
//! - [`DirWatcher`] (`FileWatcher`): the direct entries of each watched
//!   folder, for the Files panel. Changes are gathered for 120 ms and sent as
//!   one batch of add / change / unlink events.
//! - [`RepoWatcher`] (`GitWatcher`): a working tree's git state — HEAD, the
//!   index, refs, stashes, merge state — and its files. Changes are gathered
//!   for 200 ms and sent as one event per working tree, naming what changed.
//!
//! Both sit on one system watcher each (`notify`: FSEvents on macOS, where a
//! watch costs no file descriptor per file). What the system reports goes
//! through a bounded queue to one thread per watcher. When the queue is full
//! nothing is lost silently: the watcher re-reads what it watches
//! ([`DirWatcher`]) or reports everything as changed ([`RepoWatcher`]).
//! Dropping a watcher ends its thread and its system watch.

mod dirs;
mod repos;
mod source;

pub use dirs::DirWatcher;
pub use repos::{RepoWatcher, ResolveGitDirs};
