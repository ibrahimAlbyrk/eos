//! Boundary validation: what Zod's `safeParse` did for a request body.
//!
//! serde checks shapes and types; [`Validate`] checks what a type cannot say
//! (lengths, ranges, patterns, refinements). [`parse`] runs both and reports
//! failures in the words today's daemon uses, because they reach the client
//! as text: `400 {"error": "invalid request: <path>: <message>; …"}`
//! (`manager/middleware/validate.ts`). The structured Zod issue list never
//! leaves the daemon, so only path and message are kept here.

use std::fmt::{self, Write as _};

use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// One failed check: where, and Zod's sentence for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// Object keys and array indexes from the body's root, joined with `.` on the wire.
    pub path: Vec<String>,
    pub message: String,
}

impl fmt::Display for Issue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path.join("."), self.message)
    }
}

/// A body that failed validation. Answers `400` with [`ValidationError::message`]
/// as the `error` field.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.message())]
pub struct ValidationError {
    pub issues: Vec<Issue>,
}

impl ValidationError {
    pub const STATUS: u16 = 400;

    /// `invalid request: a.b: Required; c: Expected string, received number`
    pub fn message(&self) -> String {
        let mut out = String::from("invalid request: ");
        for (i, issue) in self.issues.iter().enumerate() {
            if i > 0 {
                out.push_str("; ");
            }
            let _ = write!(out, "{issue}");
        }
        out
    }
}

/// Collects issues while a value checks itself, tracking the path.
#[derive(Debug, Default)]
pub struct Issues {
    path: Vec<String>,
    list: Vec<Issue>,
}

impl Issues {
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn into_vec(self) -> Vec<Issue> {
        self.list
    }

    /// Runs `f` one object key deeper.
    pub fn at(&mut self, key: &str, f: impl FnOnce(&mut Self)) {
        self.path.push(key.to_owned());
        f(self);
        self.path.pop();
    }

    /// Runs `f` one array index deeper.
    pub fn idx(&mut self, index: usize, f: impl FnOnce(&mut Self)) {
        self.path.push(index.to_string());
        f(self);
        self.path.pop();
    }

    pub fn push(&mut self, message: impl Into<String>) {
        self.list.push(Issue { path: self.path.clone(), message: message.into() });
    }

    /// An issue on a sibling key of the current object (Zod's `path: ["key"]` in a refinement).
    pub fn push_at(&mut self, key: &str, message: impl Into<String>) {
        self.at(key, |cx| cx.push(message));
    }

    // Zod counts string length in UTF-16 code units.
    pub fn str_min(&mut self, v: &str, min: usize) {
        if utf16_len(v) < min {
            self.push(format!("String must contain at least {min} character(s)"));
        }
    }

    pub fn str_max(&mut self, v: &str, max: usize) {
        if utf16_len(v) > max {
            self.push(format!("String must contain at most {max} character(s)"));
        }
    }

    pub fn str_len(&mut self, v: &str, len: usize) {
        if utf16_len(v) != len {
            self.push(format!("String must contain exactly {len} character(s)"));
        }
    }

    pub fn regex(&mut self, v: &str, re: &regress::Regex, message: Option<&str>) {
        if re.find(v).is_none() {
            self.push(message.unwrap_or("Invalid"));
        }
    }

    /// `z.string().url()`: whatever `new URL(v)` accepts. Approximated as
    /// "has a scheme and something after it", which covers every caller.
    pub fn url(&mut self, v: &str) {
        if re!(r"^[A-Za-z][A-Za-z0-9+.-]*:(//[^\s/?#]+|[^\s/])").find(v).is_none() {
            self.push("Invalid url");
        }
    }

    pub fn uuid(&mut self, v: &str) {
        let re = re!(r"^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$");
        if re.find(v).is_none() {
            self.push("Invalid uuid");
        }
    }

