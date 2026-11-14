//! YAML as the data JavaScript holds after `yaml.parse`: plain JSON values,
//! mapping keys always strings.

use serde_json::{Map, Number, Value};
use serde_norway::Value as Yaml;

/// A number as JavaScript prints it, for a mapping key.
fn number_key(n: &serde_norway::Number) -> String {
    match n.as_f64() {
        Some(f) if f.is_nan() => "NaN".to_owned(),
        Some(f) if f.is_infinite() => if f > 0.0 { "Infinity" } else { "-Infinity" }.to_owned(),
        _ => n.to_string(),
    }
}

fn key(of: Yaml) -> Result<String, String> {
    match of {
        Yaml::String(s) => Ok(s),
        Yaml::Bool(b) => Ok(b.to_string()),
        Yaml::Number(n) => Ok(number_key(&n)),
        Yaml::Null => Ok("null".to_owned()),
        Yaml::Tagged(tagged) => key(tagged.value),
        Yaml::Sequence(_) | Yaml::Mapping(_) => Err("a mapping key must be a scalar".to_owned()),
    }
}

fn number(n: &serde_norway::Number) -> Value {
    if let Some(i) = n.as_i64() {
        return Value::Number(i.into());
    }
    if let Some(u) = n.as_u64() {
        return Value::Number(u.into());
    }
    // JSON has no infinity and no NaN; they travel as JavaScript names them.
    n.as_f64().and_then(Number::from_f64).map_or_else(|| Value::String(number_key(n)), Value::Number)
}

fn convert(value: Yaml) -> Result<Value, String> {
    Ok(match value {
        Yaml::Null => Value::Null,
        Yaml::Bool(b) => Value::Bool(b),
        Yaml::Number(n) => number(&n),
        Yaml::String(s) => Value::String(s),
        Yaml::Sequence(items) => Value::Array(items.into_iter().map(convert).collect::<Result<_, _>>()?),
        Yaml::Mapping(map) => {
            let mut out = Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(key(k)?, convert(v)?);
            }
            Value::Object(out)
        }
        // A tag is not data: the value under it is.
        Yaml::Tagged(tagged) => convert(tagged.value)?,
    })
}

/// Parses a YAML document as the `yaml` package does (`eos_kit_fs::read_yaml`)
/// into JSON data. An empty document is `null`. Merge keys (`<<`) stay
/// ordinary keys.
pub(crate) fn parse(text: &str) -> Result<Value, String> {
    convert(eos_kit_fs::read_yaml(text).map_err(|e| e.to_string())?)
}
