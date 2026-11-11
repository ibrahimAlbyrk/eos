//! JavaScript semantics the TypeScript implementation leans on and the output
//! depends on: number printing, `String(v)`, `Number(v)`, `JSON.stringify`,
//! whitespace, and string lengths counted in UTF-16 code units.

use crate::value::Value;

/// What every plain JavaScript object inherits. `key in object` and `object[key]`
/// find these on an object literal, so a lookup table written as one answers for
/// them too; the two places the TypeScript validator does that are mirrored.
pub(crate) const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `String(n)`.
pub(crate) fn number_to_string(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}

/// `String(v)`; `None` is `undefined`.
pub(crate) fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(*n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => join_array(items),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

// Array.prototype.join(","): null prints as nothing.
fn join_array(items: &[Value]) -> String {
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        if !item.is_null() {
            out.push_str(&to_string(Some(item)));
        }
    }
    out
}

/// `Number(v)`; `None` is `undefined`.
pub(crate) fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => *n,
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => string_to_number(&join_array(items)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(s)` for a string.
pub(crate) fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_literal(&t[2..], radix);
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    parse_decimal(t)
}

fn radix_literal(digits: &str, radix: u32) -> f64 {
    let mut out = 0.0f64;
    for c in digits.chars() {
        match c.to_digit(radix) {
            Some(d) => out = out * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    out
}

// digits [. digits] [exp] | . digits [exp]
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// Parses text already known to be a JavaScript decimal literal (optionally signed).
pub(crate) fn parse_decimal(s: &str) -> f64 {
    // Rust reads "1." and ".5" the way JavaScript does; "1.e5" is spelled out to be safe.
    let fixed;
    let text = if let Some(at) = s.find(".e").or_else(|| s.find(".E")) {
        fixed = format!("{}{}", &s[..at], &s[at + 1..]);
        fixed.as_str()
    } else {
        s
    };
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$` — what the expression language and
/// the attribute readers accept as a number in text.
pub(crate) fn is_numeric_text(s: &str) -> bool {
    let t = trim(s);
    let t = t.strip_prefix('-').unwrap_or(t);
    is_decimal_literal(t)
}

/// `Number(s)` for text that passed [`is_numeric_text`].
pub(crate) fn numeric_text_value(s: &str) -> f64 {
    parse_decimal(trim(s))
}

/// What JavaScript's `\s` and `trim()` treat as whitespace.
pub(crate) fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn is_ws_unit(u: u16) -> bool {
    // The parsers ask this of every unit they skip; almost all are ASCII.
    if u < 0x80 {
        return matches!(u, 0x09..=0x0d | 0x20);
    }
    char::from_u32(u32::from(u)).is_some_and(is_ws)
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

pub(crate) fn is_blank(s: &str) -> bool {
    s.chars().all(is_ws)
}

/// `s.length`.
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, end)`; a pair cut in half leaves U+FFFD, which is what Node writes
/// for a lone surrogate when the text leaves the process.
pub(crate) fn head16(s: &str, end: usize) -> String {
    if s.len() <= end {
        return s.to_owned();
    }
    let units: Vec<u16> = s.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

/// `a < b` on strings: by UTF-16 code unit.
pub(crate) fn cmp16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `JSON.stringify(v)`.
pub(crate) fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

/// The UTF-8 size of `JSON.stringify(object)`.
pub(crate) fn object_json_bytes(o: &crate::value::Object) -> usize {
    let mut out = String::new();
    write_object(o, &mut out);
    out.len()
}

/// `JSON.stringify(s)` for a string.
pub(crate) fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_string(s, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) if n.is_finite() => out.push_str(ryu_js::Buffer::new().format_finite(*n)),
        Value::Number(_) => out.push_str("null"),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(o) => write_object(o, out),
    }
}

fn write_object(o: &crate::value::Object, out: &mut String) {
    out.push('{');
    for (i, (k, item)) in o.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(k, out);
        out.push(':');
        write_json(item, out);
    }
    out.push('}');
}

/// `JSON.stringify(s.slice(0, end) + suffix)`. A surrogate pair the cut splits
/// leaves half a character, which JSON.stringify prints as a `\udXXX` escape.
pub(crate) fn quote_head16(s: &str, end: usize, suffix: &str) -> String {
    let mut out = String::with_capacity(end + suffix.len() + 2);
    out.push('"');
    for unit in char::decode_utf16(s.encode_utf16().take(end)) {
        match unit {
            Ok(c) => write_char(c, &mut out),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    suffix.chars().for_each(|c| write_char(c, &mut out));
    out.push('"');
    out
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    s.chars().for_each(|c| write_char(c, out));
    out.push('"');
}

fn write_char(c: char, out: &mut String) {
    {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str("\\u00");
                out.push(char::from_digit((c as u32) >> 4, 16).unwrap_or('0'));
                out.push(char::from_digit((c as u32) & 0xf, 16).unwrap_or('0'));
            }
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (n, text) in
            [(1.0, "1"), (0.1, "0.1"), (1e21, "1e+21"), (-0.0, "0"), (1e-7, "1e-7"), (123456789.0, "123456789")]
        {
            assert_eq!(number_to_string(n), text);
        }
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(
            stringify(&Value::Array(vec![Value::Number(-0.0), Value::Number(f64::INFINITY), Value::Number(1e21)])),
            "[0,null,1e+21]"
        );
        assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn number_of_text() {
        assert_eq!(string_to_number("  12.5 "), 12.5);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x1f"), 31.0);
        assert_eq!(string_to_number("1.e2"), 100.0);
        assert_eq!(string_to_number("-.5"), -0.5);
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        for bad in ["inf", "nan", "1_000", "1e", "--1", "0x", "-0x10", "."] {
            assert!(string_to_number(bad).is_nan(), "{bad}");
        }
    }

    #[test]
    fn json_text_matches_json_stringify() {
        let v: Value =
            serde_json::from_str(r#"{"b":[1,2.5,1e21,null,true],"a":"q\"\\\n\u0001é"}"#).expect("valid json");
        assert_eq!(stringify(&v), r#"{"b":[1,2.5,1e+21,null,true],"a":"q\"\\\n\u0001é"}"#);
    }
}
