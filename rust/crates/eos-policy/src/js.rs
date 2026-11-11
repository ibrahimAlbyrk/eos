//! The JavaScript behaviour rules depend on: `new RegExp(pattern)` with
//! `.test()` and `.replace()`, `String(value)`, `JSON.stringify` and `trim`.
//!
//! Rules come from user data and were written against JavaScript, so a
//! pattern must compile, match and rewrite exactly as it does there: the
//! regex is compiled without flags and matched over UTF-16 code units
//! (`regress`), and a replacement expands JavaScript's `$` tokens.

use std::ops::Range;

use serde_json::Value;

/// A regex as `new RegExp(pattern)` builds it: no flags.
#[derive(Debug, Clone)]
pub struct JsRegex {
    re: regress::Regex,
}

/// One match: where it starts and what it and its groups hold, in UTF-16.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsMatch {
    /// The start in UTF-16 code units, as `RegExp#exec().index`.
    pub index: usize,
    pub whole: Vec<u16>,
    /// A group that took no part is `None`.
    pub groups: Vec<Option<Vec<u16>>>,
    pub named: Vec<(String, Option<Vec<u16>>)>,
}

impl JsRegex {
    /// `Err` is JavaScript's SyntaxError: the pattern is not a regex there.
    pub fn new(pattern: &str) -> Result<Self, String> {
        regress::Regex::with_flags(&as_code_units(pattern), regress::Flags::default())
            .map(|re| Self { re })
            .map_err(|e| e.to_string())
    }

    /// `re.test(text)`.
    pub fn test(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.re.find_from_ucs2(&units, 0).next().is_some()
    }

    /// `re.exec(text)`.
    pub fn exec(&self, text: &str) -> Option<JsMatch> {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.exec_units(&units)
    }

    fn exec_units(&self, units: &[u16]) -> Option<JsMatch> {
        let m = self.re.find_from_ucs2(units, 0).next()?;
        let slice = |r: &Range<usize>| units[r.clone()].to_vec();
        let named = m.named_groups().map(|(name, r)| (name.to_owned(), r.as_ref().map(slice))).collect();
        Some(JsMatch {
            index: m.range.start,
            whole: slice(&m.range),
            groups: m.captures.iter().map(|c| c.as_ref().map(slice)).collect(),
            named,
        })
    }

    /// `text.replace(re, template)`: the first match only, with
    /// `` $$ $& $` $' $n $nn $<name> `` expanded.
    pub fn replace(&self, text: &str, template: &str) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        let Some(m) = self.exec_units(&units) else { return text.to_owned() };
        let end = m.index + m.whole.len();
        let mut out: Vec<u16> = units[..m.index].to_vec();
        substitute(&m, &units[..m.index], &units[end..], template, &mut out);
        out.extend_from_slice(&units[end..]);
        String::from_utf16_lossy(&out)
    }
}

