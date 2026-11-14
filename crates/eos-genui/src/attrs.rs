//! Readers for markup attribute values, shared by the validator and the kit so a
//! list, a column spec or a chip set means the same thing on both sides.
//!
//! Attribute values arrive as the parser left them: a string (quoted), a JSON
//! value (`{…}`) or `true` (a bare flag); `None` is an attribute that is absent.
//! Lists accept either a JSON array or a string:
//! - ids (action ids, entity ids, field keys): split on commas and/or spaces
//! - labels (options, tab labels, chips, cols): split on "|" when present, else ","

use crate::js::{self, is_ws};
use crate::value::{Object, Value};

pub fn split_ids(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items.iter().map(scalar_text).filter(|s| !s.is_empty()).collect(),
        Some(Value::Number(n)) => vec![js::number_to_string(*n)],
        Some(Value::String(s)) => {
            s.split(|c| is_ws(c) || c == ',').filter(|x| !x.is_empty()).map(str::to_owned).collect()
        }
        _ => Vec::new(),
    }
}

pub fn split_labels(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .map(|x| match x.as_object() {
                Some(o) => scalar_text(first_set(o, &["label", "title", "name"])),
                None => scalar_text(x),
            })
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::Number(n)) => vec![js::number_to_string(*n)],
        Some(Value::String(s)) => split_trimmed(s, if s.contains('|') { '|' } else { ',' }),
        _ => Vec::new(),
    }
}

fn split_trimmed(s: &str, sep: char) -> Vec<String> {
    s.split(sep).map(js::trim).filter(|x| !x.is_empty()).map(str::to_owned).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColSpec {
    pub key: String,
    /// "" = no header text.
    pub label: String,
}

/// `cols="name rating price"` · `cols="name:Venue, rating:Score"` ·
/// `cols={[{"key":"name","label":"Venue"}]}`
pub fn parse_cols(v: Option<&Value>) -> Vec<ColSpec> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|x| match x.as_object() {
                Some(o) => {
                    let key = scalar_text(first_set(o, &["key", "field"]));
                    if key.is_empty() {
                        return None;
                    }
                    let label = o.get("label").map_or_else(|| key.clone(), scalar_text);
                    Some(ColSpec { key, label })
                }
                None => col_entry(&scalar_text(x)),
            })
            .collect(),
        Some(Value::String(s)) => {
            let parts = if s.contains('|') || s.contains(',') {
                split_labels(v)
            } else {
                s.split(is_ws).filter(|x| !x.is_empty()).map(str::to_owned).collect()
            };
            parts.iter().filter_map(|p| col_entry(p)).collect()
        }
        _ => Vec::new(),
    }
}

