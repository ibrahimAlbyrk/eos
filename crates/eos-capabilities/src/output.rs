//! An action's output as its caller gets it: every secret of the
//! capability cut out, text from outside marked as such, and no more than a
//! model should read.

use eos_domain::capability::manifest::Action;
use eos_domain::capability::schema::{Kind, Schema, compile};
use eos_domain::capability::scrub::scrub;
use eos_domain::untrusted::wrap;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

/// The most of an output a model reads, as JSON.
pub(crate) const MODEL_OUTPUT_MAX_BYTES: usize = 256 * 1024;

const CUT: &str = "… [cut at 256 KiB]";

pub(crate) fn finish(
    capability: &str,
    action: &Action,
    output: Value,
    secrets: &[Zeroizing<String>],
    for_model: bool,
) -> Value {
    let secrets: Vec<&str> = secrets.iter().map(|secret| secret.as_str()).collect();
    let mut output = scrubbed(output, &secrets);
    if let Some(schema) = action.output.as_ref().and_then(|schema| compile(schema).ok()) {
        mark(&schema, &mut output, &format!("{capability}:{}", action.name), false);
    }
    if for_model { capped(output) } else { output }
}

/// Every string in `value`, keys too, with the secrets cut out.
fn scrubbed(value: Value, secrets: &[&str]) -> Value {
    match value {
        Value::String(text) => Value::String(scrub(&text, secrets)),
        Value::Array(list) => Value::Array(list.into_iter().map(|item| scrubbed(item, secrets)).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter().map(|(key, item)| (scrub(&key, secrets), scrubbed(item, secrets))).collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

/// Wraps each string the schema marks untrusted, or that sits inside a node
/// it marks, in the untrusted block.
fn mark(schema: &Schema, value: &mut Value, source: &str, inherited: bool) {
    let untrusted = inherited || schema.untrusted;
    match (&schema.kind, value) {
        (Kind::Object { properties, .. }, Value::Object(map)) => {
            for (name, property) in properties {
                if let Some(item) = map.get_mut(name) {
                    mark(property, item, source, untrusted);
                }
            }
        }
        (Kind::Array { items, .. }, Value::Array(list)) => {
            for item in list {
                mark(items, item, source, untrusted);
            }
        }
        (Kind::String { .. }, Value::String(text)) if untrusted => *text = wrap(source, text),
        _ => {}
    }
}

/// An output too long for a model becomes the start of its JSON text.
fn capped(output: Value) -> Value {
    let text = output.to_string();
    if text.len() <= MODEL_OUTPUT_MAX_BYTES {
        return output;
    }
    let mut end = MODEL_OUTPUT_MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Value::String(format!("{}{CUT}", &text[..end]))
}

#[cfg(test)]
mod tests {
    use eos_contracts::ActionClass;
    use eos_domain::capability::manifest::Recipient;
    use serde_json::json;

    use super::*;

    fn action(output: Value) -> Action {
        Action {
            name: "get_pull_request".into(),
            summary: "Reads a pull request.".into(),
            class: ActionClass::Read,
            recipient: Recipient::None,
            undo: String::new(),
            run: Vec::new(),
            tool: None,
            timeout_s: 30,
            input: None,
            output: Some(output),
        }
    }

    #[test]
    fn untrusted_strings_are_wrapped_down_to_the_last_one_inside_a_marked_node() {
        let schema = json!({
            "type": "object",
            "properties": {
                "number": { "type": "integer" },
                "title": { "type": "string", "untrusted": true },
                "author": { "type": "string" },
                "comments": { "type": "array", "untrusted": true, "items": { "type": "object", "properties": { "body": { "type": "string" } } } }
            }
        });
        let output = json!({ "number": 7, "title": "Fix", "author": "octocat", "comments": [{ "body": "ok" }] });
        let done = finish("github", &action(schema), output, &[], true);
        assert_eq!(done["number"], 7);
        assert_eq!(done["author"], "octocat");
        assert_eq!(done["title"], wrap("github:get_pull_request", "Fix"));
        assert_eq!(done["comments"][0]["body"], wrap("github:get_pull_request", "ok"));
    }

    #[test]
    fn secrets_go_from_every_string_and_key() {
        let secret = Zeroizing::new("gho_abcdefgh1234".to_owned());
        let output = json!({ "gho_abcdefgh1234": ["token gho_abcdefgh1234"], "n": 1 });
        let done = finish("github", &action(json!({ "type": "object", "properties": {} })), output, &[secret], false);
        assert_eq!(done, json!({ "[secret]": ["token [secret]"], "n": 1 }));
    }

    #[test]
    fn a_model_reads_at_most_256_kib_of_an_output() {
        let long = json!({ "text": "é".repeat(MODEL_OUTPUT_MAX_BYTES) });
        let schema = json!({ "type": "object", "properties": {} });
        let for_model = finish("notes", &action(schema.clone()), long.clone(), &[], true);
        let text = for_model.as_str().expect("cut to text");
        assert!(text.len() <= MODEL_OUTPUT_MAX_BYTES + CUT.len());
        assert!(text.ends_with(CUT));
        assert_eq!(finish("notes", &action(schema), long.clone(), &[], false), long, "other callers get it whole");
    }
}