/// A flagless JavaScript pattern is a sequence of UTF-16 code units: a
/// character beyond the BMP is its two surrogates, each an atom of its own
/// (`😀+` repeats the second half, `[😀]` holds the two halves). The engine
/// reads such a character, and a `😀` pair of escapes, as one code
/// point that no code unit can equal, so both are rewritten into halves it
/// keeps apart: an empty group between them outside a class; inside a class,
/// the low half first (a pair escaped by hand inside a class is left as it is).
fn as_code_units(pattern: &str) -> std::borrow::Cow<'_, str> {
    if pattern.chars().all(|c| u32::from(c) <= 0xFFFF) && !pattern.contains("\\u") {
        return pattern.into();
    }
    let halves = |c: char| {
        let mut pair = [0u16; 2];
        c.encode_utf16(&mut pair);
        (pair[0], pair[1])
    };
    let mut out = String::with_capacity(pattern.len() + 32);
    let mut in_class = false;
    // The last thing written was a `\u` escape of a high surrogate, outside a class.
    let mut after_high = false;
    let astral = |out: &mut String, c: char, in_class: bool| {
        let (high, low) = halves(c);
        if in_class {
            // low, high, then the pair again: the engine joins that last one
            // into the code point, which matches nothing and so adds nothing.
            out.push_str(&format!("\\u{low:04X}\\u{high:04X}\\u{high:04X}\\u{low:04X}"));
        } else {
            out.push_str(&format!("\\u{high:04X}(?:)\\u{low:04X}"));
        }
    };
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        let was_after_high = std::mem::take(&mut after_high);
        if u32::from(c) > 0xFFFF {
            astral(&mut out, c, in_class);
        } else if c == '\\' {
            match chars.next() {
                None => out.push('\\'),
                // An escaped first half is that half.
                Some(next) if u32::from(next) > 0xFFFF => astral(&mut out, next, in_class),
                Some('u') => {
                    let mut hex = String::new();
                    while hex.len() < 4 && chars.peek().is_some_and(char::is_ascii_hexdigit) {
                        hex.extend(chars.next());
                    }
                    let unit = (hex.len() == 4).then(|| u16::from_str_radix(&hex, 16).ok()).flatten();
                    if was_after_high && unit.is_some_and(|u| (0xDC00..=0xDFFF).contains(&u)) {
                        out.push_str("(?:)");
                    }
                    out.push_str("\\u");
                    out.push_str(&hex);
                    after_high = !in_class && unit.is_some_and(|u| (0xD800..=0xDBFF).contains(&u));
                }
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
            }
        } else {
            match c {
                '[' if !in_class => in_class = true,
                ']' => in_class = false,
                _ => {}
            }
            out.push(c);
        }
    }
    out.into()
}

/// ECMAScript's GetSubstitution: appends `template` with its tokens expanded.
pub fn substitute(m: &JsMatch, before: &[u16], after: &[u16], template: &str, out: &mut Vec<u16>) {
    let t: Vec<u16> = template.encode_utf16().collect();
    let dollar = u16::from(b'$');
    let digit = |u: u16| (u16::from(b'0')..=u16::from(b'9')).contains(&u).then(|| usize::from(u - u16::from(b'0')));
    let mut i = 0;
    while i < t.len() {
        if t[i] != dollar || i + 1 >= t.len() {
            out.push(t[i]);
            i += 1;
            continue;
        }
        let next = t[i + 1];
        if next == dollar {
            out.push(dollar);
            i += 2;
        } else if next == u16::from(b'&') {
            out.extend_from_slice(&m.whole);
            i += 2;
        } else if next == u16::from(b'`') {
            out.extend_from_slice(before);
            i += 2;
        } else if next == u16::from(b'\'') {
            out.extend_from_slice(after);
            i += 2;
        } else if let Some(d1) = digit(next) {
            // Two digits when that names a group, else one; `$0` and unknown
            // numbers stay as written.
            let two = t.get(i + 2).copied().and_then(digit).map(|d2| d1 * 10 + d2);
            let (n, len) = match two {
                Some(n) if (1..=m.groups.len()).contains(&n) => (n, 3),
                _ => (d1, 2),
            };
            if (1..=m.groups.len()).contains(&n) {
                if let Some(g) = &m.groups[n - 1] {
                    out.extend_from_slice(g);
                }
            } else {
                out.extend_from_slice(&t[i..i + len]);
            }
            i += len;
        } else if next == u16::from(b'<') && !m.named.is_empty() {
            match t[i + 2..].iter().position(|u| *u == u16::from(b'>')) {
                Some(close) => {
                    let name = String::from_utf16_lossy(&t[i + 2..i + 2 + close]);
                    if let Some((_, Some(g))) = m.named.iter().find(|(n, _)| *n == name) {
                        out.extend_from_slice(g);
                    }
                    i += close + 3;
                }
                None => {
                    out.push(dollar);
                    i += 1;
                }
            }
        } else {
            out.push(dollar);
            i += 1;
        }
    }
}

// 2^53: every whole f64 below it prints as an integer.
const SAFE_INT: f64 = 9_007_199_254_740_992.0;

/// `String(n)` for a JSON number.
fn number_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64().filter(|i| i.unsigned_abs() <= 1 << 53) {
        return i.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.fract() == 0.0 && f.abs() < SAFE_INT {
        #[allow(clippy::cast_possible_truncation)]
        return (f as i64).to_string();
    }
    ryu_js::Buffer::new().format(f).to_owned()
}

