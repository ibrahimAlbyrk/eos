//! The type language a surface's data, an action's arguments and a query's
//! arguments are written in, and how it is read from its JSON form:
//!
//! ```json
//! {"type": "object", "fields": {
//!   "title": {"type": "text", "max": 120},
//!   "stories": {"type": "list", "min": 1, "max": 12, "of": {"type": "object", "fields": {
//!     "url": {"type": "url"},
//!     "image": {"type": "image", "required": false}}}}}}
//! ```
//!
//! Every field is required unless it says `"required": false`, and the user may
//! edit it in place only when it says `"edit": true`.

use serde_json::{Map, Value, json};

use crate::problem::{Problem, field_path};

/// How deep objects and lists may nest. A page with more levels is no longer a
/// page anyone reads; the bound also keeps every walk over a type shallow.
pub const MAX_DEPTH: usize = 6;

/// Names the renderer gives its own meaning at the top of a page's data.
const RESERVED_TOP: &[&str] = &["issue", "query", "item"];

#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    /// One line of plain text.
    Text {
        max: usize,
    },
    /// Paragraphs split on blank lines; no markdown.
    LongText {
        max: usize,
    },
    Number,
    Int,
    Bool,
    /// `YYYY-MM-DD`.
    Date,
    /// RFC 3339 with an offset: `2026-11-24T07:00:00Z`.
    DateTime,
    /// http or https only.
    Url,
    /// `{"src": <url>, "alt": <text>, "credit"?: <text>}`.
    Image,
    Enum {
        values: Vec<String>,
    },
    Object {
        fields: Vec<Field>,
    },
    List {
        of: Box<Type>,
        min: usize,
        max: usize,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    pub ty: Type,
    pub required: bool,
    pub edit: bool,
}

impl Field {
    pub fn required(name: &str, ty: Type) -> Self {
        Field { name: name.to_owned(), ty, required: true, edit: false }
    }

    pub fn optional(name: &str, ty: Type) -> Self {
        Field { name: name.to_owned(), ty, required: false, edit: false }
    }
}

/// A page's data contract: always an object at the top, whose fields are the
/// page's top-level names.
#[derive(Debug, Clone, PartialEq)]
pub struct Contract {
    pub fields: Vec<Field>,
}

impl Contract {
    /// Reads a contract and reports every problem in it, with its path.
    pub fn parse(json: &Value) -> Result<Contract, Vec<Problem>> {
        let mut problems = Vec::new();
        let ty = parse_type(json, "", 0, &mut problems);
        let fields = match ty {
            Some(Type::Object { fields }) => fields,
            Some(_) => {
                problems.push(Problem::new("type", "must be object at the top of a contract"));
                Vec::new()
            }
            None => Vec::new(),
        };
        for field in fields.iter().filter(|f| RESERVED_TOP.contains(&f.name.as_str())) {
            problems.push(Problem::new(format!("fields.{}", field.name), "is a name Eos fills itself"));
        }
        if problems.is_empty() { Ok(Contract { fields }) } else { Err(problems) }
    }

    pub fn as_type(&self) -> Type {
        Type::Object { fields: self.fields.clone() }
    }

    pub fn to_json(&self) -> Value {
        self.as_type().to_json()
    }
}

impl Type {
    /// Reads one type, for an action's or a query's arguments.
    pub fn parse(json: &Value) -> Result<Type, Vec<Problem>> {
        let mut problems = Vec::new();
        match parse_type(json, "", 0, &mut problems) {
            Some(ty) if problems.is_empty() => Ok(ty),
            _ => Err(problems),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Type::Text { .. } => "text",
            Type::LongText { .. } => "longtext",
            Type::Number => "number",
            Type::Int => "int",
            Type::Bool => "bool",
            Type::Date => "date",
            Type::DateTime => "datetime",
            Type::Url => "url",
            Type::Image => "image",
            Type::Enum { .. } => "enum",
            Type::Object { .. } => "object",
            Type::List { .. } => "list",
        }
    }

    /// The JSON form [`Type::parse`] reads back to the same type.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("type".into(), json!(self.name()));
        match self {
            Type::Text { max } | Type::LongText { max } => {
                out.insert("max".into(), json!(max));
            }
            Type::Enum { values } => {
                out.insert("values".into(), json!(values));
            }
            Type::Object { fields } => {
                let mut map = Map::new();
                for field in fields {
                    let mut spec = field.ty.to_json();
                    if let Value::Object(spec) = &mut spec {
                        if !field.required {
                            spec.insert("required".into(), json!(false));
                        }
                        if field.edit {
                            spec.insert("edit".into(), json!(true));
                        }
                    }
                    map.insert(field.name.clone(), spec);
                }
                out.insert("fields".into(), Value::Object(map));
            }
            Type::List { of, min, max } => {
                out.insert("of".into(), of.to_json());
                out.insert("min".into(), json!(min));
                out.insert("max".into(), json!(max));
            }
            _ => {}
        }
        Value::Object(out)
    }
}

