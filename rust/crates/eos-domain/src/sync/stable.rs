//! `stableStringify`: JSON with object keys sorted, so the same content hashes
//! the same on every Mac. Three places where "obvious" Rust differs from the
//! JavaScript original, each of which would make every record look changed:
//!
//! - keys sort by UTF-16 code unit (JavaScript's default sort), not by byte;
//! - every number is an IEEE double printed by ECMAScript's Number::toString
//!   (`1e21` prints as `1e+21`, `1.0` as `1`, integers past 2^53 lose digits);
//! - a key whose value is `undefined` is dropped — in Rust terms an absent
//!   `Option` must be absent from the value, never `null`.

use std::cmp::Ordering;

use serde_json::Value;

pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write(&map[key], out);
            }
            out.push('}');
        }
    }
}

/// JavaScript compares strings by UTF-16 code unit. That differs from byte order
/// only between U+E000..U+FFFF and the astral planes (which UTF-16 writes with
/// surrogates D800..DFFF).
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_number(n: &serde_json::Number, out: &mut String) {
    // JSON.parse makes every number a double; so must we before printing.
    match n.as_f64() {
        Some(f) if f.is_finite() => out.push_str(ryu_js::Buffer::new().format(f)),
        _ => out.push_str("null"),
    }
}

// serde_json escapes exactly what JSON.stringify escapes for well-formed text:
// the quote, the backslash, \b \f \n \r \t and \u00XX (lowercase) for the other
// control characters; nothing else, U+2028/U+2029 and DEL included.
fn write_string(s: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(s).expect("a string always serializes"));
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_sorted_at_every_depth() {
        let v = json!({ "b": 1, "a": { "z": [ { "y": 1, "x": 2 } ], "k": null } });
        assert_eq!(stable_stringify(&v), r#"{"a":{"k":null,"z":[{"x":2,"y":1}]},"b":1}"#);
    }

    #[test]
    fn astral_keys_sort_before_the_top_of_the_bmp_as_in_javascript() {
        // U+1F600 is D83D DE00 in UTF-16, below U+FF5E; in UTF-8 it is above.
        let v = json!({ "\u{ff5e}": 1, "\u{1f600}": 2 });
        assert_eq!(stable_stringify(&v), "{\"\u{1f600}\":2,\"\u{ff5e}\":1}");
        assert_eq!("\u{ff5e}".cmp("\u{1f600}"), Ordering::Less, "byte order would get this wrong");
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases = [
            ("1.0", "1"),
            ("-0", "0"),
            ("-0.0", "0"),
            ("1e21", "1e+21"),
            ("1e-7", "1e-7"),
            ("100000000000000000000", "100000000000000000000"),
            ("9007199254740993", "9007199254740992"),
            ("0.1", "0.1"),
            ("1E3", "1000"),
            ("5e-324", "5e-324"),
            ("123456789012345680000", "123456789012345680000"),
            ("1.5e300", "1.5e+300"),
            ("0.000001", "0.000001"),
        ];
        for (input, expected) in cases {
            let v: Value = serde_json::from_str(input).unwrap();
            assert_eq!(stable_stringify(&v), expected, "{input}");
        }
    }
}
