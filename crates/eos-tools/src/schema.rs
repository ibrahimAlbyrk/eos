//! A tool's input: one description that gives the JSON Schema the model is
//! sent and the check its input goes through.
//!
//! Today's tools declare their input as Zod shapes; the model reads
//! `zodToJsonSchema` of them and, on a bad call, Zod's own issue list. Both
//! are reproduced here for the kinds of schema the tools use, and held to
//! vectors made by the TypeScript (`fixtures/tools`).

use serde_json::{Map, Number, Value, json};

/// One schema node.
#[derive(Debug, Clone)]
pub(crate) struct Schema {
    kind: Kind,
    description: Option<String>,
    /// Filled in when the key is absent (`.default(…)`).
    default: Option<Value>,
    /// The key may be absent (`.optional()`).
    optional: bool,
}

#[derive(Debug, Clone)]
enum Kind {
    String {
        min: Option<u64>,
        max: Option<u64>,
    },
    Number {
        int: bool,
        min: Option<Bound>,
        max: Option<f64>,
    },
    Boolean,
    Enum(&'static [&'static str]),
    Array {
        items: Box<Schema>,
        min: Option<u64>,
        max: Option<u64>,
    },
    Object(Vec<(&'static str, Schema)>),
    /// `z.record(z.any())`: any object, values as they are.
    Record,
    Union(Vec<Schema>),
}

#[derive(Debug, Clone, Copy)]
struct Bound {
    value: f64,
    inclusive: bool,
}

fn node(kind: Kind) -> Schema {
    Schema { kind, description: None, default: None, optional: false }
}

pub(crate) fn string() -> Schema {
    node(Kind::String { min: None, max: None })
}

pub(crate) fn number() -> Schema {
    node(Kind::Number { int: false, min: None, max: None })
}

pub(crate) fn int() -> Schema {
    node(Kind::Number { int: true, min: None, max: None })
}

pub(crate) fn boolean() -> Schema {
    node(Kind::Boolean)
}

pub(crate) fn one_of(values: &'static [&'static str]) -> Schema {
    node(Kind::Enum(values))
}

pub(crate) fn array(items: Schema) -> Schema {
    node(Kind::Array { items: Box::new(items), min: None, max: None })
}

