//! The least data a contract accepts: every list at its `min`, every optional
//! field absent. A design must still render with it, so a page never breaks on
//! a quiet morning with one story and no images.

use serde_json::{Map, Value, json};

use crate::types::{Field, Type};

pub fn minimal_data(fields: &[Field]) -> Value {
    minimal_object(fields)
}

fn minimal_object(fields: &[Field]) -> Value {
    let map: Map<String, Value> =
        fields.iter().filter(|f| f.required).map(|f| (f.name.clone(), minimal_value(&f.ty))).collect();
    Value::Object(map)
}

fn minimal_value(ty: &Type) -> Value {
    match ty {
        Type::Text { .. } | Type::LongText { .. } => json!("A"),
        Type::Number | Type::Int => json!(0),
        Type::Bool => json!(false),
        Type::Date => json!("2026-01-01"),
        Type::DateTime => json!("2026-01-01T00:00:00Z"),
        Type::Url => json!("https://example.com/"),
        Type::Image => json!({"src": "https://example.com/image.png", "alt": "A"}),
        Type::Enum { values } => json!(values.first()),
        Type::Object { fields } => minimal_object(fields),
        Type::List { of, min, .. } => Value::Array((0..*min).map(|_| minimal_value(of)).collect()),
    }
}
