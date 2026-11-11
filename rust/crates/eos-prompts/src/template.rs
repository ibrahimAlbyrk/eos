//! The `{{ }}` language (`core/src/services/template-engine.ts`): a value
//! (`{{PATH}}`) and one block that shows its body when a value is truthy
//! (`{{#if PATH}}…{{/if}}`) or is not (`{{#unless PATH}}…{{/unless}}`). No
//! loops and no operators: anything larger is another fragment or a value
//! computed before rendering.
//!
//! Parsing is strict. A token that is not a path, an opener or a closer, a
//! block left open and a closer that does not match its opener are errors: a
//! broken prompt is left out of the library instead of reaching a model
//! half-rendered.

use eos_core::Error;
use serde_json::{Map, Value};

/// Variables by name. A value is text, a number, a flag, a list of texts or
/// nothing; the names are UPPER_SNAKE by convention.
pub type VariableScope = Map<String, Value>;

/// The compiled body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Text(String),
    /// A value by its (possibly dotted) path.
    Interp(String),
    /// A body shown when the path is truthy; `negate` flips it (`#unless`).
    Cond {
        path: String,
        negate: bool,
        body: Vec<Node>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedTemplate {
    pub nodes: Vec<Node>,
    /// The variables the body names (a path's first segment), in the order
    /// they first appear.
    pub referenced: Vec<String>,
}

/// What JavaScript's `\s` and `trim` treat as white space.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `^[A-Za-z_][A-Za-z0-9_.]*$`.
fn is_path(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
}

fn root_name(path: &str) -> &str {
    path.split('.').next().unwrap_or(path)
}

fn invalid(message: String) -> Error {
    Error::Validation(format!("template: {message}"))
}

#[derive(PartialEq)]
enum Block {
    If,
    Unless,
}

struct Frame {
    /// The block this frame is the body of, with its path.
    open: Option<(Block, String)>,
    body: Vec<Node>,
}

/// Compiles a body. A token runs from `{{` to the first `}}` after it; a
/// `{{` that nothing closes is text.
pub fn parse_template(body: &str) -> Result<ParsedTemplate, Error> {
    let mut stack = vec![Frame { open: None, body: Vec::new() }];
    let mut referenced: Vec<String> = Vec::new();
    let mut note = |path: &str| {
        let root = root_name(path);
        if !referenced.iter().any(|name| name == root) {
            referenced.push(root.to_owned());
        }
    };
    fn top(stack: &mut [Frame]) -> &mut Vec<Node> {
        // The root frame is never popped.
        let last = stack.len() - 1;
        &mut stack[last].body
    }

    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        if start > 0 {
            top(&mut stack).push(Node::Text(rest[..start].to_owned()));
        }
        let inner = js_trim(&rest[start + 2..start + 2 + len]);
        rest = &rest[start + 2 + len + 2..];

        if inner == "/if" || inner == "/unless" {
            let expected = if inner == "/if" { Block::If } else { Block::Unless };
            let matches = stack.last().and_then(|f| f.open.as_ref()).is_some_and(|(kind, _)| *kind == expected);
            if !matches {
                return Err(invalid(format!("{{{{{inner}}}}} has no matching {{{{#{}}}}}", &inner[1..])));
            }
            if let Some(Frame { open: Some((kind, path)), body }) = stack.pop() {
                top(&mut stack).push(Node::Cond { path, negate: kind == Block::Unless, body });
            }
        } else if inner.starts_with("#if ") || inner.starts_with("#unless ") {
            let kind = if inner.starts_with("#unless ") { Block::Unless } else { Block::If };
            let path = js_trim(inner.split_once(' ').map_or("", |(_, path)| path));
            if !is_path(path) {
                return Err(invalid(format!("invalid path in {{{{{inner}}}}}")));
            }
            note(path);
            stack.push(Frame { open: Some((kind, path.to_owned())), body: Vec::new() });
        } else if is_path(inner) {
            note(inner);
            top(&mut stack).push(Node::Interp(inner.to_owned()));
        } else {
            return Err(invalid(format!("malformed token {{{{{inner}}}}}")));
        }
    }
    if !rest.is_empty() {
        top(&mut stack).push(Node::Text(rest.to_owned()));
    }
    if stack.len() != 1 {
        return Err(invalid(format!("{} unclosed {{{{#if}}}}/{{{{#unless}}}} block(s)", stack.len() - 1)));
    }
    let nodes = stack.pop().map(|frame| frame.body).unwrap_or_default();
    Ok(ParsedTemplate { nodes, referenced })
}

/// The one truthiness rule of templates and of `when` conditions: nothing,
/// `false`, `0`, the empty text and the empty list are falsy.
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(_)) => true,
    }
}

/// A dotted path's value. Only objects and lists have members (a list has
/// its items and `length`); a text has none.
fn resolve_path<'a>(scope: &'a VariableScope, path: &str) -> Option<std::borrow::Cow<'a, Value>> {
    use std::borrow::Cow;
    let mut parts = path.split('.');
    let mut current = Cow::Borrowed(scope.get(parts.next()?)?);
    for part in parts {
        let next = match current {
            Cow::Borrowed(Value::Object(map)) => Cow::Borrowed(map.get(part)?),
            Cow::Borrowed(Value::Array(items)) if part == "length" => Cow::Owned(Value::from(items.len())),
            Cow::Borrowed(Value::Array(items)) => {
                let index = part.parse::<usize>().ok().filter(|i| i.to_string() == part)?;
                Cow::Borrowed(items.get(index)?)
            }
            _ => return None,
        };
        current = next;
    }
    Some(current)
}

/// `String(value)`, with nothing for null and a list's items on their own lines.
fn stringify(value: &Value, out: &mut String) {
    match value {
        Value::Null => {}
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_i64() {
            Some(i) => out.push_str(&i.to_string()),
            None => out.push_str(ryu_js::Buffer::new().format(n.as_f64().unwrap_or(f64::NAN))),
        },
        Value::String(s) => out.push_str(s),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                stringify(item, out);
            }
        }
        Value::Object(_) => out.push_str("[object Object]"),
    }
}

fn render_into(nodes: &[Node], scope: &VariableScope, out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(text),
            Node::Interp(path) => {
                if let Some(value) = resolve_path(scope, path) {
                    stringify(&value, out);
                }
            }
            Node::Cond { path, negate, body } => {
                if is_truthy(resolve_path(scope, path).as_deref()) != *negate {
                    render_into(body, scope, out);
                }
            }
        }
    }
}

/// Renders compiled nodes. A variable with no value renders as nothing:
/// there are no required variables.
pub fn render_template(nodes: &[Node], scope: &VariableScope) -> String {
    let mut out = String::new();
    render_into(nodes, scope, &mut out);
    out
}
