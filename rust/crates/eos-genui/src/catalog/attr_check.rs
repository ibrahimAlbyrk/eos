//! What one attribute value must look like, by kind. Values arrive as the markup
//! parser left them: text, a JSON value, or `true` for a bare flag.

use super::components::{AttrDef, AttrKind};
use super::limits::{FIELD_RE, GENUI_ICONS, GENUI_TONES, NAME_RE, SORT_RE, STATE_KEY_RE, URL_RE};
use crate::expr::{check_expr, check_where};
use crate::js;
use crate::re::is_match;
use crate::value::Value;

/// Why `value` is not acceptable for the attribute, phrased to follow the value
/// ("is …") or stand alone ("must …"); `None` when it is fine. A `{…}` template
/// in a templatable attribute is the caller's to skip.
pub(crate) fn attr_problem(a: &AttrDef, value: &Value) -> Option<String> {
    let text = value.as_str();
    let fail = |message: &str| Some(message.to_owned());
    let is_bool_text = matches!(text, Some("true" | "false"));
    match a.kind {
        AttrKind::Text => {
            (!matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))).then(|| "must be text".to_owned())
        }
        AttrKind::Number | AttrKind::Int => {
            let Some(n) = attr_number(value) else { return fail("is not a number") };
            if a.kind == AttrKind::Int && (n.fract() != 0.0 || !n.is_finite()) {
                return fail("is not a whole number");
            }
            let outside = a.min.is_some_and(|min| n < min) || a.max.is_some_and(|max| n > max);
            outside.then(|| format!("is outside {}", range_text(a)))
        }
        AttrKind::Numfield => match value {
            Value::Number(_) => None,
            Value::String(s) if !s.is_empty() => None,
            _ => fail("must be a number or a field name"),
        },
        AttrKind::Bool => {
            (!matches!(value, Value::Bool(_)) && !is_bool_text).then(|| "is not true or false".to_owned())
        }
        AttrKind::Enum => one_of(text, a.values),
        AttrKind::Tone => one_of(text, GENUI_TONES),
        AttrKind::Icon => one_of(text, GENUI_ICONS),
        AttrKind::Url => (!text.is_some_and(|s| is_match(&URL_RE, s))).then(|| "must be an http(s) URL".to_owned()),
        AttrKind::Ids | AttrKind::Labels | AttrKind::Cols | AttrKind::Chips | AttrKind::Fields | AttrKind::Actions => {
            (!matches!(value, Value::String(_) | Value::Number(_) | Value::Array(_)))
                .then(|| "must be a list".to_owned())
        }
        AttrKind::Id => match value {
            Value::Number(_) => None,
            Value::String(s) if !s.is_empty() => None,
            _ => fail("must be an id"),
        },
        AttrKind::Best => (!matches!(value, Value::Bool(_) | Value::String(_)))
            .then(|| "must be a flag or \"field:max field:min\"".to_owned()),
        AttrKind::Json => None,
        AttrKind::Collection => {
            (!text.is_some_and(|s| is_match(&NAME_RE, s))).then(|| "must name a data collection".to_owned())
        }
        AttrKind::Field => (!text.is_some_and(|s| is_match(&FIELD_RE, s))).then(|| "must be a field name".to_owned()),
        AttrKind::Action => (!text.is_some_and(|s| is_match(&NAME_RE, s))).then(|| "must name an action".to_owned()),
        AttrKind::State => match text {
            None => fail("must be a state key"),
            Some(s) => (!is_match(&STATE_KEY_RE, s)).then(|| "must be a state key like party_size".to_owned()),
        },
        AttrKind::Expr => match text {
            None => fail("must be an expression"),
            Some(s) => check_expr(s).map(|e| format!("is not a valid expression: {e}")),
        },
        AttrKind::Where => match text {
            None => fail("must be a filter"),
            Some(s) => check_where(s).map(|e| format!("is not a valid filter: {e}")),
        },
        AttrKind::Sort => match text {
            None => fail("must be a field name"),
            Some(s) => (!is_match(&SORT_RE, s)).then(|| "must be field or -field".to_owned()),
        },
        AttrKind::Geo => geo_problem(value, is_bool_text),
    }
}

/// The number an attribute value stands for: a number, or text that reads as one.
pub(crate) fn attr_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => Some(*n),
        Value::String(s) if js::is_numeric_text(s) => Some(js::numeric_text_value(s)),
        _ => None,
    }
}

fn one_of(text: Option<&str>, values: &[&str]) -> Option<String> {
    let known = text.is_some_and(|s| {
        let s = s.to_lowercase();
        values.iter().any(|v| v.to_lowercase() == s)
    });
    (!known).then(|| format!("is not one of {}", values.join(", ")))
}

fn range_text(a: &AttrDef) -> String {
    match (a.min, a.max) {
        (Some(lo), Some(hi)) => format!("{}–{}", js::number_to_string(lo), js::number_to_string(hi)),
        (Some(lo), None) => format!("≥ {}", js::number_to_string(lo)),
        (None, hi) => format!("≤ {}", js::number_to_string(hi.unwrap_or(f64::INFINITY))),
    }
}

// A flag, or [lat, lon]. A list of the wrong length or with a non-number reads
// as "not a flag or a pair"; a pair that is off the map names the coordinate; a
// longer list of numbers is told the shape.
fn geo_problem(value: &Value, is_bool_text: bool) -> Option<String> {
    const SHAPE: &str = "must be a flag or [lat, lon]";
    if matches!(value, Value::Bool(_)) || is_bool_text {
        return None;
    }
    let Value::Array(items) = value else { return Some(SHAPE.to_owned()) };
    let (Some(Value::Number(lat)), Some(Value::Number(lon))) = (items.first(), items.get(1)) else {
        return Some(SHAPE.to_owned());
    };
    if items.len() > 2 {
        return Some("must be [lat, lon] — two numbers".to_owned());
    }
    if !(-90.0..=90.0).contains(lat) {
        return Some("is not a latitude (−90–90)".to_owned());
    }
    (!(-180.0..=180.0).contains(lon)).then(|| "is not a longitude (−180–180)".to_owned())
}
