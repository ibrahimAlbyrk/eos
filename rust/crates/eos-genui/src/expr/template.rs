use super::ExprScope;
use super::eval::{eval_ast, own};
use super::parse::parse_expr;
use crate::js::{self, is_ws};
use crate::utf16::{self, unit};
use crate::value::Value;

/// Whether a string holds at least one `{…}` template: braces around something
/// that is not blank and holds no brace itself.
pub fn has_template(v: &str) -> bool {
    let mut rest = v;
    while let Some(open) = rest.find('{') {
        let body = &rest[open + 1..];
        match body.find(['{', '}']) {
            Some(end) if body.as_bytes()[end] == b'}' && !body[..end].chars().all(is_ws) => return true,
            Some(end) if body.as_bytes()[end] == b'}' => rest = &body[end + 1..],
            Some(end) => rest = &body[end..],
            None => return false,
        }
    }
    false
}

/// Fills `{expr}` holes ("{name}", "{state.party}", "{price * 2}") from the scope.
/// A hole that resolves to nothing prints as ""; text in braces that isn't an
/// expression stays as written; `{{` and `}}` print literal braces. Plain numbers
/// print through `format_number` when given, else as JavaScript prints them.
pub fn fill_template(template: &str, scope: &ExprScope<'_>, format_number: Option<&dyn Fn(f64) -> String>) -> String {
    if !template.contains('{') && !template.contains("}}") {
        return template.to_owned();
    }
    let t = utf16::units(template);
    let mut out: Vec<u16> = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        let c = t[i];
        let next = t.get(i + 1).copied();
        if c == unit('{') && next == Some(unit('{')) {
            out.push(unit('{'));
            i += 2;
            continue;
        }
        if c == unit('}') && next == Some(unit('}')) {
            out.push(unit('}'));
            i += 2;
            continue;
        }
        if c == unit('{') {
            let close = utf16::find_unit(&t, unit('}'), i + 1).filter(|close| !t[i + 1..*close].contains(&unit('{')));
            let Some(close) = close else {
                out.push(c);
                i += 1;
                continue;
            };
            match parse_expr(&utf16::text(utf16::trim(&t[i + 1..close]))) {
                Ok(ast) => out.extend(print_value(&eval_ast(&ast, scope), format_number).encode_utf16()),
                Err(_) => out.extend_from_slice(&t[i..=close]),
            }
            i = close + 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    utf16::text(&out)
}

fn print_value(v: &Value, format_number: Option<&dyn Fn(f64) -> String>) -> String {
    match v {
        Value::Null => String::new(),
        Value::Number(n) => format_number.map_or_else(|| js::number_to_string(*n), |f| f(*n)),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        // Coordinates and other number lists print compactly ("40.98,29.02").
        Value::Array(items) if items.iter().all(|x| matches!(x, Value::Number(_))) => {
            items.iter().map(|x| js::to_string(Some(x))).collect::<Vec<_>>().join(",")
        }
        Value::Array(items) => {
            items.iter().map(|x| print_value(x, format_number)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")
        }
        Value::Object(_) => match own(Some(v), "name").filter(|n| !n.is_null()).or_else(|| own(Some(v), "title")) {
            Some(Value::String(named)) => named.clone(),
            _ => String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_need_a_filled_brace_pair() {
        for yes in ["{name}", "a {b} c", "{ x }", "{} {x}", "{{x}}", "{a{b}"] {
            assert!(has_template(yes), "{yes}");
        }
        for no in ["", "plain", "{}", "{ }", "{", "}", "{a", "a}", "{{", "{ {"] {
            assert!(!has_template(no), "{no}");
        }
    }
}