/// The keys each type may carry besides `type`; `required` and `edit` belong
/// to the field the type sits in.
fn allowed_keys(name: &str) -> &'static [&'static str] {
    match name {
        "text" | "longtext" => &["max"],
        "enum" => &["values"],
        "object" => &["fields"],
        "list" => &["of", "min", "max"],
        _ => &[],
    }
}

const FIELD_KEYS: &[&str] = &["required", "edit"];

fn parse_type(json: &Value, path: &str, depth: usize, problems: &mut Vec<Problem>) -> Option<Type> {
    let at = |key: &str| field_path(path, key);
    let Value::Object(spec) = json else {
        problems.push(Problem::new(path, "must be an object with a type"));
        return None;
    };
    let Some(name) = spec.get("type").and_then(Value::as_str) else {
        problems.push(Problem::new(
            at("type"),
            "is required: text, longtext, number, int, bool, date, datetime, url, image, enum, object or list",
        ));
        return None;
    };
    for key in spec.keys() {
        let known = key == "type" || allowed_keys(name).contains(&key.as_str()) || FIELD_KEYS.contains(&key.as_str());
        if !known {
            problems.push(Problem::new(at(key), format!("is not a key of a {name} type")));
        }
    }
    let count = |key: &str, problems: &mut Vec<Problem>| -> Option<usize> {
        let found = spec.get(key)?;
        let n = found.as_u64().and_then(|n| usize::try_from(n).ok());
        if n.is_none() {
            problems.push(Problem::new(at(key), "must be a whole number, 0 or more"));
        }
        n
    };
    let ty = match name {
        "text" | "longtext" => {
            let max = count("max", problems).filter(|m| *m > 0);
            let Some(max) = max else {
                problems.push(Problem::new(at("max"), "is required: the most characters, at least 1"));
                return None;
            };
            if name == "text" { Type::Text { max } } else { Type::LongText { max } }
        }
        "number" => Type::Number,
        "int" => Type::Int,
        "bool" => Type::Bool,
        "date" => Type::Date,
        "datetime" => Type::DateTime,
        "url" => Type::Url,
        "image" => Type::Image,
        "enum" => {
            let values: Option<Vec<String>> = spec
                .get("values")
                .and_then(Value::as_array)
                .and_then(|v| v.iter().map(|s| s.as_str().map(str::to_owned)).collect());
            match values {
                Some(values) if !values.is_empty() && !has_duplicate(&values) => Type::Enum { values },
                _ => {
                    problems.push(Problem::new(at("values"), "must be a list of different texts, at least one"));
                    return None;
                }
            }
        }
        "object" | "list" if depth >= MAX_DEPTH => {
            problems.push(Problem::new(path, format!("nests deeper than {MAX_DEPTH} levels")));
            return None;
        }
        "object" => {
            let Some(Value::Object(map)) = spec.get("fields") else {
                problems.push(Problem::new(at("fields"), "is required: an object of named fields"));
                return None;
            };
            let fields_path = at("fields");
            let mut fields = Vec::new();
            for (field_name, field_spec) in map {
                let here = field_path(&fields_path, field_name);
                if !is_field_name(field_name) {
                    problems.push(Problem::new(&here, "must start with a letter and hold only letters, digits and _"));
                    continue;
                }
                if let Some(field) = parse_field(field_name, field_spec, &here, depth + 1, problems) {
                    fields.push(field);
                }
            }
            Type::Object { fields }
        }
        "list" => {
            let Some(of_spec) = spec.get("of") else {
                problems.push(Problem::new(at("of"), "is required: the type of each item"));
                return None;
            };
            let of = parse_type(of_spec, &at("of"), depth + 1, problems)?;
            let min = count("min", problems).unwrap_or(0);
            let Some(max) = count("max", problems).filter(|m| *m > 0) else {
                problems.push(Problem::new(at("max"), "is required: the most items, at least 1"));
                return None;
            };
            if min > max {
                problems.push(Problem::new(at("min"), format!("is {min}, more than max {max}")));
                return None;
            }
            Type::List { of: Box::new(of), min, max }
        }
        other => {
            problems.push(Problem::new(at("type"), format!("{other} is not a type")));
            return None;
        }
    };
    Some(ty)
}

fn parse_field(name: &str, spec: &Value, path: &str, depth: usize, problems: &mut Vec<Problem>) -> Option<Field> {
    let flag = |key: &str, default: bool, problems: &mut Vec<Problem>| match spec.get(key) {
        None => default,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            problems.push(Problem::new(field_path(path, key), "must be true or false"));
            default
        }
    };
    let required = flag("required", true, problems);
    let edit = flag("edit", false, problems);
    let ty = parse_type(spec, path, depth, problems)?;
    Some(Field { name: name.to_owned(), ty, required, edit })
}

fn is_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn has_duplicate(values: &[String]) -> bool {
    values.iter().enumerate().any(|(i, v)| values[..i].contains(v))
}
