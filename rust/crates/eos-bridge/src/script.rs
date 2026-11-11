//! The bridge script: what gives the dashboard the `window.eos*` surface the Electron
//! preload gave it. It goes inline into the entry document, so every global exists before
//! the dashboard boots; every call it makes is a same-origin request to `/_shell/*`.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::migrate::PAGE_MARKER_KEY;
use crate::urlspace::{CORE_BASE, RAW_BASE};

const BRIDGE_JS: &str = include_str!("bridge.js");

/// JSON with every non-ASCII character written as a `\uXXXX` escape: a script's encoding
/// follows its document, and carried-over values are not all ASCII.
pub fn ascii_json(value: &Value) -> String {
    let mut out = String::new();
    for c in value.to_string().chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    // U+2028/2029 are covered above; `<` keeps the config from ever spelling `</script`.
    out.replace('<', "\\u003c")
}

/// The script for the entry document. `seed` is the `localStorage` carry-over, if any.
pub fn entry_script(ui_token: &str, seed: Option<&BTreeMap<String, String>>) -> String {
    let cfg = json!({
        "coreUrl": CORE_BASE,
        "rawUrl": RAW_BASE,
        "uiToken": ui_token,
        "seed": seed,
        "seedMarker": PAGE_MARKER_KEY,
    });
    BRIDGE_JS.replace("__CFG__", &ascii_json(&cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_ascii_and_angle_brackets_are_escaped() {
        let text = ascii_json(&json!({ "k": "ğ😀</script>\u{2028}" }));
        assert!(text.is_ascii());
        assert!(!text.contains('<'));
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "k": "ğ😀</script>\u{2028}" }));
    }

    #[test]
    fn the_script_carries_the_config_and_no_placeholder() {
        let seed: BTreeMap<String, String> = [("cm:theme".to_string(), "dark".to_string())].into();
        let script = entry_script("tok-123", Some(&seed));
        assert!(!script.contains("__CFG__"));
        assert!(script.contains("\"uiToken\":\"tok-123\""));
        assert!(script.contains("\"seed\":{\"cm:theme\":\"dark\"}"));
        assert!(script.contains("\"coreUrl\":\"http://eos.localhost/_core\""));
        assert!(entry_script("t", None).contains("\"seed\":null"));
    }
}
