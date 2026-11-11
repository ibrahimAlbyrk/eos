//! Ports over the operating system: files, watchers, the desktop, the symbol
//! index, what the process holds (`core/src/ports/FileSystem.ts`,
//! `FileWatcher.ts`, `SymbolIndex.ts`, `infra/src/filesystem/FsHelpers.ts`, …).

mod desktop;
mod files;
mod process;
mod symbols;
mod watch;

pub use desktop::{AppInfo, DesktopFiles, Editor, OpenIn};
pub use files::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
pub use process::{LocalTime, ProcessStats};
pub use symbols::SymbolIndex;
pub use watch::{FileWatcher, FsChangeSink, WatchLease};
