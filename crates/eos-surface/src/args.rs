//! Fills an action's argument template from what the core holds: the
//! issue's stored data and what the user typed or chose. A frame never
//! supplies a value of its own; it only names which bound action it pressed.
//!
//! A string that is one slot (`"{data.lead.url}"`) takes the value as it is,
//! so a number stays a number; a slot inside other text is written into it.
//! A slot that names nothing is `null`, or empty text inside other text.

use serde_json::{Map, Value};

use crate::view_check::slots;

/// The template with every slot filled from `data` (`data.*`) and `state`
/// (`state.*`).
pub fn fill_args(template: &Map<String, Value>, data: &Value, state: &Value) -> Value {
    Value::Object(template.iter().map(|(k, v)| (k.clone(), fill(v, data, state))).collect())
}

fn fill(value: &Value, data: &Value, state: &Value) -> Value {
    match value {
        Value::String(text) => fill_text(text, data, state),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, data, state)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, data, state))).collect()),
        other => other.clone(),
    }
}

fn lookup<'v>(slot: &str, data: &'v Value, state: &'v Value) -> Option<&'v Value> {
    let mut parts = slot.split('.');
    let mut at = match parts.next()? {
        "data" => data,
        "state" => state,
        _ => return None,
    };
    for part in parts {
        at = match at {
            Value::Object(map) => map.get(part)?,
            Value::Array(items) => items.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

fn fill_text(text: &str, data: &Value, state: &Value) -> Value {
    let whole = text.strip_prefix('{').and_then(|t| t.strip_suffix('}')).filter(|t| !t.contains(['{', '}']));
    if let Some(slot) = whole {
        return lookup(slot, data, state).cloned().unwrap_or(Value::Null);
    }
    if slots(text).next().is_none() {
        return Value::String(text.to_owned());
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        out.push_str(&rest[..open]);
        match lookup(&rest[open + 1..open + close], data, state) {
            Some(Value::String(s)) => out.push_str(s),
            Some(Value::Null) | None => {}
            Some(other) => out.push_str(&other.to_string()),
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    Value::String(out)
}
