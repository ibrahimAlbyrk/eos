//! The manifest check against today's: `tests/vectors/manifests.json` holds
//! what `parsePluginManifest` and `pluginUiEntry` answered (frozen from the TypeScript, see `fixtures/README.md`).

use eos_mod_plugins::{parse_plugin_manifest, plugin_ui_entry};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    text: Option<String>,
    folder_id: Option<String>,
    files: Vec<String>,
    error: Option<String>,
    manifest: Option<Value>,
    entry: Option<String>,
}

/// Where the Rust wording differs from Zod's, by how `eos-contracts` reads a
/// union: a bad tag reads as a bad enum value (and names what it got), a
/// missing tag as a missing field, and a wrong type inside a setting names
/// the setting, not the field in it.
fn known_difference(case: &str) -> Option<&'static str> {
    match case {
        "unknown setting type" => Some(
            "plugin.json: settings.a.type — Invalid enum value. Expected 'boolean' | 'string' | 'number' | 'select', received 'color'",
        ),
        "setting without type" => Some("plugin.json: settings.a.type — Required"),
        "wrong default type" => Some("plugin.json: settings.a — Expected number, received string"),
        _ => None,
    }
}

#[test]
fn every_manifest_reads_as_it_does_today() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/manifests.json"))
        .expect("the vectors");
    let cases: Vec<Case> = serde_json::from_str(&text).expect("the vectors parse");
    assert!(cases.len() >= 33);
    let mut failures = Vec::new();
    for case in cases {
        let got = parse_plugin_manifest(case.text.as_deref(), case.folder_id.as_deref());
        match (got, &case.error) {
            (Ok(manifest), None) => {
                assert_eq!(
                    serde_json::to_value(&manifest).expect("serializes"),
                    case.manifest.clone().expect("recorded"),
                    "{}",
                    case.name
                );
                assert_eq!(plugin_ui_entry(&manifest, &case.files), case.entry, "{}: the UI entry", case.name);
            }
            (Err(error), Some(today)) => {
                let want = known_difference(&case.name).unwrap_or(today);
                if error != want {
                    failures.push(format!("{}\n  today: {today}\n  got:   {error}", case.name));
                }
            }
            (got, _) => panic!("{}: today {:?}, got {got:?}", case.name, case.error),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