    /// `z.string().datetime()`: UTC only, `Z` required, any fraction.
    pub fn datetime(&mut self, v: &str) {
        let re = re!(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$");
        if re.find(v).is_none() {
            self.push("Invalid datetime");
        }
    }

    pub fn starts_with(&mut self, v: &str, prefix: &str) {
        if !v.starts_with(prefix) {
            self.push(format!("Invalid input: must start with \"{prefix}\""));
        }
    }

    pub fn int_min(&mut self, v: i64, min: i64, inclusive: bool) {
        if v < min || (!inclusive && v == min) {
            self.push(format!("Number must be greater than {}{min}", if inclusive { "or equal to " } else { "" }));
        }
    }

    pub fn int_max(&mut self, v: i64, max: i64, inclusive: bool) {
        if v > max || (!inclusive && v == max) {
            self.push(format!("Number must be less than {}{max}", if inclusive { "or equal to " } else { "" }));
        }
    }

    pub fn num_min(&mut self, v: crate::Num, min: f64, inclusive: bool) {
        if v.0 < min || (!inclusive && v.0 == min) {
            let min = crate::Num(min);
            self.push(format!("Number must be greater than {}{min}", if inclusive { "or equal to " } else { "" }));
        }
    }

    pub fn num_max(&mut self, v: crate::Num, max: f64, inclusive: bool) {
        if v.0 > max || (!inclusive && v.0 == max) {
            let max = crate::Num(max);
            self.push(format!("Number must be less than {}{max}", if inclusive { "or equal to " } else { "" }));
        }
    }

    pub fn arr_min(&mut self, len: usize, min: usize) {
        if len < min {
            self.push(format!("Array must contain at least {min} element(s)"));
        }
    }

    pub fn arr_max(&mut self, len: usize, max: usize) {
        if len > max {
            self.push(format!("Array must contain at most {max} element(s)"));
        }
    }
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) fn compile(pattern: &str, flags: &str) -> regress::Regex {
    #[allow(clippy::expect_used)]
    regress::Regex::with_flags(pattern, flags).expect("a pattern literal from this crate")
}

/// A JavaScript regex literal, compiled once.
macro_rules! re {
    ($pattern:literal) => {
        $crate::validate::re!($pattern, "")
    };
    ($pattern:literal, $flags:literal) => {{
        static RE: std::sync::OnceLock<regress::Regex> = std::sync::OnceLock::new();
        RE.get_or_init(|| $crate::validate::compile($pattern, $flags))
    }};
}
pub(crate) use re;

/// The constraints of a wire type beyond its shape.
pub trait Validate {
    fn validate(&self, _cx: &mut Issues) {}
}

macro_rules! no_rules {
    ($($t:ty),* $(,)?) => {$( impl Validate for $t {} )*};
}
no_rules!(String, bool, i64, crate::Num, Value, (), serde_json::Map<String, Value>);

impl<const V: bool> Validate for crate::BoolLit<V> {}
impl<const V: i64> Validate for crate::IntLit<V> {}

impl<T: Validate> Validate for Option<T> {
    fn validate(&self, cx: &mut Issues) {
        if let Some(v) = self {
            v.validate(cx);
        }
    }
}

impl<T: Validate> Validate for Box<T> {
    fn validate(&self, cx: &mut Issues) {
        (**self).validate(cx);
    }
}

impl<T: Validate> Validate for Vec<T> {
    fn validate(&self, cx: &mut Issues) {
        for (i, v) in self.iter().enumerate() {
            cx.idx(i, |cx| v.validate(cx));
        }
    }
}

impl<T: Validate> Validate for IndexMap<String, T> {
    fn validate(&self, cx: &mut Issues) {
        for (k, v) in self {
            cx.at(k, |cx| v.validate(cx));
        }
    }
}

/// Reads a JSON value as `T`: shape and types only. For data that is not a
/// request (a stored record, another computer's answer).
pub fn read<T: DeserializeOwned>(value: &Value) -> Result<T, ValidationError> {
    serde_path_to_error::deserialize(value).map_err(|e| {
        let path = e.path().iter().filter_map(segment).collect();
        ValidationError { issues: vec![from_serde(path, &e.inner().to_string())] }
    })
}

/// Reads a JSON value as `T` and checks its constraints: `schema.safeParse(value)`.
///
/// A type error stops at the first one (serde's behaviour; Zod lists them
/// all); constraint failures are all reported.
pub fn parse<T: DeserializeOwned + Validate>(value: &Value) -> Result<T, ValidationError> {
    let parsed: T = read(value)?;
    check(&parsed)?;
    Ok(parsed)
}

/// Checks the constraints of a value that is already typed (a record about
/// to be stored): every failure is reported.
pub fn check<T: Validate + ?Sized>(value: &T) -> Result<(), ValidationError> {
    let mut cx = Issues::default();
    value.validate(&mut cx);
    if cx.is_empty() { Ok(()) } else { Err(ValidationError { issues: cx.into_vec() }) }
}

fn segment(seg: &serde_path_to_error::Segment) -> Option<String> {
    use serde_path_to_error::Segment;
    match seg {
        Segment::Seq { index } => Some(index.to_string()),
        Segment::Map { key } => Some(key.clone()),
        Segment::Enum { .. } | Segment::Unknown => None,
    }
}

/// Rewords a serde error the way Zod's default error map would.
fn from_serde(mut path: Vec<String>, message: &str) -> Issue {
    let text = if let Some(field) = between(message, "missing field `", "`") {
        path.push(field.to_owned());
        "Required".to_owned()
    } else if let Some(rest) = message.strip_prefix("invalid type: ") {
        match rest.split_once(", expected ") {
            Some((got, want)) => invalid_type(got, want),
            None => "Invalid input".to_owned(),
        }
    } else if let Some(rest) = message.strip_prefix("unknown variant `") {
        match rest.split_once("`, ") {
            Some((got, list)) => format!("Invalid enum value. Expected {}, received '{got}'", quoted_list(list)),
            None => "Invalid input".to_owned(),
        }
    } else if let Some(field) = between(message, "unknown field `", "`") {
        // serde points at the key; Zod reports the object that holds it.
        if path.last().is_some_and(|last| last == field) {
            path.pop();
        }
        format!("Unrecognized key(s) in object: '{field}'")
    } else if let Some(want) = message.strip_prefix("invalid literal, expected ") {
        format!("Invalid literal value, expected {want}")
    } else if message.starts_with("data did not match any variant") {
        "Invalid input".to_owned()
    } else {
        message.to_owned()
    };
    Issue { path, message: text }
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(start)?;
    rest.find(end).map(|i| &rest[..i])
}

fn invalid_type(got: &str, want: &str) -> String {
    let received = match got {
        "null" | "unit value" => "null",
        "sequence" => "array",
        "map" => "object",
        g if g.starts_with("string") => "string",
        g if g.starts_with("boolean") => "boolean",
        g if g.starts_with("integer") || g.starts_with("floating point") => "number",
        _ => return "Invalid input".to_owned(),
    };
    let expected = match want {
        "a string" | "a borrowed string" => "string",
        "a boolean" => "boolean",
        "a sequence" => "array",
        "a map" => "object",
        "i64" | "f64" | "u64" | "i32" | "u32" => {
            if want == "i64" && got.starts_with("floating point") {
                return "Expected integer, received float".to_owned();
            }
            "number"
        }
        w if w.starts_with("struct ") => "object",
        _ => return "Invalid input".to_owned(),
    };
    format!("Expected {expected}, received {received}")
}

/// serde: "expected `a`", "expected `a` or `b`", "expected one of `a`, `b`, `c`".
/// Zod: `'a' | 'b' | 'c'`.
fn quoted_list(list: &str) -> String {
    let mut out = Vec::new();
    let mut rest = list;
    while let Some(start) = rest.find('`') {
        let Some(len) = rest[start + 1..].find('`') else { break };
        out.push(format!("'{}'", &rest[start + 1..start + 1 + len]));
        rest = &rest[start + len + 2..];
    }
    out.join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        display_name: String,
        #[serde(default)]
        tags: Vec<String>,
        kind: Kind,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum Kind {
        File,
        Folder,
    }

    impl Validate for Body {
        fn validate(&self, cx: &mut Issues) {
            cx.at("displayName", |cx| cx.str_min(&self.display_name, 1));
            cx.at("tags", |cx| {
                cx.arr_max(self.tags.len(), 2);
                for (i, v) in self.tags.iter().enumerate() {
                    cx.idx(i, |cx| cx.regex(v, re!(r"^[a-z]+$"), Some("lowercase letters")));
                }
            });
            let _ = matches!(self.kind, Kind::File | Kind::Folder);
        }
    }

    fn message(v: Value) -> String {
        parse::<Body>(&v).unwrap_err().message()
    }

    #[test]
    fn the_error_text_is_the_daemons() {
        assert_eq!(message(json!({"kind": "file"})), "invalid request: displayName: Required");
        assert_eq!(
            message(json!({"displayName": 5, "kind": "file"})),
            "invalid request: displayName: Expected string, received number"
        );
        assert_eq!(
            message(json!({"displayName": "a", "kind": "pipe"})),
            "invalid request: kind: Invalid enum value. Expected 'file' | 'folder', received 'pipe'"
        );
        assert_eq!(
            message(json!({"displayName": "", "kind": "file", "tags": ["ok", "No", "x"]})),
            "invalid request: displayName: String must contain at least 1 character(s); \
             tags: Array must contain at most 2 element(s); tags.1: lowercase letters"
        );
    }

    #[test]
    fn length_counts_utf16_units() {
        let mut cx = Issues::default();
        cx.str_max("\u{1f600}", 1);
        assert_eq!(cx.into_vec().len(), 1);
    }
}
