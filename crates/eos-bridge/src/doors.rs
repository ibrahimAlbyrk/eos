//! `doors.json` in the shell's data folder: what the doors outside Eos remember. Here, whether
//! the dashboard already offered to start Eos at login (`loginOffered`). Other keys in the
//! file are kept as they are. [`held`] is the item a door hands the quick panel.

mod held;

use std::path::Path;

pub use held::{DoorItem, DoorPart, DoorSource, Held, MAX_PARTS, MAX_TEXT};

use serde_json::{Map, Value};

const FILE: &str = "doors.json";

fn read(data_dir: &Path) -> Map<String, Value> {
    std::fs::read_to_string(data_dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// The quick panel's size the page asks for, kept within what fits the top third of a
/// small screen: 360–720 points wide, 64–560 high. `None` for a size that is not a number.
pub fn panel_size(width: f64, height: f64) -> Option<(f64, f64)> {
    (width.is_finite() && height.is_finite()).then(|| (width.clamp(360.0, 720.0), height.clamp(64.0, 560.0)))
}

/// Whether the one-time offer to start at login was made (or the user chose already).
pub fn login_offered(data_dir: &Path) -> bool {
    read(data_dir).get("loginOffered").and_then(Value::as_bool).unwrap_or(false)
}

/// Remembers that the offer was made.
pub fn mark_login_offered(data_dir: &Path) -> std::io::Result<()> {
    write(data_dir, "loginOffered", Value::Bool(true))
}

/// Sets one key, keeping the others. Written whole through a temporary file, so a crash
/// never leaves half a file.
fn write(data_dir: &Path, key: &str, value: Value) -> std::io::Result<()> {
    let mut doors = read(data_dir);
    doors.insert(key.into(), value);
    std::fs::create_dir_all(data_dir)?;
    let partial = data_dir.join(format!("{FILE}.partial"));
    std::fs::write(&partial, Value::Object(doors).to_string())?;
    std::fs::rename(partial, data_dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    #[test]
    fn the_offer_is_remembered_beside_the_other_doors() {
        let dir = Dir::new("doors");
        let data = dir.path().join("shell");
        assert!(!login_offered(&data), "no file yet");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(FILE), r#"{"shortcut":"alt+space"}"#).unwrap();
        assert!(!login_offered(&data));
        mark_login_offered(&data).unwrap();
        assert!(login_offered(&data));
        let kept: Value = serde_json::from_str(&std::fs::read_to_string(data.join(FILE)).unwrap()).unwrap();
        assert_eq!(kept["shortcut"], "alt+space", "other doors are kept");
    }

    #[test]
    fn the_panel_keeps_to_a_size_that_fits() {
        assert_eq!(panel_size(560.0, 120.0), Some((560.0, 120.0)));
        assert_eq!(panel_size(5000.0, 1.0), Some((720.0, 64.0)));
        assert_eq!(panel_size(f64::NAN, 100.0), None);
    }

    #[test]
    fn a_broken_file_reads_as_never_offered() {
        let dir = Dir::new("doors-broken");
        std::fs::write(dir.path().join(FILE), "{not json").unwrap();
        assert!(!login_offered(dir.path()));
        mark_login_offered(dir.path()).unwrap();
        assert!(login_offered(dir.path()));
    }
}
