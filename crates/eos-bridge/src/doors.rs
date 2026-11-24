//! `doors.json` in the shell's data folder: what the doors outside Eos remember: whether the
//! dashboard already offered to start Eos at login (`loginOffered`) and the user's shortcut
//! for the quick panel (`shortcut`). Other keys in the file are kept as they are. [`held`] is the item a door hands the quick panel.

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

/// The shortcut that opens the quick panel (07 §4.3): the user's own, else ⌥Space.
pub const SHORTCUT: &str = "alt+space";
/// The one tried when the first is taken by another app.
pub const SHORTCUT_FALLBACK: &str = "ctrl+alt+space";

/// The accelerators to try, in order: the one the user chose (or ⌥Space), then ⌃⌥Space.
pub fn shortcut_order(data_dir: &Path) -> Vec<String> {
    let chosen = read(data_dir).get("shortcut").and_then(Value::as_str).map(str::to_owned);
    let mut order = vec![chosen.unwrap_or_else(|| SHORTCUT.to_owned())];
    if order[0] != SHORTCUT_FALLBACK {
        order.push(SHORTCUT_FALLBACK.to_owned());
    }
    order
}

/// Remembers the user's shortcut.
pub fn set_shortcut(data_dir: &Path, accelerator: &str) -> std::io::Result<()> {
    write(data_dir, "shortcut", Value::String(accelerator.to_owned()))
}

/// A shortcut the page may ask for: modifiers and one key joined by `+`, at most 64
/// characters, at least one modifier (a bare key would take typing from every app).
pub fn valid_accelerator(accelerator: &str) -> bool {
    const MODIFIERS: [&str; 7] = ["alt", "option", "ctrl", "control", "shift", "cmd", "super"];
    let parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    accelerator.len() <= 64
        && parts.len() >= 2
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
        && parts[..parts.len() - 1].iter().all(|p| MODIFIERS.contains(&p.to_ascii_lowercase().as_str()))
}

/// A shortcut as the Mac writes it: `alt+space` → `⌥Space`.
pub fn shortcut_words(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "alt" | "option" => "⌥".to_owned(),
            "ctrl" | "control" => "⌃".to_owned(),
            "shift" => "⇧".to_owned(),
            "cmd" | "super" => "⌘".to_owned(),
            key => {
                let mut chars = key.chars();
                chars.next().map_or_else(String::new, |first| first.to_ascii_uppercase().to_string() + chars.as_str())
            }
        })
        .collect()
}

/// What the user reads when the shortcut asked for does not hold: `held` is the one that does.
pub fn shortcut_problem(asked: &str, held: Option<&str>) -> Option<String> {
    match held {
        Some(held) if held == asked => None,
        Some(held) => {
            Some(format!("{} is taken by another app, so {} opens Eos.", shortcut_words(asked), shortcut_words(held)))
        }
        None => Some(format!("{} is taken by another app. Choose another.", shortcut_words(asked))),
    }
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
    fn the_shortcut_is_the_users_or_option_space_then_control_option_space() {
        let dir = Dir::new("doors-shortcut");
        assert_eq!(shortcut_order(dir.path()), [SHORTCUT, SHORTCUT_FALLBACK]);
        set_shortcut(dir.path(), "cmd+shift+k").unwrap();
        assert_eq!(shortcut_order(dir.path()), ["cmd+shift+k", SHORTCUT_FALLBACK]);
        set_shortcut(dir.path(), SHORTCUT_FALLBACK).unwrap();
        assert_eq!(shortcut_order(dir.path()), [SHORTCUT_FALLBACK]);
        mark_login_offered(dir.path()).unwrap();
        assert_eq!(shortcut_order(dir.path()), [SHORTCUT_FALLBACK], "one key never loses another");
        for good in ["alt+space", "Ctrl+Alt+Space", "cmd+shift+k"] {
            assert!(valid_accelerator(good), "{good}");
        }
        assert_eq!(shortcut_words("ctrl+alt+space"), "⌃⌥Space");
        assert_eq!(shortcut_words("cmd+shift+k"), "⌘⇧K");
        assert_eq!(shortcut_problem("alt+space", Some("alt+space")), None);
        assert_eq!(
            shortcut_problem("alt+space", Some("ctrl+alt+space")).as_deref(),
            Some("⌥Space is taken by another app, so ⌃⌥Space opens Eos.")
        );
        assert_eq!(shortcut_problem("cmd+k", None).as_deref(), Some("⌘K is taken by another app. Choose another."));
        for bad in ["space", "k", "alt+", "alt+space+x", "hyper+k", "alt+spa ce", ""] {
            assert!(!valid_accelerator(bad), "{bad}");
        }
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
