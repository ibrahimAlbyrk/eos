//! The candidate YAML libraries behind one face: text → JSON value, JSON value → text.

use serde_json::Value;

pub struct Lib {
    pub name: &'static str,
    pub parse: fn(&str) -> Result<Value, String>,
    pub write: fn(&Value) -> Result<String, String>,
}

// YAML allows any node as a mapping key; JavaScript objects (and JSON) keep
// only strings. `yaml` for npm turns `123:` and `true:` into the keys "123"
// and "true"; going through each library's own value type lets us do the same.
fn ng_to_json(v: serde_yaml_ng::Value) -> Result<Value, String> {
    use serde_yaml_ng::Value as Y;
    Ok(match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => serde_json::to_value(n).map_err(|e| e.to_string())?,
        Y::String(s) => Value::String(s),
        Y::Sequence(items) => Value::Array(items.into_iter().map(ng_to_json).collect::<Result<_, _>>()?),
        Y::Mapping(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    Y::String(s) => s,
                    Y::Bool(b) => b.to_string(),
                    Y::Number(n) => n.to_string(),
                    Y::Null => String::new(),
                    other => return Err(format!("mapping key is a {other:?}")),
                };
                out.insert(key, ng_to_json(v)?);
            }
            Value::Object(out)
        }
        Y::Tagged(t) => ng_to_json(t.value)?,
    })
}

fn norway_to_json(v: serde_norway::Value) -> Result<Value, String> {
    use serde_norway::Value as Y;
    Ok(match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => serde_json::to_value(n).map_err(|e| e.to_string())?,
        Y::String(s) => Value::String(s),
        Y::Sequence(items) => Value::Array(items.into_iter().map(norway_to_json).collect::<Result<_, _>>()?),
        Y::Mapping(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    Y::String(s) => s,
                    Y::Bool(b) => b.to_string(),
                    Y::Number(n) => n.to_string(),
                    Y::Null => String::new(),
                    other => return Err(format!("mapping key is a {other:?}")),
                };
                out.insert(key, norway_to_json(v)?);
            }
            Value::Object(out)
        }
        Y::Tagged(t) => norway_to_json(t.value)?,
    })
}

pub fn all() -> Vec<Lib> {
    vec![
        Lib {
            name: "serde_yaml_ng 0.10.0",
            parse: |text| {
                // No apply_merge(): `yaml` for npm leaves `<<` an ordinary key by default.
                ng_to_json(serde_yaml_ng::from_str(text).map_err(|e| e.to_string())?)
            },
            write: |v| serde_yaml_ng::to_string(v).map_err(|e| e.to_string()),
        },
        Lib {
            name: "serde_norway 0.9.42",
            parse: |text| norway_to_json(serde_norway::from_str(text).map_err(|e| e.to_string())?),
            write: |v| serde_norway::to_string(v).map_err(|e| e.to_string()),
        },
        Lib {
            name: "serde-saphyr 2.1.1",
            parse: |text| serde_saphyr::from_str::<Value>(text).map_err(|e| e.to_string()),
            write: |v| serde_saphyr::to_string(v).map_err(|e| e.to_string()),
        },
    ]
}
