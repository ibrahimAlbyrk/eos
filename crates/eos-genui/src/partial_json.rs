//! Tolerant JSON readers for visual answers.
//!
//! [`parse_partial_json`] reads a growing prefix of a JSON document (a `present`
//! call while the model is still writing it) and returns only what has settled:
//! - an object keeps its complete key/values, plus nested objects and arrays that
//!   are still being written (under the same rules);
//! - an array keeps only complete elements, so data rows appear whole;
//! - a string still being written is dropped, except under the top-level keys in
//!   `partial_keys`, where the prefix is kept so markup streams;
//! - a number or literal at the very end is dropped (more digits may follow).
//!
//! [`parse_loose_json`] reads one complete value and forgives what models often
//! write in markup attributes: single quotes, unquoted keys, trailing commas,
//! comments.

use crate::utf16::{self, ascii, unit};
use crate::value::{Object, Value};

/// Top-level keys whose string value is kept while still incomplete.
pub const DEFAULT_PARTIAL_KEYS: &[&str] = &["ui"];

const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PartialJson {
    /// `None` until the first value starts to settle.
    pub value: Option<Value>,
    /// True once the whole document has been read.
    pub complete: bool,
    /// A real syntax error (not just truncation); what was read before it is kept.
    pub error: Option<String>,
}

/// Why [`parse_loose_json`] rejected its input; `at` counts UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LooseJsonError {
    pub message: String,
    pub at: usize,
}

pub fn parse_partial_json(prefix: &str, partial_keys: &[&str]) -> PartialJson {
    let s = utf16::units(prefix);
    let mut st = Reader::new(&s, false, true, partial_keys);
    let r = st.value(0, true);
    if r.done && !st.stopped {
        st.skip_ws();
        st.fail_on_trailing();
    }
    PartialJson { value: r.v, complete: r.done && st.error.is_none(), error: st.error }
}

pub fn parse_loose_json(text: &str) -> Result<Value, LooseJsonError> {
    parse_loose_units(&utf16::units(text))
}

pub(crate) fn parse_loose_units(s: &[u16]) -> Result<Value, LooseJsonError> {
    let mut st = Reader::new(s, true, false, &[]);
    let r = st.value(0, false);
    if st.error.is_none() && r.done {
        st.skip_ws();
        st.fail_on_trailing();
    }
    if let Some(message) = st.error {
        return Err(LooseJsonError { message, at: st.error_at });
    }
    match r.v {
        Some(v) if r.done => Ok(v),
        _ => Err(LooseJsonError { message: "unexpected end of JSON".to_owned(), at: s.len() }),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Object,
    Array,
    String,
    Scalar,
    None,
}

// A read value. `done` false means the input ended (or broke) inside it; a
// container or string still carries what was read so the parent can decide
// whether to keep it.
struct Read {
    v: Option<Value>,
    done: bool,
    kind: Kind,
}

impl Read {
    const NONE: Read = Read { v: None, done: false, kind: Kind::None };

    fn done(v: Value, kind: Kind) -> Read {
        Read { v: Some(v), done: true, kind }
    }

    fn open(v: Value, kind: Kind) -> Read {
        Read { v: Some(v), done: false, kind }
    }
}

struct Reader<'a> {
    s: &'a [u16],
    i: usize,
    loose: bool,
    partial: bool,
    stopped: bool,
    error: Option<String>,
    error_at: usize,
    partial_keys: &'a [&'a str],
}