/// `String(value)`.
pub fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_text(n),
        Value::String(s) => s.clone(),
        // `Array.prototype.join(",")`: null prints as nothing.
        Value::Array(items) => {
            items.iter().map(|v| if v.is_null() { String::new() } else { to_string(v) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// Whether `if (value)` runs.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `JSON.stringify(value)`: as `serde_json` writes it, except that a number
/// prints the way JavaScript prints it (`1`, not `1.0`; `1e+21`).
pub fn json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

/// [`json_stringify`] for an object held as a record.
pub fn json_stringify_record(record: &eos_contracts::UnknownRecord) -> String {
    let mut out = String::from("{");
    for (i, (key, item)) in record.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_text(key, &mut out);
        out.push(':');
        write_json(item, &mut out);
    }
    out.push('}');
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Number(n) => out.push_str(&number_text(n)),
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
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_text(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
        Value::String(s) => write_text(s, out),
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    }
}

fn write_text(text: &str, out: &mut String) {
    // A string always serializes; the fallback is unreachable.
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()));
}

/// What JavaScript's `trim` removes.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn values_print_as_javascript_prints_them() {
        assert_eq!(to_string(&json!(1.0)), "1");
        assert_eq!(to_string(&json!(1.5)), "1.5");
        assert_eq!(to_string(&json!(1e21)), "1e+21");
        assert_eq!(to_string(&json!(null)), "null");
        assert_eq!(to_string(&json!(["a", null, 2, ["b", true]])), "a,,2,b,true");
        assert_eq!(to_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(
            json_stringify(&json!({"n": 2.0, "s": "a\"b\n", "l": [1e21, null, false]})),
            r#"{"n":2,"s":"a\"b\n","l":[1e+21,null,false]}"#
        );
    }

    #[test]
    fn truthiness() {
        for v in [json!(null), json!(false), json!(0), json!(0.0), json!("")] {
            assert!(!truthy(&v), "{v}");
        }
        for v in [json!(true), json!(1), json!("0"), json!([]), json!({})] {
            assert!(truthy(&v), "{v}");
        }
    }

    #[test]
    fn trim_follows_javascript_not_unicode() {
        assert_eq!(trim("\u{feff} ls \u{a0}\n"), "ls");
        assert_eq!(trim("\u{85}ls"), "\u{85}ls");
    }

    #[test]
    fn the_shipped_rules_match_and_rewrite() {
        let needs_timeout = JsRegex::new(r"(^|\s)curl(?!.*--max-time)").expect("compiles");
        let rewrite = JsRegex::new(r"(^|\s)curl\b").expect("compiles");
        assert!(needs_timeout.test("time curl -s x"));
        assert!(!needs_timeout.test("curl --max-time 5 x"));
        assert_eq!(rewrite.replace("time curl -s x", "$1curl --max-time 10"), "time curl --max-time 10 -s x");
        for bad in ["(?i)rm", "*.ts", "(", "a++", "[z-a]", "a\\"] {
            assert!(JsRegex::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_character_beyond_the_bmp_is_two_code_units() {
        assert_eq!(as_code_units(r"a\\b[c]"), r"a\\b[c]");
        assert_eq!(as_code_units(r"\😀x\\😀\d"), r"\uD83D(?:)\uDE00x\\\uD83D(?:)\uDE00\d");
        let test = |pattern: &str, text: &str| JsRegex::new(pattern).expect("compiles").test(text);
        assert!(test("é|😀", "😀!"));
        assert!(test("^.{3}$", "😀!"));
        assert!(test(r"^\😀$", "😀"));
        assert!(test(r"^😀$", "😀"), "a pair of escapes is two units too");
        assert!(test(r"^😀+$", "😀"));
        assert!(!test("^😀+$", "😀😀"), "the quantifier repeats the second half only");
        assert!(!test("^[😀]$", "😀"), "a class holds the halves, one at a time");
        assert!(test("^[😀😁a][😀😁]$", "😀"));
        assert!(test("^[😁😀]{2}a$", "😀a"));
        assert!(test(r"^A\x41$", "AA"));
    }
}
