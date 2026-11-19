//! The JSON Schema subset a capability's actions declare their input and
//! output in, and the check a value goes through. The subset: `object` with
//! `properties` and `required`; `string` with `minLength`, `maxLength`,
//! `enum` and `format` (`uri`, `email`, `date-time`); `integer` and `number`
//! with `minimum` and `maximum`; `boolean`; `array` with `items` and
//! `maxItems`. Any node may carry `description`, and `untrusted = true` on
//! text from outside. Failures read in the words of today's tools.

use eos_contracts::{Issue, Issues};
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::text::js_re;

/// One node of a schema.
#[derive(Debug, Clone, PartialEq)]
pub struct Schema {
    pub kind: Kind,
    /// Text from outside: a model reads it as data, never as instructions.
    pub untrusted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Object { properties: IndexMap<String, Schema>, required: Vec<String> },
    String { min_length: Option<u64>, max_length: Option<u64>, one_of: Option<Vec<String>>, format: Option<Format> },
    Integer { minimum: Option<f64>, maximum: Option<f64> },
    Number { minimum: Option<f64>, maximum: Option<f64> },
    Boolean,
    Array { items: Box<Schema>, max_items: Option<u64> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    Uri,
    Email,
    DateTime,
}

/// Reads a declared schema; anything outside the subset fails it.
pub fn compile(schema: &Value) -> Result<Schema, Vec<Issue>> {
    let mut cx = Issues::default();
    match node(schema, &mut cx) {
        Some(schema) if cx.is_empty() => Ok(schema),
        _ => Err(cx.into_vec()),
    }
}

/// What [`compile`] finds wrong with a schema, at its place in `cx`.
pub(super) fn report(schema: &Value, cx: &mut Issues) {
    node(schema, cx);
}

/// `None` when the node cannot be read at all; issues of a node that can
/// still be read leave it in place, so its siblings are checked too.
fn node(schema: &Value, cx: &mut Issues) -> Option<Schema> {
    let Some(map) = schema.as_object() else {
        cx.push("A schema is a table");
        return None;
    };
    let Some(kind) = map.get("type").and_then(Value::as_str) else {
        cx.push_at("type", "Expected one of object, string, integer, number, boolean, array");
        return None;
    };
    let allowed: &[&str] = match kind {
        "object" => &["properties", "required"],
        "string" => &["minLength", "maxLength", "enum", "format"],
        "integer" | "number" => &["minimum", "maximum"],
        "boolean" => &[],
        "array" => &["items", "maxItems"],
        other => {
            cx.push_at("type", format!("{other} is outside the supported schema subset"));
            return None;
        }
    };
    for key in map.keys() {
        if !["type", "description", "untrusted"].contains(&key.as_str()) && !allowed.contains(&key.as_str()) {
            cx.push_at(key, format!("{key} is outside the supported schema subset for {kind}"));
        }
    }
    let untrusted = match map.get("untrusted") {
        None => false,
        Some(Value::Bool(untrusted)) => *untrusted,
        Some(_) => {
            cx.push_at("untrusted", "Expected boolean");
            false
        }
    };
    let kind = match kind {
        "object" => object(map, cx),
        "string" => string(map, cx),
        "integer" => Kind::Integer { minimum: number_at(map, "minimum", cx), maximum: number_at(map, "maximum", cx) },
        "number" => Kind::Number { minimum: number_at(map, "minimum", cx), maximum: number_at(map, "maximum", cx) },
        "boolean" => Kind::Boolean,
        _ => array(map, cx)?,
    };
    Some(Schema { kind, untrusted })
}

fn object(map: &Map<String, Value>, cx: &mut Issues) -> Kind {
    let mut properties = IndexMap::new();
    match map.get("properties") {
        None => {}
        Some(Value::Object(declared)) => cx.at("properties", |cx| {
            for (name, schema) in declared {
                cx.at(name, |cx| {
                    if let Some(schema) = node(schema, cx) {
                        properties.insert(name.clone(), schema);
                    }
                });
            }
        }),
        Some(_) => cx.push_at("properties", "Expected a table of schemas"),
    }
    let mut required = Vec::new();
    match map.get("required") {
        None => {}
        Some(Value::Array(names)) => cx.at("required", |cx| {
            for (i, name) in names.iter().enumerate() {
                match name.as_str() {
                    Some(name) if map.get("properties").and_then(|p| p.get(name)).is_some() => {
                        required.push(name.to_owned());
                    }
                    _ => cx.idx(i, |cx| cx.push("Names no property")),
                }
            }
        }),
        Some(_) => cx.push_at("required", "Expected a list of property names"),
    }
    Kind::Object { properties, required }
}

fn string(map: &Map<String, Value>, cx: &mut Issues) -> Kind {
    let one_of = match map.get("enum") {
        None => None,
        Some(Value::Array(values)) if !values.is_empty() && values.iter().all(Value::is_string) => {
            Some(values.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        }
        Some(_) => {
            cx.push_at("enum", "Expected a list of strings");
            None
        }
    };
    let format = match map.get("format").map(Value::as_str) {
        None => None,
        Some(Some("uri")) => Some(Format::Uri),
        Some(Some("email")) => Some(Format::Email),
        Some(Some("date-time")) => Some(Format::DateTime),
        Some(_) => {
            cx.push_at("format", "Expected uri, email or date-time");
            None
        }
    };
    Kind::String {
        min_length: count_at(map, "minLength", cx),
        max_length: count_at(map, "maxLength", cx),
        one_of,
        format,
    }
}

fn array(map: &Map<String, Value>, cx: &mut Issues) -> Option<Kind> {
    let Some(items) = map.get("items") else {
        cx.push_at("items", "An array declares the schema of its items");
        return None;
    };
    let mut compiled = None;
    cx.at("items", |cx| compiled = node(items, cx));
    Some(Kind::Array { items: Box::new(compiled?), max_items: count_at(map, "maxItems", cx) })
}

fn count_at(map: &Map<String, Value>, key: &str, cx: &mut Issues) -> Option<u64> {
    let count = map.get(key)?.as_u64();
    if count.is_none() {
        cx.push_at(key, "Expected a whole number of at least 0");
    }
    count
}

fn number_at(map: &Map<String, Value>, key: &str, cx: &mut Issues) -> Option<f64> {
    let number = map.get(key)?.as_f64();
    if number.is_none() {
        cx.push_at(key, "Expected a number");
    }
    number
}

impl Schema {
    /// Checks a value against the schema; every failure is reported, in the
    /// order of the schema's fields.
    pub fn check(&self, value: &Value, cx: &mut Issues) {
        match (&self.kind, value) {
            (Kind::Object { properties, required }, Value::Object(map)) => {
                for (name, schema) in properties {
                    cx.at(name, |cx| match map.get(name) {
                        Some(value) => schema.check(value, cx),
                        None if required.contains(name) => cx.push("Required"),
                        None => {}
                    });
                }
            }
            (Kind::String { min_length, max_length, one_of, format }, Value::String(text)) => {
                if let Some(values) = one_of.as_ref().filter(|values| !values.contains(text)) {
                    let expected: Vec<String> = values.iter().map(|value| format!("'{value}'")).collect();
                    cx.push(format!("Invalid enum value. Expected {}, received '{text}'", expected.join(" | ")));
                }
                if let Some(min) = min_length {
                    cx.str_min(text, usize::try_from(*min).unwrap_or(usize::MAX));
                }
                if let Some(max) = max_length {
                    cx.str_max(text, usize::try_from(*max).unwrap_or(usize::MAX));
                }
                match format {
                    Some(Format::Uri) => cx.url(text),
                    Some(Format::Email) => {
                        if js_re!(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").find(text).is_none() {
                            cx.push("Invalid email");
                        }
                    }
                    Some(Format::DateTime) => cx.datetime(text),
                    None => {}
                }
            }
            (Kind::Integer { minimum, maximum }, Value::Number(n)) => {
                if n.as_i64().is_none() && n.as_f64().is_some_and(|n| n.fract() != 0.0) {
                    cx.push("Expected integer, received float");
                }
                bounds(n.as_f64(), *minimum, *maximum, cx);
            }
            (Kind::Number { minimum, maximum }, Value::Number(n)) => bounds(n.as_f64(), *minimum, *maximum, cx),
            (Kind::Boolean, Value::Bool(_)) => {}
            (Kind::Array { items, max_items }, Value::Array(list)) => {
                if let Some(max) = max_items {
                    cx.arr_max(list.len(), usize::try_from(*max).unwrap_or(usize::MAX));
                }
                for (i, item) in list.iter().enumerate() {
                    cx.idx(i, |cx| items.check(item, cx));
                }
            }
            (kind, value) => cx.push(format!("Expected {}, received {}", expected(kind), received(value))),
        }
    }
}

fn bounds(n: Option<f64>, minimum: Option<f64>, maximum: Option<f64>, cx: &mut Issues) {
    let Some(n) = n.map(eos_contracts::Num) else { return };
    if let Some(min) = minimum {
        cx.num_min(n, min, true);
    }
    if let Some(max) = maximum {
        cx.num_max(n, max, true);
    }
}

fn expected(kind: &Kind) -> &'static str {
    match kind {
        Kind::Object { .. } => "object",
        Kind::String { .. } => "string",
        Kind::Integer { .. } | Kind::Number { .. } => "number",
        Kind::Boolean => "boolean",
        Kind::Array { .. } => "array",
    }
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// What a model reads when a call's input fails its action's schema:
/// `Input validation error: Invalid arguments for github.post_review: event:
/// Required; comments.0.line: Expected number, received string`. Today's
/// tools open the same way and list zod's issues as JSON; an action's input
/// has no recorded answer to match, so each issue is only its path and its
/// words, and the model reads the same words in fewer tokens.
pub fn input_error(capability: &str, action: &str, issues: &[Issue]) -> String {
    let issues: Vec<String> = issues
        .iter()
        .map(|issue| if issue.path.is_empty() { issue.message.clone() } else { issue.to_string() })
        .collect();
    format!("Input validation error: Invalid arguments for {capability}.{action}: {}", issues.join("; "))
}
