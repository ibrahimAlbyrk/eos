//! `doors.json` in the shell's data folder: what the doors outside Eos remember. Here, whether
//! the dashboard already offered to start Eos at login (`loginOffered`). Other keys in the
//! file are kept as they are.

use std::path::Path;

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

/// Whether the one-time offer to start at login was made (or the user chose already).
pub fn login_offered(data_dir: &Path) -> bool {
    read(data_dir).get("loginOffered").and_then(Value::as_bool).unwrap_or(false)
}

/// Remembers that the offer was made. Written whole through a temporary file, so a crash
/// never leaves half a file.
pub fn mark_login_offered(data_dir: &Path) -> std::io::Result<()> {
    let mut doors = read(data_dir);
    doors.insert("loginOffered".into(), Value::Bool(true));
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
    fn a_broken_file_reads_as_never_offered() {
        let dir = Dir::new("doors-broken");
        std::fs::write(dir.path().join(FILE), "{not json").unwrap();
        assert!(!login_offered(dir.path()));
        mark_login_offered(dir.path()).unwrap();
        assert!(login_offered(dir.path()));
    }
}