pub(crate) fn object(fields: Vec<(&'static str, Schema)>) -> Schema {
    node(Kind::Object(fields))
}

pub(crate) fn record() -> Schema {
    node(Kind::Record)
}

pub(crate) fn union(options: Vec<Schema>) -> Schema {
    node(Kind::Union(options))
}

impl Schema {
    /// The least length (string, array) or value (number).
    pub(crate) fn min(mut self, least: u64) -> Self {
        match &mut self.kind {
            Kind::String { min, .. } | Kind::Array { min, .. } => *min = Some(least),
            Kind::Number { min, .. } => *min = Some(Bound { value: least as f64, inclusive: true }),
            _ => {}
        }
        self
    }

    /// The greatest length (string, array) or value (number).
    pub(crate) fn max(mut self, most: u64) -> Self {
        match &mut self.kind {
            Kind::String { max, .. } | Kind::Array { max, .. } => *max = Some(most),
            Kind::Number { max, .. } => *max = Some(most as f64),
            _ => {}
        }
        self
    }

    /// Greater than zero.
    pub(crate) fn positive(mut self) -> Self {
        if let Kind::Number { min, .. } = &mut self.kind {
            *min = Some(Bound { value: 0.0, inclusive: false });
        }
        self
    }

    pub(crate) fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    pub(crate) fn default(mut self, value: Value) -> Self {
        self.default = Some(value);
        self
    }

    pub(crate) fn describe(mut self, text: impl Into<String>) -> Self {
        self.description = Some(text.into());
        self
    }

    /// The JSON Schema of a tool's whole input (`zodToJsonSchema(z.object(shape))`).
    pub(crate) fn input_schema(&self) -> Value {
        let mut schema = self.json_schema();
        if let Some(map) = schema.as_object_mut() {
            map.insert("$schema".into(), "http://json-schema.org/draft-07/schema#".into());
        }
        schema
    }

    fn json_schema(&self) -> Value {
        let mut out = Map::new();
        match &self.kind {
            Kind::String { min, max } => {
                out.insert("type".into(), "string".into());
                if let Some(min) = min {
                    out.insert("minLength".into(), (*min).into());
                }
                if let Some(max) = max {
                    out.insert("maxLength".into(), (*max).into());
                }
            }
            Kind::Number { int, min, max } => {
                out.insert("type".into(), if *int { "integer" } else { "number" }.into());
                if let Some(min) = min {
                    let key = if min.inclusive { "minimum" } else { "exclusiveMinimum" };
                    out.insert(key.into(), js_number(min.value));
                }
                if let Some(max) = max {
                    out.insert("maximum".into(), js_number(*max));
                }
            }
            Kind::Boolean => {
                out.insert("type".into(), "boolean".into());
            }
            Kind::Enum(values) => {
                out.insert("type".into(), "string".into());
                out.insert("enum".into(), json!(values));
            }
            Kind::Array { items, min, max } => {
                out.insert("type".into(), "array".into());
                out.insert("items".into(), items.json_schema());
                if let Some(min) = min {
                    out.insert("minItems".into(), (*min).into());
                }
                if let Some(max) = max {
                    out.insert("maxItems".into(), (*max).into());
                }
            }
            Kind::Object(fields) => {
                out.insert("type".into(), "object".into());
                let properties: Map<String, Value> =
                    fields.iter().map(|(name, field)| ((*name).to_owned(), field.json_schema())).collect();
                out.insert("properties".into(), properties.into());
                let required: Vec<&str> = fields
                    .iter()
                    .filter(|(_, field)| !field.optional && field.default.is_none())
                    .map(|(name, _)| *name)
                    .collect();
                if !required.is_empty() {
                    out.insert("required".into(), json!(required));
                }
                out.insert("additionalProperties".into(), false.into());
            }
            Kind::Record => {
                out.insert("type".into(), "object".into());
                out.insert("additionalProperties".into(), json!({}));
            }
            Kind::Union(options) => {
                out.insert("anyOf".into(), options.iter().map(Schema::json_schema).collect());
            }
        }
        if let Some(default) = &self.default {
            out.insert("default".into(), default.clone());
        }
        if let Some(description) = &self.description {
            out.insert("description".into(), description.clone().into());
        }
        out.into()
    }

    /// Checks a tool's input as the tool's Zod shape does: the value the
    /// handler gets (defaults filled, unknown keys dropped, keys in the
    /// shape's order), or every issue in Zod's order and words.
    pub(crate) fn parse(&self, input: &Value) -> Result<Value, Vec<Value>> {
        let mut issues = Vec::new();
        let parsed = self.check(Some(input), &mut Vec::new(), &mut issues);
        match parsed {
            Some(value) if issues.is_empty() => Ok(value),
            _ => Err(issues),
        }
    }

    /// `None` with no issue added means "absent" (an optional key left out).
    fn check(&self, input: Option<&Value>, path: &mut Vec<Value>, issues: &mut Vec<Value>) -> Option<Value> {
        let Some(value) = input else {
            if let Some(default) = &self.default {
                return Some(default.clone());
            }
            if !self.optional {
                issues.push(self.wrong_type("undefined", path));
            }
            return None;
        };
        match &self.kind {
            Kind::String { min, max } => {
                let Value::String(text) = value else {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                };
                // Zod counts a string's length as JavaScript does.
                let length = text.encode_utf16().count() as u64;
                if let Some(min) = min.filter(|min| length < *min) {
                    issues.push(too_small(min as f64, "string", true, path));
                }
                if let Some(max) = max.filter(|max| length > *max) {
                    issues.push(too_big(max as f64, "string", path));
                }
                Some(value.clone())
            }
            Kind::Number { int, min, max } => {
                let Some(n) = value.as_f64().filter(|_| value.is_number()) else {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                };
                if *int && n.fract() != 0.0 {
                    issues.push(json!({
                        "code": "invalid_type",
                        "expected": "integer",
                        "received": "float",
                        "message": "Expected integer, received float",
                        "path": path,
                    }));
                }
                if let Some(min) = min.filter(|min| if min.inclusive { n < min.value } else { n <= min.value }) {
                    issues.push(too_small(min.value, "number", min.inclusive, path));
                }
                if let Some(max) = max.filter(|max| n > *max) {
                    issues.push(too_big(max, "number", path));
                }
                // `5.0` is the integer 5 to JavaScript.
                Some(if n.fract() == 0.0 && value.as_i64().is_none() && n.abs() < 9e15 {
                    Value::Number(Number::from(n as i64))
                } else {
                    value.clone()
                })
            }
            Kind::Boolean => {
                if !value.is_boolean() {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                }
                Some(value.clone())
            }
            Kind::Enum(values) => {
                let Value::String(text) = value else {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                };
                if !values.contains(&text.as_str()) {
                    issues.push(json!({
                        "received": text,
                        "code": "invalid_enum_value",
                        "options": values,
                        "path": path,
                        "message": format!("Invalid enum value. Expected {}, received '{text}'", quoted(values)),
                    }));
                    return None;
                }
                Some(value.clone())
            }
            Kind::Array { items, min, max } => {
                let Value::Array(list) = value else {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                };
                let length = list.len() as u64;
                if let Some(min) = min.filter(|min| length < *min) {
                    issues.push(too_small(min as f64, "array", true, path));
                }
                if let Some(max) = max.filter(|max| length > *max) {
                    issues.push(too_big(max as f64, "array", path));
                }
                let mut out = Vec::with_capacity(list.len());
                for (index, item) in list.iter().enumerate() {
                    path.push(index.into());
                    if let Some(parsed) = items.check(Some(item), path, issues) {
                        out.push(parsed);
                    }
                    path.pop();
                }
                Some(Value::Array(out))
            }
            Kind::Object(fields) => {
                let Value::Object(map) = value else {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                };
                let mut out = Map::new();
                for (name, field) in fields {
                    path.push((*name).into());
                    if let Some(parsed) = field.check(map.get(*name), path, issues) {
                        out.insert((*name).to_owned(), parsed);
                    }
                    path.pop();
                }
                Some(Value::Object(out))
            }
            Kind::Record => {
                if !value.is_object() {
                    issues.push(self.wrong_type(type_name(value), path));
                    return None;
                }
                Some(value.clone())
            }
            Kind::Union(options) => {
                let mut errors = Vec::with_capacity(options.len());
                for option in options {
                    let mut own = Vec::new();
                    match option.check(Some(value), path, &mut own) {
                        Some(parsed) if own.is_empty() => return Some(parsed),
                        _ => errors.push(json!({"issues": own, "name": "ZodError"})),
                    }
                }
                issues.push(json!({
                    "code": "invalid_union",
                    "unionErrors": errors,
                    "path": path,
                    "message": "Invalid input",
                }));
                None
            }
        }
    }

    fn wrong_type(&self, received: &str, path: &[Value]) -> Value {
        let message = |expected: &str| {
            if received == "undefined" {
                "Required".to_owned()
            } else {
                format!("Expected {expected}, received {received}")
            }
        };
        let expected = match &self.kind {
            Kind::String { .. } => "string",
            Kind::Number { .. } => "number",
            Kind::Boolean => "boolean",
            Kind::Array { .. } => "array",
            Kind::Object(_) | Kind::Record => "object",
            // An absent union is refused by each of its options in turn.
            Kind::Union(_) => "undefined",
            Kind::Enum(values) => {
                let expected = quoted(values);
                return json!({
                    "expected": expected,
                    "received": received,
                    "code": "invalid_type",
                    "path": path,
                    "message": message(&expected),
                });
            }
        };
        json!({
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": message(expected),
        })
    }
}

/// The message of a `ZodError`: its issues as indented JSON.
pub(crate) fn issues_text(issues: &[Value]) -> String {
    serde_json::to_string_pretty(issues).unwrap_or_else(|_| "[]".to_owned())
}

/// `'a' | 'b'`.
fn quoted(values: &[&str]) -> String {
    values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>().join(" | ")
}

/// A number as JSON writes a JavaScript number: no `.0` on a whole one.
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        Value::Number(Number::from(n as i64))
    } else {
        Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn size_words(kind: &str, least: bool, inclusive: bool, n: &Value) -> String {
    match (kind, least) {
        ("string", true) => format!("String must contain at least {n} character(s)"),
        ("string", false) => format!("String must contain at most {n} character(s)"),
        ("array", true) => format!("Array must contain at least {n} element(s)"),
        ("array", false) => format!("Array must contain at most {n} element(s)"),
        (_, true) if inclusive => format!("Number must be greater than or equal to {n}"),
        (_, true) => format!("Number must be greater than {n}"),
        (_, false) => format!("Number must be less than or equal to {n}"),
    }
}

fn too_small(minimum: f64, kind: &str, inclusive: bool, path: &[Value]) -> Value {
    let minimum = js_number(minimum);
    json!({
        "code": "too_small",
        "minimum": minimum,
        "type": kind,
        "inclusive": inclusive,
        "exact": false,
        "message": size_words(kind, true, inclusive, &minimum),
        "path": path,
    })
}

fn too_big(maximum: f64, kind: &str, path: &[Value]) -> Value {
    let maximum = js_number(maximum);
    json!({
        "code": "too_big",
        "maximum": maximum,
        "type": kind,
        "inclusive": true,
        "exact": false,
        "message": size_words(kind, false, true, &maximum),
        "path": path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_defaults_drops_unknown_keys_and_keeps_the_shapes_order() {
        let shape = object(vec![
            ("id", string()),
            ("n", int().min(1).max(50).default(json!(5))),
            ("note", string().optional()),
        ]);
        let parsed = shape.parse(&json!({"zz": 1, "note": "x", "id": "w-1"})).expect("valid");
        assert_eq!(parsed.to_string(), r#"{"id":"w-1","n":5,"note":"x"}"#);
        assert_eq!(shape.parse(&json!({"id": "w", "n": 2.0})).expect("valid")["n"], json!(2));
    }

    #[test]
    fn an_absent_optional_key_is_no_issue_and_null_is_not_absent() {
        let shape = object(vec![("a", string().optional()), ("b", boolean().default(json!(false)))]);
        assert_eq!(shape.parse(&json!({})).expect("valid"), json!({"b": false}));
        let issues = shape.parse(&json!({"a": null})).expect_err("null is a value");
        assert_eq!(issues[0]["message"], "Expected string, received null");
    }
}
