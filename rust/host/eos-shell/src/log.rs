//! The shell's log: one line per event on stderr and in `<data>/logs/shell.log`.
//! Never logs a token, a URL query or page content.

use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

/// A log that grew past this is started over at launch.
const MAX_BYTES: u64 = 2 << 20;

pub(crate) fn init(data_dir: &Path) {
    START.get_or_init(Instant::now);
    let dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("shell.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = FILE.set(Mutex::new(file));
    }
}

pub(crate) fn log(tag: &str, message: &str) {
    let ms = START.get().map_or(0, |s| s.elapsed().as_millis());
    let line = format!("[{ms:>7} ms] {tag}: {message}\n");
    eprint!("{line}");
    if let Some(file) = FILE.get()
        && let Ok(mut file) = file.lock()
    {
        let _ = file.write_all(line.as_bytes());
    }
}
