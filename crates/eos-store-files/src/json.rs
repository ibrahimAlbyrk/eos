//! Reading and replacing one JSON file.

use std::path::Path;

use eos_core::Error;
use eos_kit_fs::{WriteOptions, atomic_write};
use serde_json::Value;

/// The file's JSON; `None` when it is missing or unreadable — a store then
/// starts empty, as today, and never fails to open.
pub(crate) fn read(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Replaces the file. A reader sees the old content or the new, never a mix.
pub(crate) fn write(path: &Path, text: &str) -> Result<(), Error> {
    atomic_write(path, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
}
