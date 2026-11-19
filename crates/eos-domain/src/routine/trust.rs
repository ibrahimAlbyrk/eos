//! Whether a version and a run read outside text (01 G46): a version's
//! trust is computed when it is kept and stored with it; a run's on read
//! from what it runs from, never stored.

use eos_contracts::{ActionClass, Blueprint, RunInput, Trigger};
use serde_json::Value;

use crate::capability::manifest::Manifest;
use crate::capability::schema::compile;
use crate::run_scope::Trust;

/// A version is untrusted when a When trigger is a capability's source,
/// its Takes come from one, or a capability it needs has a read action whose
/// output marks text from outside (`reads_outside`).
pub fn of_version(blueprint: &Blueprint, reads_outside: impl Fn(&str) -> bool) -> Trust {
    let triggered = blueprint.when.on.iter().any(|trigger| matches!(trigger, Trigger::Source { .. }));
    let takes = blueprint.takes.source.is_some();
    let needs = blueprint.needs.iter().filter_map(need_id).any(reads_outside);
    if triggered || takes || needs { Trust::Untrusted } else { Trust::Trusted }
}

/// The capability a need names: its id, or an object with one.
pub fn need_id(need: &Value) -> Option<&str> {
    match need {
        Value::String(id) => Some(id),
        Value::Object(fields) => fields.get("id").and_then(Value::as_str),
        _ => None,
    }
}

/// Whether a capability brings outside text to whoever reads it: one of its
/// read actions marks part of its output untrusted.
pub fn reads_outside(manifest: &Manifest) -> bool {
    manifest.actions.iter().filter(|action| action.class == ActionClass::Read).any(|action| {
        let schema = action.output.as_ref().and_then(|output| compile(output).ok());
        schema.is_some_and(|schema| schema.marks_untrusted())
    })
}

/// A run is untrusted when its version is (or the version's trust is a word
/// this app does not know), or when any item it was given came from outside.
pub fn of_run(version: Option<Trust>, input: &RunInput) -> Trust {
    let outside = input.item.iter().chain(input.items.iter().flatten()).any(|item| item.untrusted);
    if outside || version != Some(Trust::Trusted) { Trust::Untrusted } else { Trust::Trusted }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn input(value: serde_json::Value) -> RunInput {
        let mut value = value;
        value["result"] = json!("usual");
        serde_json::from_value(value).expect("an input")
    }

    fn item(untrusted: bool) -> serde_json::Value {
        json!({"kind": "text", "untrusted": untrusted})
    }

    fn version(when: Value, takes_source: Option<&str>, needs: Value) -> Blueprint {
        let agent = json!({"key": "a", "name": "A", "lead": true, "brief": "b", "model": "sonnet",
                           "effort": "low", "tools": {}, "readsOutside": false, "workspace": "none"});
        let mut takes = json!({"kind": "folder", "label": "l", "placeholder": "p", "empty": "none", "many": false});
        if let Some(source) = takes_source {
            takes["source"] = json!(source);
        }
        serde_json::from_value(json!({
            "format": 1, "name": "n", "summary": "s", "icon": "i", "kind": "standing", "takes": takes,
            "when": when, "which": {}, "who": {"depth": "solo", "agents": [agent], "checker": {"model": "sonnet", "effort": "low"}},
            "how": {"checks": [], "format": "f", "checkAgent": false}, "makes": {"kind": "k", "description": "d"},
            "freedom": {"rung": "draft"}, "limits": {"perRunUsd": 1, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
            "needs": needs,
        }))
        .expect("a blueprint")
    }

    #[test]
    fn a_version_is_untrusted_when_a_source_or_a_needed_read_brings_outside_text() {
        let quiet = |_: &str| false;
        let folder = version(json!({"on": [{"folder": {"path": "/tmp/in", "events": ["added"]}}]}), None, json!([]));
        assert_eq!(of_version(&folder, quiet), Trust::Trusted);
        let pulls = json!({"on": [{"source": "github.pulls", "scope": {"repo": "a/b"}, "events": ["opened"]}]});
        assert_eq!(of_version(&version(pulls, None, json!([])), quiet), Trust::Untrusted, "a trigger");
        let taken = version(json!({"on": []}), Some("github.pulls"), json!([]));
        assert_eq!(of_version(&taken, quiet), Trust::Untrusted, "takes from a source");
        let needs = version(json!({"on": []}), None, json!(["mail", {"id": "github"}]));
        assert_eq!(of_version(&needs, |id| id == "github"), Trust::Untrusted, "a need named by an object");
        assert_eq!(of_version(&needs, quiet), Trust::Trusted);
    }

    #[test]
    fn a_capability_reads_outside_when_a_read_action_marks_its_output() {
        let manifest = |class: &str, output: &str| {
            crate::capability::manifest::parse(&format!(
                "id = \"x\"\nname = \"X\"\nversion = \"1\"\nsummary = \"s\"\nform = \"builtin\"\n\
                 works = \"any_mac\"\n\n[[actions]]\nname = \"get\"\nsummary = \"s\"\nclass = \"{class}\"\n\
                 output = {output}\n"
            ))
            .expect("a manifest")
        };
        let nested = r#"{ type = "array", items = { type = "object", properties = { title = { type = "string", untrusted = true } } } }"#;
        let plain = r#"{ type = "object", properties = { n = { type = "integer" } } }"#;
        assert!(reads_outside(&manifest("read", nested)));
        assert!(!reads_outside(&manifest("read", plain)));
        assert!(!reads_outside(&manifest("speak", nested)), "only what it reads counts");
    }

    #[test]
    fn a_run_is_untrusted_by_its_version_or_by_any_item_from_outside() {
        let plain = input(json!({}));
        assert_eq!(of_run(Some(Trust::Trusted), &plain), Trust::Trusted);
        assert_eq!(of_run(Some(Trust::Untrusted), &plain), Trust::Untrusted);
        assert_eq!(of_run(None, &plain), Trust::Untrusted, "an unknown word is the careful one");
        let one = input(json!({"item": item(true)}));
        assert_eq!(of_run(Some(Trust::Trusted), &one), Trust::Untrusted);
        let batch = input(json!({"items": [item(false), item(true)]}));
        assert_eq!(of_run(Some(Trust::Trusted), &batch), Trust::Untrusted);
        let inside = input(json!({"items": [item(false)]}));
        assert_eq!(of_run(Some(Trust::Trusted), &inside), Trust::Trusted);
    }
}
