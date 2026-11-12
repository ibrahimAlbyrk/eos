//! A JSON value that behaves like the JavaScript one the dashboard works with:
//! numbers are doubles and an object lists its keys in JavaScript property order
//! (array-index keys ascending, then the rest in insertion order). Problem lists
//! and prompts are built by walking objects, so that order is part of the output.

use std::collections::BTreeMap;
use std::fmt;

use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// An own property of an object; `None` for anything else.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|o| o.get(key))
    }

    /// The text `JSON.stringify` prints for this value: no whitespace, numbers as
    /// JavaScript prints them (`1`, not `1.0`; `1e+21`), a non-finite number as
    /// `null`. Size limits are measured on this text, so both implementations
    /// count the same bytes.
    pub fn to_json(&self) -> String {
        crate::js::stringify(self)
    }

    /// `Number(value)`: text is read as JavaScript reads it (`""` is 0,
    /// `"0x10"` is 16, anything else unreadable is NaN).
    pub fn to_js_number(&self) -> f64 {
        crate::js::to_number(Some(self))
    }

    /// `String(value)`, as a template literal prints it.
    pub fn to_js_string(&self) -> String {
        crate::js::to_string(Some(self))
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Bool(v)
    }
}

impl From<f64> for Value {
    fn from(v: f64) -> Self {
        Value::Number(v)
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::String(v.to_owned())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::String(v)
    }
}

impl From<Vec<Value>> for Value {
    fn from(v: Vec<Value>) -> Self {
        Value::Array(v)
    }
}

impl From<Object> for Value {
    fn from(v: Object) -> Self {
        Value::Object(v)
    }
}

/// A JSON object in JavaScript property order: array-index keys ascending, then
/// every other key in insertion order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Object {
    // Kept apart so that neither order costs more than a map insert, whatever
    // order the keys arrive in.
    indexed: BTreeMap<u32, (String, Value)>,
    named: IndexMap<String, Value>,
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.indexed.is_empty() && self.named.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match array_index(key) {
            Some(n) => self.indexed.get(&n).map(|(_, v)| v),
            None => self.named.get(key),
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        match array_index(key) {
            Some(n) => self.indexed.get_mut(&n).map(|(_, v)| v),
            None => self.named.get_mut(key),
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Sets a key. A key that already exists keeps its place (as assigning to an
    /// existing JavaScript property does); the previous value is returned.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) -> Option<Value> {
        let key = key.into();
        match array_index(&key) {
            Some(n) => self.indexed.insert(n, (key, value)).map(|(_, old)| old),
            None => self.named.insert(key, value),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        match array_index(key) {
            Some(n) => self.indexed.remove(&n).map(|(_, v)| v),
            None => self.named.shift_remove(key),
        }
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&str, &Value)> {
        self.indexed.values().map(|(k, v)| (k.as_str(), v)).chain(self.named.iter().map(|(k, v)| (k.as_str(), v)))
    }

    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &str> {
        self.iter().map(|(k, _)| k)
    }

    pub fn values(&self) -> impl DoubleEndedIterator<Item = &Value> {
        self.iter().map(|(_, v)| v)
    }
}

impl<K: Into<String>> FromIterator<(K, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (K, Value)>>(iter: I) -> Self {
        let mut out = Object::new();
        for (k, v) in iter {
            out.insert(k, v);
        }
        out
    }
}

/// The array index a property key stands for: a canonical decimal below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

// ---- serde ---------------------------------------------------------------------

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => s.serialize_unit(),
            Value::Bool(b) => s.serialize_bool(*b),
            Value::Number(n) => serialize_number(*n, s),
            Value::String(v) => s.serialize_str(v),
            Value::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Value::Object(o) => o.serialize(s),
        }
    }
}

impl Serialize for Object {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.len()))?;
        for (k, v) in self.iter() {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

// Whole numbers go out as integers and non-finite ones as null, as JSON.stringify
// prints them.
fn serialize_number<S: Serializer>(n: f64, s: S) -> Result<S::Ok, S::Error> {
    const MAX_SAFE: f64 = 9_007_199_254_740_992.0;
    if !n.is_finite() {
        s.serialize_unit()
    } else if n.fract() == 0.0 && n.abs() < MAX_SAFE {
        s.serialize_i64(n as i64)
    } else {
        s.serialize_f64(n)
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ValueVisitor)
    }
}

impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Object(o) => Ok(o),
            _ => Err(de::Error::custom("expected an object")),
        }
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
        Ok(Value::Number(v as f64))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(v as f64))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
        Ok(Value::Number(v))
    }

    fn visit_str<E>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        Value::deserialize(d)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1024));
        while let Some(item) = seq.next_element()? {
            out.push(item);
        }
        Ok(Value::Array(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Object::new();
        while let Some((k, v)) = map.next_entry::<String, Value>()? {
            out.insert(k, v);
        }
        Ok(Value::Object(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_javascript_property_order() {
        let mut o = Object::new();
        for k in ["b", "10", "a", "2", "01", "4294967295", "0"] {
            o.insert(k, Value::Null);
        }
        o.insert("a", Value::Bool(true));
        assert_eq!(o.keys().collect::<Vec<_>>(), ["0", "2", "10", "b", "a", "01", "4294967295"]);
        assert_eq!(o.get("a"), Some(&Value::Bool(true)));
        o.remove("2");
        o.insert("1", Value::Null);
        assert_eq!(o.keys().collect::<Vec<_>>(), ["0", "1", "10", "b", "a", "01", "4294967295"]);
    }

    #[test]
    fn a_repeated_json_key_keeps_its_place_and_the_last_value() {
        let v: Value = serde_json::from_str(r#"{"a":1,"b":2,"a":3}"#).expect("valid json");
        let o = v.as_object().expect("object");
        assert_eq!(o.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(o.get("a"), Some(&Value::Number(3.0)));
        assert_eq!(serde_json::to_string(&v).expect("serializes"), r#"{"a":3,"b":2}"#);
    }
}
