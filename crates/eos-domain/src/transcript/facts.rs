//! The few fields of a payload the subagent selection reads, taken without
//! building the whole document: every other value is skipped as it is read
//! (texts, tool inputs and results are most of a log's bytes). What comes out
//! is a small JSON object of those fields, read as the whole document reads:
//! a field that is not a string is no string, the last of two equal keys wins,
//! a payload that is not an object has none of them.

use std::fmt;

use serde::Deserializer;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

/// Top-level fields whose string value is kept.
const TEXT: [&str; 12] = [
    "type",
    "phase",
    "kind",
    "state",
    "event",
    "callId",
    "parentCallId",
    "toolName",
    "name",
    "id",
    "toolUseId",
    "parentAgentToolUseId",
];
/// Fields of a message block whose string value is kept.
const BLOCK_TEXT: [&str; 3] = ["type", "callId", "name"];

/// The facts of `payload`; `Null` when it is not JSON.
pub(super) fn facts(payload: &str) -> Value {
    let mut reader = serde_json::Deserializer::from_str(payload);
    match (Object { blocks: true }).deserialize(&mut reader).and_then(|v| reader.end().map(|()| v)) {
        Ok(value) => value,
        Err(_) => Value::Null,
    }
}

/// A JSON object read for its kept fields (and, at the top, its blocks).
struct Object {
    blocks: bool,
}

impl<'de> DeserializeSeed<'de> for Object {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Object {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        let kept: &[&str] = if self.blocks { &TEXT } else { &BLOCK_TEXT };
        while let Some(key) = map.next_key::<String>()? {
            if kept.contains(&key.as_str()) {
                match map.next_value_seed(Text)? {
                    Some(text) => out.insert(key, Value::String(text)),
                    None => out.remove(&key),
                };
            } else if key == "spawnsSubagent" {
                match map.next_value_seed(Flag)? {
                    true => out.insert(key, Value::Bool(true)),
                    false => out.remove(&key),
                };
            } else if key == "blocks" && self.blocks {
                match map.next_value_seed(Blocks)? {
                    Some(blocks) => out.insert(key, Value::Array(blocks)),
                    None => out.remove(&key),
                };
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Value::Object(out))
    }

    // Anything but an object has none of the fields.
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Value, A::Error> {
        IgnoredAny.visit_seq(seq).map(|_| Value::Null)
    }
    fn visit_str<E>(self, _: &str) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
}

/// A value kept only when it is a string.
struct Text;

impl<'de> DeserializeSeed<'de> for Text {
    type Value = Option<String>;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Option<String>, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Text {
    type Value = Option<String>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(v.to_owned()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
        IgnoredAny.visit_seq(seq).map(|_| None)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
        IgnoredAny.visit_map(map).map(|_| None)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
}

/// `true` only for JSON `true`.
struct Flag;

impl<'de> DeserializeSeed<'de> for Flag {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Flag {
    type Value = bool;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<bool, E> {
        Ok(v)
    }
    fn visit_str<E>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<bool, A::Error> {
        IgnoredAny.visit_seq(seq).map(|_| false)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<bool, A::Error> {
        IgnoredAny.visit_map(map).map(|_| false)
    }
    fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E>(self) -> Result<bool, E> {
        Ok(false)
    }
}

/// A message's blocks, each read for its kept fields; `None` when the value
/// is not an array.
struct Blocks;

impl<'de> DeserializeSeed<'de> for Blocks {
    type Value = Option<Vec<Value>>;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Blocks {
    type Value = Option<Vec<Value>>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut blocks = Vec::new();
        while let Some(block) = seq.next_element_seed(Object { blocks: false })? {
            blocks.push(block);
        }
        Ok(Some(blocks))
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
        IgnoredAny.visit_map(map).map(|_| None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn keeps_only_the_fields_read_and_reads_them_as_the_whole_document_does() {
        let payload = json!({
            "type": "message", "role": "assistant", "text": "a long text that is skipped",
            "blocks": [
                {"type": "tool_call", "callId": "t1", "name": "Agent", "input": {"deep": [1, 2]}, "spawnsSubagent": true},
                {"type": "tool_result", "callId": "t1", "content": "x"},
                "not a block", 5
            ],
            "callId": 7, "phase": null, "kind": ["no"], "toolName": {"no": 1}
        });
        assert_eq!(
            facts(&payload.to_string()),
            json!({"type": "message", "blocks": [
                {"type": "tool_call", "callId": "t1", "name": "Agent", "spawnsSubagent": true},
                {"type": "tool_result", "callId": "t1"},
                null, null
            ]})
        );
        assert_eq!(facts(r#"{"type":"a","type":"b"}"#), json!({"type": "b"}), "the last of two keys wins");
        assert_eq!(facts(r#"{"type":"a","type":5}"#), json!({}), "as Value::as_str reads the last one");
        assert_eq!(facts("[1,2]"), Value::Null);
        assert_eq!(facts("\"text\""), Value::Null);
        assert_eq!(facts("{not json"), Value::Null);
        assert_eq!(facts(r#"{"blocks": {"a": 1}, "spawnsSubagent": "yes"}"#), json!({}));
        assert_eq!(facts(r#"{"name":"\u0041gent"}"#), json!({"name": "Agent"}), "escapes are read");
    }
}