impl<'a> Reader<'a> {
    fn new(s: &'a [u16], loose: bool, partial: bool, partial_keys: &'a [&'a str]) -> Self {
        Reader { s, i: 0, loose, partial, stopped: false, error: None, error_at: 0, partial_keys }
    }

    fn fail(&mut self, message: String) {
        if self.error.is_none() {
            self.error = Some(message);
            self.error_at = self.i;
        }
        self.stopped = true;
    }

    fn fail_on_trailing(&mut self) {
        if self.i < self.s.len() {
            self.fail(format!("unexpected \"{}\" after the value", self.here()));
        }
    }

    // The one code unit at the cursor, as an error message quotes it.
    fn here(&self) -> String {
        utf16::text(&self.s[self.i..self.i + 1])
    }

    fn at_end(&self) -> bool {
        self.stopped || self.i >= self.s.len()
    }

    fn peek(&self) -> u8 {
        self.s.get(self.i).map_or(0, |u| ascii(*u))
    }

    fn skip_ws(&mut self) {
        let s = self.s;
        while self.i < s.len() {
            match ascii(s[self.i]) {
                b' ' | b'\t' | b'\n' | b'\r' => self.i += 1,
                b'/' if self.loose && utf16::is(s, self.i + 1, '/') => {
                    self.i = utf16::find_unit(s, unit('\n'), self.i + 2).map_or(s.len(), |nl| nl + 1);
                }
                b'/' if self.loose && utf16::is(s, self.i + 1, '*') => {
                    self.i = utf16::find(s, "*/", self.i + 2).map_or(s.len(), |close| close + 2);
                }
                _ => break,
            }
        }
    }

    fn value(&mut self, depth: usize, top_level: bool) -> Read {
        self.skip_ws();
        if self.at_end() {
            return Read::NONE;
        }
        if depth > MAX_DEPTH {
            self.fail("nested too deeply".to_owned());
            return Read::NONE;
        }
        match self.peek() {
            b'{' => self.object(depth, top_level),
            b'[' => self.array(depth),
            b'"' => self.string(),
            b'\'' if self.loose => self.string(),
            b'-' | b'0'..=b'9' => self.number(),
            _ => self.literal(),
        }
    }

    fn object(&mut self, depth: usize, top_level: bool) -> Read {
        self.i += 1; // {
        let mut obj = Object::new();
        loop {
            self.skip_ws();
            if self.at_end() {
                break;
            }
            if self.peek() == b'}' {
                self.i += 1;
                return Read::done(Value::Object(obj), Kind::Object);
            }
            let Some(k) = self.key() else { break };
            self.skip_ws();
            if self.at_end() {
                break;
            }
            if self.peek() != b':' {
                self.fail(format!("expected \":\" after key \"{k}\""));
                break;
            }
            self.i += 1;
            let r = self.value(depth + 1, false);
            if !r.done {
                // The value is still being written (or broke). Containers keep what has
                // settled; a string only under a streaming key of the top-level object.
                let keep = match r.kind {
                    Kind::Object | Kind::Array => true,
                    Kind::String => top_level && self.partial_keys.contains(&k.as_str()),
                    Kind::Scalar | Kind::None => false,
                };
                if let (true, Some(v)) = (keep, r.v) {
                    obj.insert(k, v);
                }
                break;
            }
            if let Some(v) = r.v {
                obj.insert(k.clone(), v);
            }
            self.skip_ws();
            if self.at_end() {
                break;
            }
            match self.peek() {
                b',' => {
                    self.i += 1;
                    if self.loose {
                        self.skip_ws();
                        if self.peek() == b'}' {
                            self.i += 1;
                            return Read::done(Value::Object(obj), Kind::Object);
                        }
                    }
                }
                b'}' => {
                    self.i += 1;
                    return Read::done(Value::Object(obj), Kind::Object);
                }
                _ => {
                    self.fail(format!("expected \",\" or \"}}\" after \"{k}\""));
                    break;
                }
            }
        }
        Read::open(Value::Object(obj), Kind::Object)
    }

    fn key(&mut self) -> Option<String> {
        let c = self.peek();
        if c == b'"' || (self.loose && c == b'\'') {
            let r = self.string();
            return match r.v {
                Some(Value::String(k)) if r.done => Some(k),
                _ => None,
            };
        }
        if self.loose && (c.is_ascii_alphabetic() || c == b'_' || c == b'$') {
            let start = self.i;
            while self.i < self.s.len() && is_bare_key_unit(self.s[self.i]) {
                self.i += 1;
            }
            if self.i >= self.s.len() && self.partial {
                return None;
            }
            return Some(utf16::text(&self.s[start..self.i]));
        }
        self.fail(format!("expected a quoted key, got \"{}\"", self.here()));
        None
    }

    fn array(&mut self, depth: usize) -> Read {
        self.i += 1; // [
        let mut arr = Vec::new();
        loop {
            self.skip_ws();
            if self.at_end() {
                break;
            }
            if self.peek() == b']' {
                self.i += 1;
                return Read::done(Value::Array(arr), Kind::Array);
            }
            let r = self.value(depth + 1, false);
            // Elements count only once complete, so a row never renders half-written.
            match r.v {
                Some(v) if r.done => arr.push(v),
                _ => break,
            }
            self.skip_ws();
            if self.at_end() {
                break;
            }
            match self.peek() {
                b',' => {
                    self.i += 1;
                    if self.loose {
                        self.skip_ws();
                        if self.peek() == b']' {
                            self.i += 1;
                            return Read::done(Value::Array(arr), Kind::Array);
                        }
                    }
                }
                b']' => {
                    self.i += 1;
                    return Read::done(Value::Array(arr), Kind::Array);
                }
                _ => {
                    self.fail("expected \",\" or \"]\" in array".to_owned());
                    break;
                }
            }
        }
        Read::open(Value::Array(arr), Kind::Array)
    }

    fn string(&mut self) -> Read {
        let s = self.s;
        let quote = s[self.i];
        self.i += 1;
        let mut out: Vec<u16> = Vec::new();
        let mut run_start = self.i;
        let open = |out: &[u16]| Read::open(Value::String(utf16::text(out)), Kind::String);
        while self.i < s.len() {
            let c = s[self.i];
            if c == quote {
                let run = &s[run_start..self.i];
                self.i += 1;
                // Most strings have no escape: read them straight from the input.
                if out.is_empty() {
                    return Read::done(Value::String(utf16::text(run)), Kind::String);
                }
                out.extend_from_slice(run);
                return Read::done(Value::String(utf16::text(&out)), Kind::String);
            }
            if c == unit('\\') {
                out.extend_from_slice(&s[run_start..self.i]);
                let Some(&e) = s.get(self.i + 1) else {
                    // A lone trailing backslash: the escape is still being written.
                    self.i = s.len();
                    return open(&out);
                };
                if e == unit('u') {
                    let hex = &s[(self.i + 2).min(s.len())..(self.i + 6).min(s.len())];
                    let all_hex = hex.iter().all(|u| ascii(*u).is_ascii_hexdigit());
                    if hex.len() < 4 && self.i + 2 + hex.len() >= s.len() && all_hex {
                        self.i = s.len();
                        return open(&out);
                    }
                    if hex.len() != 4 || !all_hex {
                        self.fail("bad \\u escape in string".to_owned());
                        return open(&out);
                    }
                    out.push(
                        hex.iter().fold(0u16, |n, u| n * 16 + (char::from(ascii(*u)).to_digit(16).unwrap_or(0) as u16)),
                    );
                    self.i += 6;
                } else if let Some(plain) = escape(e) {
                    out.push(plain);
                    self.i += 2;
                } else if self.loose {
                    out.push(e);
                    self.i += 2;
                } else {
                    self.fail(format!("bad escape \\{} in string", utf16::text(&[e])));
                    return open(&out);
                }
                run_start = self.i;
                continue;
            }
            if c == unit('\n') && !self.loose {
                self.fail("unescaped newline in string".to_owned());
                out.extend_from_slice(&s[run_start..self.i]);
                return open(&out);
            }
            self.i += 1;
        }
        out.extend_from_slice(&s[run_start..self.i]);
        // A high surrogate at the cut is half a character — drop it.
        if out.last().is_some_and(|u| (0xD800..=0xDBFF).contains(u)) {
            out.pop();
        }
        open(&out)
    }

    fn number(&mut self) -> Read {
        let s = self.s;
        let start = self.i;
        while self.i < s.len() && matches!(ascii(s[self.i]), b'-' | b'+' | b'0'..=b'9' | b'.' | b'e' | b'E') {
            self.i += 1;
        }
        if self.i >= s.len() && self.partial {
            return Read { v: None, done: false, kind: Kind::Scalar };
        }
        let raw: String = s[start..self.i].iter().map(|u| char::from(ascii(*u))).collect();
        if !is_json_number(raw.as_bytes()) {
            self.i = start;
            self.fail(format!("bad number \"{raw}\""));
            return Read::NONE;
        }
        Read::done(Value::Number(raw.parse::<f64>().unwrap_or(f64::NAN)), Kind::Scalar)
    }

    fn literal(&mut self) -> Read {
        let s = self.s;
        let rest = &s[self.i..(self.i + 5).min(s.len())];
        for (word, value) in [("true", Value::Bool(true)), ("false", Value::Bool(false)), ("null", Value::Null)] {
            if utf16::starts_with(rest, 0, word) {
                self.i += word.len();
                return Read::done(value, Kind::Scalar);
            }
            let is_prefix = rest.len() <= word.len() && rest.iter().zip(word.bytes()).all(|(u, b)| *u == u16::from(b));
            if self.partial && self.i + rest.len() >= s.len() && is_prefix {
                self.i = s.len();
                return Read { v: None, done: false, kind: Kind::Scalar };
            }
        }
        self.fail(format!("unexpected \"{}\"", self.here()));
        Read::NONE
    }
}

fn is_bare_key_unit(u: u16) -> bool {
    let c = ascii(u);
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c == b'-'
}

fn escape(e: u16) -> Option<u16> {
    Some(match ascii(e) {
        b'"' => unit('"'),
        b'\'' => unit('\''),
        b'\\' => unit('\\'),
        b'/' => unit('/'),
        b'b' => 0x08,
        b'f' => 0x0C,
        b'n' => unit('\n'),
        b'r' => unit('\r'),
        b't' => unit('\t'),
        _ => return None,
    })
}

// ^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$
fn is_json_number(b: &[u8]) -> bool {
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            digits(&mut i);
        }
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_what_has_settled() {
        let r = parse_partial_json(r#"{"title":"Kad","data":{"places":[{"id":"a"},{"id":"#, DEFAULT_PARTIAL_KEYS);
        assert!(!r.complete);
        assert_eq!(r.error, None);
        let v = r.value.expect("an object");
        assert_eq!(v.get("title").and_then(Value::as_str), Some("Kad"));
        assert_eq!(v.get("data").and_then(|d| d.get("places")).and_then(Value::as_array).map(<[Value]>::len), Some(1));
    }

    #[test]
    fn a_streaming_key_keeps_its_prefix() {
        let r = parse_partial_json(r#"{"ui":"<Card of=\"pl"#, DEFAULT_PARTIAL_KEYS);
        assert_eq!(r.value.as_ref().and_then(|v| v.get("ui")).and_then(Value::as_str), Some("<Card of=\"pl"));
    }

    #[test]
    fn loose_json_forgives_model_habits() {
        let v = parse_loose_json("{a: 'x', /* c */ b: [1, 2,], }").expect("loose json");
        assert_eq!(v.get("a").and_then(Value::as_str), Some("x"));
        assert_eq!(v.get("b").and_then(Value::as_array).map(<[Value]>::len), Some(2));
        let e = parse_loose_json("{a: }").expect_err("no value");
        assert_eq!((e.message.as_str(), e.at), ("unexpected \"}\"", 4));
    }

    #[test]
    fn nesting_is_bounded() {
        let deep = "[".repeat(100_000);
        assert_eq!(parse_partial_json(&deep, DEFAULT_PARTIAL_KEYS).error.as_deref(), Some("nested too deeply"));
    }
}
