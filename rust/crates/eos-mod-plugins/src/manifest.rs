//! Reading `plugin.json`: the manifest, or why it cannot be used.

use eos_contracts::{PLUGIN_MANIFEST_FILE, PLUGIN_UI_ENTRIES, PluginManifest};
use serde_json::Value;

/// The manifest in `text`, or the sentence that says why not. `folder_id`:
/// the folder it sits in, whose name the manifest id must match.
pub fn parse_plugin_manifest(text: Option<&str>, folder_id: Option<&str>) -> Result<PluginManifest, String> {
    let Some(text) = text else { return Err(format!("{PLUGIN_MANIFEST_FILE} is missing")) };
    let raw: Value =
        serde_json::from_str(text).map_err(|e| format!("{PLUGIN_MANIFEST_FILE} is not valid JSON: {e}"))?;
    if !raw.is_object() {
        // serde would read an array as the fields in order; a manifest is an object.
        let got = match &raw {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            _ => "array",
        };
        return Err(format!("{PLUGIN_MANIFEST_FILE}: (root) — Expected object, received {got}"));
    }
    let manifest: PluginManifest = eos_contracts::parse(&raw).map_err(|invalid| {
        let issues: Vec<String> = invalid
            .issues
            .iter()
            .map(|issue| {
                let path = if issue.path.is_empty() { "(root)".to_owned() } else { issue.path.join(".") };
                format!("{path} — {}", issue.message)
            })
            .collect();
        format!("{PLUGIN_MANIFEST_FILE}: {}", issues.join("; "))
    })?;
    if let Some(folder) = folder_id.filter(|folder| *folder != manifest.id.0) {
        return Err(format!(
            "{PLUGIN_MANIFEST_FILE}: id \"{}\" must match the folder name \"{folder}\"",
            manifest.id.0
        ));
    }
    if manifest.ui.as_deref().is_some_and(leaves_the_folder) {
        return Err(format!("{PLUGIN_MANIFEST_FILE}: ui — must be a file inside the plugin folder"));
    }
    Ok(manifest)
}

/// Whether a path, taken as relative to a folder and resolved by its text,
/// ends up outside it.
fn leaves_the_folder(path: &str) -> bool {
    let mut depth = 0usize;
    for segment in path.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => match depth.checked_sub(1) {
                Some(up) => depth = up,
                None => return true,
            },
            _ => depth += 1,
        }
    }
    false
}

/// The UI entry to build: the one the manifest names, else the first of the
/// default names among the folder's top-level `files`.
pub fn plugin_ui_entry(manifest: &PluginManifest, files: &[String]) -> Option<String> {
    if let Some(ui) = manifest.ui.as_deref().filter(|ui| !ui.is_empty()) {
        return Some(ui.to_owned());
    }
    PLUGIN_UI_ENTRIES.iter().find(|name| files.iter().any(|file| file == *name)).map(|name| (*name).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ui_entry_cannot_point_outside_the_folder() {
        let manifest = |ui: &str| format!(r#"{{"id":"clock","name":"Clock","ui":"{ui}"}}"#);
        for inside in ["ui.jsx", "src/main.tsx", "./src/../ui.jsx", "/ui.jsx", "a/b/../../c.js"] {
            assert!(parse_plugin_manifest(Some(&manifest(inside)), Some("clock")).is_ok(), "{inside}");
        }
        for outside in ["../other/ui.jsx", "src/../../x.js", "..", "a/../../../etc/passwd", "..\\\\x.js"] {
            assert_eq!(
                parse_plugin_manifest(Some(&manifest(outside)), Some("clock")),
                Err("plugin.json: ui — must be a file inside the plugin folder".to_owned()),
                "{outside}"
            );
        }
    }

    #[test]
    fn text_that_is_not_json_says_so() {
        let error = parse_plugin_manifest(Some("{nope"), Some("clock")).expect_err("not JSON");
        assert!(error.starts_with("plugin.json is not valid JSON: "), "{error}");
    }
}
