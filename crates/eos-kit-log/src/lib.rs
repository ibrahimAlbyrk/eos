//! The app's log files (`ARCHITECTURE.md`, "What may be logged").
//!
//! Two files in one folder: `core.log`, every `tracing` event of the process that passes
//! the filter (`EOS_LOG`, else [`DEFAULT_FILTER`]), and `shell.log`, the window shell's
//! own lines. Both are a [`LogFile`]: a bounded queue the caller never waits on, a writer
//! thread that scrubs each line ([`Scrubber`]), rotation by size with a fixed number of
//! older files ([`Limits`]). A log that cannot be written loses lines, never the app.

mod file;
mod panic;
mod scrub;
mod time;

use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub use file::{Limits, LogFile};
pub use panic::catch_panics;
pub use scrub::Scrubber;
pub use time::utc_now;

/// Info for Eos's own crates, warnings for everything else (the agent engine's crates
/// included: below a warning they may describe a conversation).
pub const DEFAULT_FILTER: &str = "warn,eos=info,eos_agent=warn";
pub const CORE_LOG: &str = "core.log";
pub const SHELL_LOG: &str = "shell.log";

static CORE: OnceLock<LogFile> = OnceLock::new();
/// Whether events go to stderr as well (the app: yes; a test that reads the file: no).
static STDERR: AtomicBool = AtomicBool::new(true);

/// Installs the process's `tracing` subscriber: each event goes to stderr at once and to
/// `core.log` from [`attach`] on. `filter` is an `EOS_LOG` value; one that does not parse
/// falls back to the default. `false` when a subscriber was already installed.
pub fn init(filter: Option<&str>) -> bool {
    init_with(filter, true)
}

/// [`init`], with or without the copy on stderr.
pub fn init_with(filter: Option<&str>, stderr: bool) -> bool {
    STDERR.store(stderr, Ordering::Relaxed);
    let filter = tracing_subscriber::EnvFilter::try_new(filter.unwrap_or(DEFAULT_FILTER))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(DEFAULT_FILTER));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(|| Tee).with_ansi(false).try_init().is_ok()
}

/// Starts writing the core's events to `<dir>/core.log`. The first call wins.
pub fn attach(dir: &Path, scrubber: Scrubber) -> &'static LogFile {
    CORE.get_or_init(|| LogFile::open(dir, CORE_LOG, Limits::CORE, scrubber))
}

/// The core's log file, once attached.
pub fn core_file() -> Option<&'static LogFile> {
    CORE.get()
}

/// Waits up to `wait` for the core's queued lines to reach the disk.
pub fn flush(wait: Duration) -> bool {
    CORE.get().is_none_or(|file| file.flush(wait))
}

/// One formatted event: to stderr as it is, and queued for the file.
struct Tee;

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if STDERR.load(Ordering::Relaxed) {
            let _ = std::io::stderr().write_all(buf);
        }
        if let Some(file) = CORE.get() {
            file.write(buf.to_vec());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
