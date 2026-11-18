//! Ports over the operating system: files, watchers, the desktop, the symbol
//! index, what the process holds, staying awake, power, the Dock icon.

mod awake;
mod desktop;
mod dock;
mod files;
mod power;
mod process;
mod symbols;
mod watch;

pub use awake::{AwakeHold, HoldReason, KeepAwake, WorkHold};
pub use desktop::{AppInfo, DesktopFiles, Editor, OpenIn};
pub use dock::DockBadge;
pub use files::{FileRead, FileSystem, FsEntryMeta, FsStat, ListDirOptions, OpenFile};
pub use power::{Power, PowerStatus};
pub use process::{LocalTime, ProcessStats, TimeZone, ZoneRules};
pub use symbols::SymbolIndex;
pub use watch::{FileWatcher, FsChangeSink, WatchLease};