fn col_entry(raw: &str) -> Option<ColSpec> {
    let s = js::trim(raw);
    if s.is_empty() {
        return None;
    }
    let Some((key, label)) = s.split_once(':') else {
        return Some(ColSpec { key: s.to_owned(), label: s.to_owned() });
    };
    let key = js::trim(key);
    (!key.is_empty()).then(|| ColSpec { key: key.to_owned(), label: js::trim(label).to_owned() })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChipSpec {
    pub label: String,
    pub r#where: String,
}

/// `chips="Open now: open | Seafood: tags~sea | ₺–₺₺: price<=2"` (or comma-separated),
/// `chips={[{"label":"Open now","where":"open"}]}`. A chip without a label shows its
/// filter. Only a lone "|" separates chips — "||" is a filter's own.
pub fn parse_chips(v: Option<&Value>) -> Vec<ChipSpec> {
    let split;
    let entries: &[Value] = match v {
        Some(Value::Array(items)) => items,
        Some(Value::String(s)) => {
            split = split_chips(s).into_iter().map(Value::String).collect::<Vec<_>>();
            &split
        }
        other => {
            split = split_labels(other).into_iter().map(Value::String).collect::<Vec<_>>();
            &split
        }
    };
    let mut out = Vec::new();
    for x in entries {
        if let Some(o) = x.as_object() {
            let filter = scalar_text(first_set(o, &["where", "filter"]));
            if !filter.is_empty() {
                let label = o.get("label").map(scalar_text).filter(|l| !l.is_empty()).unwrap_or_else(|| filter.clone());
                out.push(ChipSpec { label, r#where: filter });
            }
            continue;
        }
        let s = scalar_text(x);
        if s.is_empty() {
            continue;
        }
        // "Label: filter" — the label ends at the first ": " (filters never contain one).
        match s.find(": ") {
            Some(at) if at > 0 => {
                out.push(ChipSpec { label: js::trim(&s[..at]).to_owned(), r#where: js::trim(&s[at + 2..]).to_owned() })
            }
            _ => out.push(ChipSpec { label: s.clone(), r#where: s }),
        }
    }
    out
}

fn split_chips(s: &str) -> Vec<String> {
    let b = s.as_bytes();
    let lone_bar = |i: usize| b[i] == b'|' && (i == 0 || b[i - 1] != b'|') && b.get(i + 1) != Some(&b'|');
    let bars: Vec<usize> = (0..b.len()).filter(|i| lone_bar(*i)).collect();
    if bars.is_empty() {
        return split_trimmed(s, ',');
    }
    let mut out = Vec::new();
    let mut from = 0;
    for at in bars.into_iter().chain([b.len()]) {
        let part = js::trim(&s[from..at]);
        if !part.is_empty() {
            out.push(part.to_owned());
        }
        from = at + 1;
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionSpec {
    pub label: String,
    pub value: String,
}

/// `options="Saturday | Sunday"` · `options={["2 people","4 people"]}` ·
/// `options={[{"label":"Sat","value":"sat"}]}`
pub fn parse_options(v: Option<&Value>) -> Vec<OptionSpec> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|x| match x.as_object() {
                Some(o) => {
                    let label = scalar_text(first_set(o, &["label", "title", "name", "value"]));
                    if label.is_empty() {
                        return None;
                    }
                    let value = o.get("value").map_or_else(|| label.clone(), scalar_text);
                    Some(OptionSpec { label, value })
                }
                None => {
                    let s = scalar_text(x);
                    (!s.is_empty()).then(|| OptionSpec { label: s.clone(), value: s })
                }
            })
            .collect(),
        other => split_labels(other).into_iter().map(|label| OptionSpec { value: label.clone(), label }).collect(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BestDir {
    Max,
    Min,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BestSpec {
    /// The kit decides per column (highest score, lowest price/distance).
    Auto,
    /// Column key → direction, in JavaScript property order.
    Columns(Vec<(String, BestDir)>),
}

/// `best` · `best="rating:max price:min distance:min"`.
pub fn parse_best(v: Option<&Value>) -> Option<BestSpec> {
    match v {
        Some(Value::Bool(true)) => return Some(BestSpec::Auto),
        Some(Value::String(s)) if s == "true" || s.is_empty() => return Some(BestSpec::Auto),
        None | Some(Value::Null | Value::Bool(false)) => return None,
        Some(Value::String(s)) if s == "false" => return None,
        _ => {}
    }
    // Collected through an object so a repeated or index-like key lands where
    // JavaScript would put it.
    let mut out = Object::new();
    for part in split_ids(v) {
        let mut pieces = part.split(':');
        let key = pieces.next().unwrap_or("");
        // Assigning a string to `__proto__` on a JavaScript object sets nothing.
        if key.is_empty() || key == "__proto__" {
            continue;
        }
        out.insert(key, Value::Bool(pieces.next() == Some("min")));
    }
    if out.is_empty() {
        return Some(BestSpec::Auto);
    }
    let dir = |min: &Value| if min == &Value::Bool(true) { BestDir::Min } else { BestDir::Max };
    Some(BestSpec::Columns(out.iter().map(|(k, min)| (k.to_owned(), dir(min))).collect()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SortSpec {
    pub field: String,
    pub desc: bool,
}

/// `sort="rating"` ascending · `sort="-rating"` descending.
pub fn parse_sort(v: Option<&Value>) -> Option<SortSpec> {
    let s = js::trim(v?.as_str()?);
    if s.is_empty() {
        return None;
    }
    Some(match s.strip_prefix('-') {
        Some(field) => SortSpec { field: js::trim(field).to_owned(), desc: true },
        None => SortSpec { field: s.to_owned(), desc: false },
    })
}

pub fn attr_bool(v: Option<&Value>, fallback: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" || s.is_empty() => true,
        Some(Value::String(s)) if s == "false" => false,
        _ => fallback,
    }
}

pub fn attr_num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        Some(Value::String(s)) if js::is_numeric_text(s) => Some(js::numeric_text_value(s)),
        _ => None,
    }
}

pub fn attr_text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(js::number_to_string(*n)),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

/// A `{…}` attribute (items, values, spark, images) never takes a string, so a
/// string names a data key: `items="limits"` reads `data.limits`. Anything else
/// is the value.
pub fn data_ref<'a>(v: Option<&'a Value>, data: Option<&'a Value>) -> Option<&'a Value> {
    data_ref_in(v, data.and_then(Value::as_object))
}

pub(crate) fn data_ref_in<'a>(v: Option<&'a Value>, data: Option<&'a Object>) -> Option<&'a Value> {
    match (v, data) {
        (Some(Value::String(key)), Some(o)) => o.get(key).or(v),
        _ => v,
    }
}

// `a ?? b ?? c`: the first of these keys that is set and not null.
fn first_set<'a>(o: &'a Object, keys: &[&str]) -> &'a Value {
    keys.iter().filter_map(|k| o.get(k)).find(|v| !v.is_null()).unwrap_or(&Value::Null)
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => js::trim(s).to_owned(),
        Value::Number(n) => js::number_to_string(*n),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}
