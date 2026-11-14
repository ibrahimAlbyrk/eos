//! The shell's log: one line per event on stderr and in `<logs>/shell.log`, a rotated,
//! bounded file written off the calling thread (`eos_kit_log`). Never logs a token, a
//! URL's query or a page's content; a host, not an address.

use std::path::Path;
use std::sync::OnceLock;

use eos_kit_log::{Limits, LogFile, Scrubber};

static FILE: OnceLock<LogFile> = OnceLock::new();

/// Opens the app's logs in `dir`: the shell's own and the core's (`core.log`, which the
/// process's `tracing` events reach from now on). Called once this process is the running
/// app, never for a `--status` or a launch that hands over.
pub(crate) fn init(dir: Option<&Path>) {
    let Some(dir) = dir else { return };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let scrubber = Scrubber::new(home.as_deref());
    eos_kit_log::attach(dir, scrubber.clone());
    let _ = FILE.set(LogFile::open(dir, eos_kit_log::SHELL_LOG, Limits::SHELL, scrubber));
}

pub(crate) fn log(tag: &str, message: &str) {
    let line = format!("{} {tag}: {message}\n", eos_kit_log::utc_now());
    eprint!("{line}");
    if let Some(file) = FILE.get() {
        file.write(line.into_bytes());
    }
}

/// Lines of the shell's log dropped because its writer could not keep up.
pub(crate) fn dropped() -> u64 {
    FILE.get().map_or(0, LogFile::dropped)
}

/// Lets what was logged reach the disk before the process ends.
pub(crate) fn flush() {
    let wait = std::time::Duration::from_millis(500);
    if let Some(file) = FILE.get() {
        file.flush(wait);
    }
    eos_kit_log::flush(wait);
}
