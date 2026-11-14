//! Problems are phrased for the model to fix in one more call:
//!
//! ```text
//! data.places[3].rating: 6.2 is outside 0–5
//! ui line 4 <Carousel of="places">: 11 items, max 8 — paginate or filter
//! ```

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::limits::IDENT_RE;
use super::schema::{Code, Issue, Segment, Sized};
use crate::js;
use crate::re::is_match;
use crate::value::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewProblem {
    pub path: String,
    pub message: String,
}

impl ViewProblem {
    pub(crate) fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        ViewProblem { path: path.into(), message: message.into() }
    }
}

pub fn format_problem(p: &ViewProblem) -> String {
    format!("{}: {}", p.path, p.message)
}

/// The text a rejected call returns to the model.
pub fn format_problems(problems: &[ViewProblem]) -> String {
    let mut lines =
        vec![format!("{} problem{} — nothing rendered", problems.len(), if problems.len() == 1 { "" } else { "s" })];
    lines.extend(problems.iter().map(|p| format!("· {}", format_problem(p))));
    lines.push("fix and call present again".to_owned());
    lines.join("\n")
}

/// A value as a problem quotes it: JSON, cut to 40 characters.
pub(crate) fn show(v: Option<&Value>) -> String {
    const MAX: usize = 40;
    match v {
        None => "missing".to_owned(),
        Some(Value::String(s)) if js::len16(s) > MAX => js::quote_head16(s, MAX - 1, "…"),
        Some(Value::String(s)) => js::quote(s),
        Some(other) => {
            let s = js::stringify(other);
            if js::len16(&s) > MAX { format!("{}…", js::head16(&s, MAX - 1)) } else { s }
        }
    }
}

/// `base` + a path into data: `.name` for identifiers, `[3]` and `["odd key"]` otherwise.
pub(crate) fn data_path(base: &str, path: &[Segment]) -> String {
    let mut out = base.to_owned();
    for seg in path {
        match seg {
            Segment::Index(i) => out.push_str(&format!("[{i}]")),
            Segment::Key(k) if is_match(&IDENT_RE, k) => out.push_str(&format!(".{k}")),
            Segment::Key(k) => out.push_str(&format!("[{}]", js::quote(k))),
        }
    }
    out
}

pub(crate) fn key_path(base: &str, key: &str) -> String {
    data_path(base, &[Segment::Key(key.to_owned())])
}

fn get_at<'a>(root: Option<&'a Value>, path: &[Segment]) -> Option<&'a Value> {
    path.iter().try_fold(root?, |cur, seg| match (cur, seg) {
        (Value::Object(o), Segment::Key(k)) => o.get(k),
        (Value::Object(o), Segment::Index(i)) => o.get(&i.to_string()),
        (Value::Array(a), Segment::Index(i)) => a.get(*i),
        (Value::Array(a), Segment::Key(k)) => {
            k.parse::<usize>().ok().filter(|i| i.to_string() == *k).and_then(|i| a.get(i))
        }
        _ => None,
    })
}

fn article(expected: &str) -> &str {
    match expected {
        "array" => "a list",
        "object" => "an object",
        "string" => "text",
        "number" => "a number",
        "boolean" => "true or false",
        "integer" => "a whole number",
        other => other,
    }
}

// A message that starts with "is " follows the offending value: "6.2 is outside 0–5".
pub(crate) fn with_value(message: &str, value: Option<&Value>) -> String {
    if !message.starts_with("is ") {
        return message.to_owned();
    }
    match value {
        None => format!("value {message}"),
        Some(_) => format!("{} {message}", show(value)),
    }
}

fn phrased(message: &str) -> bool {
    message.starts_with("is ") || message.starts_with("must")
}

/// One schema issue → one model-readable problem at `base` + the issue path.
pub(crate) fn issue_problems(base: &str, root: Option<&Value>, issues: &[Issue]) -> Vec<ViewProblem> {
    let mut out: Vec<ViewProblem> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for issue in issues {
        let path = data_path(base, &issue.path);
        let value = get_at(root, &issue.path);
        let message = if value.is_none() && matches!(issue.code, Code::InvalidType | Code::InvalidUnion) {
            "is required".to_owned()
        } else {
            issue_message(issue, value)
        };
        if seen.insert((path.clone(), message.clone())) {
            out.push(ViewProblem { path, message });
        }
    }
    out
}

fn issue_message(issue: &Issue, value: Option<&Value>) -> String {
    let bound = js::number_to_string(issue.bound);
    match issue.code {
        Code::InvalidType if issue.received == "undefined" => format!("is required ({})", article(&issue.expected)),
        Code::InvalidType if issue.message.starts_with("Expected") => {
            format!("must be {}, got {}", article(&issue.expected), show(value))
        }
        Code::InvalidEnumValue => format!("{} is not one of {}", show(value), issue.options.join(", ")),
        Code::InvalidLiteral => format!("{} must be {}", show(value), js::quote(&issue.expected)),
        Code::InvalidUnionDiscriminator => {
            format!("{} is not an entity type — use one of {}", show(value), issue.options.join(", "))
        }
        Code::TooSmall if phrased(&issue.message) => with_value(&issue.message, value),
        Code::TooSmall => match issue.sized {
            Sized::String => "is empty".to_owned(),
            Sized::Array => format!("must have at least {bound} item{}", if issue.bound == 1.0 { "" } else { "s" }),
            Sized::Number => with_value(&format!("is below {bound}"), value),
        },
        Code::TooBig if phrased(&issue.message) => with_value(&issue.message, value),
        Code::TooBig => match issue.sized {
            Sized::Array => format!("has more than {bound} items"),
            Sized::String => format!("is longer than {bound} characters"),
            Sized::Number => with_value(&format!("is above {bound}"), value),
        },
        _ => with_value(&issue.message, value),
    }
}
