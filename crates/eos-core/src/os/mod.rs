//! Ports over the operating system: files, watchers, the desktop, the symbol
//! index, what the process holds.

mod awake;
mod desktop;
mod files;
mod process;
mod symbols;
mod watch;

pub use awake::{AwakeHold, KeepAwake};
pub use desktop::{AppInfo, DesktopFiles, Editor, OpenIn};
pub use files::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
pub use process::{LocalTime, ProcessStats, TimeZone};
pub use symbols::SymbolIndex;
pub use watch::{FileWatcher, FsChangeSink, WatchLease};
