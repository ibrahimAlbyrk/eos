//! Fills an action's argument template from what the core holds: the
//! issue's stored data and what the user typed or chose. A frame never
//! supplies a value of its own; it only names which bound action it pressed.
//!
//! A string that is one slot (`"{data.lead.url}"`) takes the value as it is,
//! so a number stays a number; a slot inside other text is written into it.
//! A slot that names nothing is `null`, or empty text inside other text.
//! A button inside a list's rows reads the row it was pressed on as
//! `item.*`: the row the core holds, picked by the index or id the press names.

use serde_json::{Map, Value};

use crate::view_check::slots;

/// What a template's slots are filled from: the issue's data (`data.*`),
/// what the user typed or chose (`state.*`) and the pressed row (`item.*`).
#[derive(Debug, Clone, Copy)]
pub struct Sources<'v> {
    pub data: &'v Value,
    pub state: &'v Value,
    pub item: &'v Value,
    /// A page's data, whose fields a page's slots name with no prefix
    /// (`{lead.url}`); null for a View.
    pub fields: &'v Value,
}

/// The template with every slot filled from `from`.
pub fn fill_args(template: &Map<String, Value>, from: Sources<'_>) -> Value {
    Value::Object(template.iter().map(|(k, v)| (k.clone(), fill(v, from))).collect())
}

/// The row of the list at `path` (`data.stories`) a press names: by its `id`
/// when the press names one, else by its index.
pub fn pressed_row<'v>(data: &'v Value, path: &str, id: Option<&str>, index: Option<u32>) -> Option<&'v Value> {
    static NONE: Value = Value::Null;
    let rows = lookup(path, Sources { data, state: &NONE, item: &NONE, fields: &NONE })?.as_array()?;
    match id {
        Some(id) => rows.iter().find(|row| match &row["id"] {
            Value::String(text) => text == id,
            Value::Number(n) => n.to_string() == id,
            _ => false,
        }),
        None => rows.get(usize::try_from(index?).ok()?),
    }
}

fn fill(value: &Value, from: Sources<'_>) -> Value {
    match value {
        Value::String(text) => fill_text(text, from),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, from)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, from))).collect()),
        other => other.clone(),
    }
}

fn lookup<'v>(slot: &str, from: Sources<'v>) -> Option<&'v Value> {
    let mut parts = slot.split('.');
    let mut at = match parts.next()? {
        "data" => from.data,
        "state" => from.state,
        "item" => from.item,
        name => from.fields.get(name)?,
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

fn fill_text(text: &str, from: Sources<'_>) -> Value {
    let whole = text.strip_prefix('{').and_then(|t| t.strip_suffix('}')).filter(|t| !t.contains(['{', '}']));
    if let Some(slot) = whole {
        return lookup(slot, from).cloned().unwrap_or(Value::Null);
    }
    if slots(text).next().is_none() {
        return Value::String(text.to_owned());
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        out.push_str(&rest[..open]);
        match lookup(&rest[open + 1..open + close], from) {
            Some(Value::String(s)) => out.push_str(s),
            Some(Value::Null) | None => {}
            Some(other) => out.push_str(&other.to_string()),
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    Value::String(out)
}
