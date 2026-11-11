//! `{name}` variables in scenario strings, and pointers into a response.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// `{name}` is a variable; `{{name}}` is the literal text `{name}`.
static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}|\{([A-Za-z_][A-Za-z0-9_.]*)\}").expect("placeholder pattern")
});

/// A variable a step needs was never set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Missing(pub String);

/// Values known while a scenario runs: given on the command line or captured from a response.
#[derive(Debug, Clone, Default)]
pub struct Vars {
    values: BTreeMap<String, Value>,
}

impl Vars {
    pub fn set(&mut self, name: impl Into<String>, value: Value) {
        self.values.insert(name.into(), value);
    }

    /// Fills every `{name}` in `template`.
    pub fn text(&self, template: &str) -> Result<String, Missing> {
        let mut out = String::with_capacity(template.len());
        let mut last = 0;
        for found in PLACEHOLDER.captures_iter(template) {
            let Some(whole) = found.get(0) else { continue };
            out.push_str(&template[last..whole.start()]);
            last = whole.end();
            if let Some(literal) = found.get(1) {
                out.push('{');
                out.push_str(literal.as_str());
                out.push('}');
                continue;
            }
            let name = &found[2];
            match self.values.get(name).ok_or_else(|| Missing(name.to_owned()))? {
                Value::String(s) => out.push_str(s),
                other => out.push_str(&other.to_string()),
            }
        }
        out.push_str(&template[last..]);
        Ok(out)
    }

    /// Fills the strings of a JSON body. A string that is one placeholder takes
    /// the variable's own JSON value, so a captured number stays a number.
    pub fn json(&self, template: &Value) -> Result<Value, Missing> {
        Ok(match template {
            Value::String(s) => match PLACEHOLDER.captures(s) {
                Some(found) if found.get(2).is_some() && found.get(0).is_some_and(|whole| whole.len() == s.len()) => {
                    let name = &found[2];
                    self.values.get(name).cloned().ok_or_else(|| Missing(name.to_owned()))?
                }
                _ => Value::String(self.text(s)?),
            },
            Value::Array(items) => Value::Array(items.iter().map(|v| self.json(v)).collect::<Result<_, _>>()?),
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (key, value) in map {
                    out.insert(self.text(key)?, self.json(value)?);
                }
                Value::Object(out)
            }
            other => other.clone(),
        })
    }
}

/// Follows `/a/0/b` into `root`. A segment `[key=value]` picks the first array
/// element whose `key` reads `value`; `[last]` picks the last element.
pub fn select<'a>(root: &'a Value, pointer: &str) -> Option<&'a Value> {
    let mut node = root;
    for segment in pointer.split('/').skip(1) {
        node = match node {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => {
                if segment == "[last]" {
                    items.last()?
                } else if let Some(filter) = segment.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                    let (key, wanted) = filter.split_once('=')?;
                    items.iter().find(|item| item.get(key).is_some_and(|v| reads_as(v, wanted)))?
                } else {
                    items.get(segment.parse::<usize>().ok()?)?
                }
            }
            _ => return None,
        };
    }
    Some(node)
}

/// Decodes standard base64 (padding optional, whitespace ignored).
pub fn base64_decode(text: &str) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u8);
    for c in text.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => anyhow::bail!("not a base64 character: {:?}", char::from(other)),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff)?);
        }
    }
    Ok(out)
}

fn reads_as(value: &Value, wanted: &str) -> bool {
    match value {
        Value::String(s) => s == wanted,
        Value::Null => wanted == "null",
        other => {
            let text = other.to_string();
            text == wanted
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn vars() -> Vars {
        let mut vars = Vars::default();
        vars.set("id", json!("w-1"));
        vars.set("n", json!(7));
        vars
    }

    #[test]
    fn fills_text() {
        assert_eq!(vars().text("/workers/{id}/queue/{n}"), Ok("/workers/w-1/queue/7".into()));
        assert_eq!(vars().text("{\"a\":1}"), Ok("{\"a\":1}".into()));
        assert_eq!(vars().text("/x/{nope}"), Err(Missing("nope".into())));
        assert_eq!(vars().text("meta=\"{{area}} of {id}\" {{id}}"), Ok("meta=\"{area} of w-1\" {id}".into()));
        assert_eq!(vars().json(&json!("{{id}}")), Ok(json!("{id}")));
    }

    #[test]
    fn fills_json_keeping_types() {
        let body = json!({"worker": "{id}", "count": "{n}", "label": "n={n}", "list": ["{id}"], "{id}": true});
        assert_eq!(
            vars().json(&body),
            Ok(json!({"worker": "w-1", "count": 7, "label": "n=7", "list": ["w-1"], "w-1": true}))
        );
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(base64_decode("cGFzdGVkIGJ5dGVz").expect("valid"), b"pasted bytes");
        assert_eq!(base64_decode("iVBO\nRw==").expect("valid"), [0x89, b'P', b'N', b'G']);
        assert!(base64_decode("a!b").is_err());
    }

    #[test]
    fn selects_by_pointer_and_filter() {
        let doc = json!({"json": [{"id": "a", "state": "DONE", "n": 1}, {"id": "b", "state": "IDLE", "n": 2}]});
        assert_eq!(select(&doc, "/json/1/id"), Some(&json!("b")));
        assert_eq!(select(&doc, "/json/[state=IDLE]/id"), Some(&json!("b")));
        assert_eq!(select(&doc, "/json/[n=1]/id"), Some(&json!("a")));
        assert_eq!(select(&doc, "/json/[last]/id"), Some(&json!("b")));
        assert_eq!(select(&doc, "/json/[state=GONE]/id"), None);
        assert_eq!(select(&doc, ""), Some(&doc));
    }
}
