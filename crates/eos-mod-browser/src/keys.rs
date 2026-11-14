//! Key chords for the press verb: `Enter`, `Tab`, `Control+a`, `Shift+Tab` as the fields of
//! `Input.dispatchKeyEvent`. The virtual key code matters: without it keys that type
//! nothing never reach many pages' key handlers.

use crate::axtree::quoted;

/// DevTools' modifier bits.
const ALT: u8 = 1;
const CONTROL: u8 = 2;
const META: u8 = 4;
const SHIFT: u8 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub modifiers: u8,
    pub key: String,
    pub code: String,
    pub windows_virtual_key_code: u32,
    /// Empty for a key that types nothing and for a Control or Meta chord.
    pub text: String,
}

fn modifier_bit(name: &str) -> Option<u8> {
    Some(match name {
        "alt" | "option" => ALT,
        "control" | "ctrl" => CONTROL,
        "meta" | "cmd" | "command" => META,
        "shift" => SHIFT,
        _ => return None,
    })
}

/// `(key, code, key code, text)` of a key with a name.
fn named_key(name: &str) -> Option<(&'static str, &'static str, u32, &'static str)> {
    Some(match name {
        "enter" => ("Enter", "Enter", 13, "\r"),
        "tab" => ("Tab", "Tab", 9, ""),
        "escape" => ("Escape", "Escape", 27, ""),
        "backspace" => ("Backspace", "Backspace", 8, ""),
        "delete" => ("Delete", "Delete", 46, ""),
        "arrowleft" => ("ArrowLeft", "ArrowLeft", 37, ""),
        "arrowup" => ("ArrowUp", "ArrowUp", 38, ""),
        "arrowright" => ("ArrowRight", "ArrowRight", 39, ""),
        "arrowdown" => ("ArrowDown", "ArrowDown", 40, ""),
        "home" => ("Home", "Home", 36, ""),
        "end" => ("End", "End", 35, ""),
        "pageup" => ("PageUp", "PageUp", 33, ""),
        "pagedown" => ("PageDown", "PageDown", 34, ""),
        "space" => (" ", "Space", 32, " "),
        _ => return None,
    })
}

/// Reads a chord; the error is the message today's parser throws.
pub fn parse_chord(chord: &str) -> Result<KeyChord, String> {
    let parts: Vec<&str> = chord.split('+').map(eos_domain::text::js_trim).filter(|p| !p.is_empty()).collect();
    let Some((last, modifier_names)) = parts.split_last() else {
        return Err(format!("empty key chord: {}", quoted(chord)));
    };
    let mut modifiers = 0;
    for part in modifier_names {
        let Some(bit) = modifier_bit(&part.to_lowercase()) else {
            return Err(format!("unknown modifier {} in {}", quoted(part), quoted(chord)));
        };
        modifiers |= bit;
    }
    // Control and Meta chords type nothing.
    let silent = modifiers & (CONTROL | META) != 0;
    if let Some((key, code, key_code, text)) = named_key(&last.to_lowercase()) {
        let text = if silent { "" } else { text };
        return Ok(KeyChord {
            modifiers,
            key: key.to_owned(),
            code: code.to_owned(),
            windows_virtual_key_code: key_code,
            text: text.to_owned(),
        });
    }
    // One UTF-16 unit, as `last.length !== 1` asks.
    let mut units = last.encode_utf16();
    let (Some(_), None) = (units.next(), units.next()) else {
        return Err(format!("unknown key {} in {}", quoted(last), quoted(chord)));
    };
    let upper = last.to_uppercase();
    // `/[A-Z]/.test(upper)`, then `/[0-9]/.test(upper)`.
    let code = if upper.chars().any(|c| c.is_ascii_uppercase()) {
        format!("Key{upper}")
    } else if upper.chars().any(|c| c.is_ascii_digit()) {
        format!("Digit{upper}")
    } else {
        String::new()
    };
    Ok(KeyChord {
        modifiers,
        key: (*last).to_owned(),
        code,
        // `upper.charCodeAt(0)`.
        windows_virtual_key_code: upper.encode_utf16().next().map_or(0, u32::from),
        text: if silent { String::new() } else { (*last).to_owned() },
    })
}
