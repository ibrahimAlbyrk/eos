use super::eval::{compare, own, text, to_num, truthy};
use super::{BinaryOp, EXPR_MAX_LENGTH, MAX_PARSE_DEPTH};
use crate::js::{self, is_blank, is_ws_unit};
use crate::re::{is_word_unit, pattern};
use crate::utf16::{self, ascii, unit};
use crate::value::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhereOp {
    Open,
    Truthy,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
}

impl WhereOp {
    pub fn as_str(self) -> &'static str {
        match self {
            WhereOp::Open => "open",
            WhereOp::Truthy => "truthy",
            WhereOp::Eq => "==",
            WhereOp::Ne => "!=",
            WhereOp::Lt => "<",
            WhereOp::Le => "<=",
            WhereOp::Gt => ">",
            WhereOp::Ge => ">=",
            WhereOp::Contains => "~",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WhereClause {
    pub op: WhereOp,
    /// Dotted field path; absent for `open` and when the left side is state.
    pub field: Option<String>,
    /// `state.key` on the left-hand side: that state value is tested, not a field.
    pub lref: Option<String>,
    pub not: bool,
    /// The literal compared against: text, a number, true/false or null.
    pub value: Option<Value>,
    /// `state.key` on the right-hand side: compared against that state value.
    pub r#ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhereGroupOp {
    And,
    Or,
}

/// `a && b` (and), `a || b` (or); `!( … )` sets `not`.
#[derive(Debug, Clone, PartialEq)]
pub struct WhereGroup {
    pub op: WhereGroupOp,
    pub of: Vec<WhereNode>,
    pub not: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WhereNode {
    Clause(WhereClause),
    Group(WhereGroup),
}

const FIELD: &str = r"[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*";
pattern!(CLAUSE_RE, &format!(r"^({FIELD})\s*(===|!==|==|!=|<=|>=|=|<|>|~)\s*(.*)$"), "u");
pattern!(FLAG_RE, &format!(r"^(!?)\s*({FIELD})$"), "u");
pattern!(STATE_REF_RE, r"^\{?\s*state\.([\p{L}_$][\p{L}\p{N}_$]*)\s*\}?$", "u");
pattern!(QUOTED_RE, r#"^(['"])(.*)\1$"#, "s");
const WHERE_HINT: &str =
    "use open, field, !field or field op value (op: == != < <= > >= ~), joined with && or ||, grouped with ( )";

pub fn parse_where(src: &str) -> Result<WhereNode, String> {
    if is_blank(src) {
        return Err("filter is empty".to_owned());
    }
    let units = utf16::units(src);
    if units.len() > EXPR_MAX_LENGTH {
        return Err(format!("filter is {} chars, max {EXPR_MAX_LENGTH}", units.len()));
    }
    let mut p = Parser { src: &units, text: src, i: 0, groups: 0 };
    let node = p.chain(WhereGroupOp::Or, 0)?;
    p.skip_ws();
    if p.i < units.len() {
        return Err(p.unexpected(p.i));
    }
    Ok(node)
}

/// `None` when valid, else the reason.
pub fn check_where(src: &str) -> Option<String> {
    parse_where(src).err()
}

/// Whether a filter reads view state (`state.key` on either side of any clause).
pub fn where_reads_state(n: &WhereNode) -> bool {
    match n {
        WhereNode::Group(g) => g.of.iter().any(where_reads_state),
        WhereNode::Clause(c) => c.r#ref.is_some() || c.lref.is_some(),
    }
}

// or := and ('||' and)* · and := unary ('&&' unary)* · unary := '!'? '(' or ')' | clause.
// A clause runs to the next && / || or group-closing ")" outside quotes, so bare
// values read as they always did ("hours.until > 20:00", "name == Kebap (Moda)").
struct Parser<'a> {
    src: &'a [u16],
    text: &'a str,
    i: usize,
    groups: usize,
}

impl Parser<'_> {
    fn skip_ws(&mut self) {
        while self.i < self.src.len() && is_ws_unit(self.src[self.i]) {
            self.i += 1;
        }
    }

    fn at(&self, c: char) -> bool {
        utf16::is(self.src, self.i, c)
    }

    // A string ends at its quote mark followed by a space, &, |, ) or the end.
    fn closing_quote(&self, q: u16, from: usize) -> Option<usize> {
        let src = self.src;
        let mut k = utf16::find_unit(src, q, from)?;
        loop {
            if k + 1 >= src.len() || is_ws_unit(src[k + 1]) || matches!(ascii(src[k + 1]), b'&' | b'|' | b')') {
                return Some(k);
            }
            k = utf16::find_unit(src, q, k + 1)?;
        }
    }

    fn unexpected(&self, k: usize) -> String {
        if utf16::is(self.src, k, ')') {
            return format!("\")\" at {} has no \"(\"", k + 1);
        }
        let shown = utf16::text(utf16::trim(&self.src[k..(k + 16).min(self.src.len())]));
        format!("expected && or || before \"{shown}\" at {} — {WHERE_HINT}", k + 1)
    }

    fn chain(&mut self, op: WhereGroupOp, depth: usize) -> Result<WhereNode, String> {
        let sep = if op == WhereGroupOp::Or { "||" } else { "&&" };
        let mut of = vec![self.operand(op, depth)?];
        loop {
            self.skip_ws();
            if !utf16::starts_with(self.src, self.i, sep) {
                break;
            }
            self.i += sep.len();
            of.push(self.operand(op, depth)?);
        }
        if of.len() == 1
            && let Some(only) = of.pop()
        {
            return Ok(only);
        }
        Ok(WhereNode::Group(WhereGroup { op, of, not: false }))
    }

    fn operand(&mut self, op: WhereGroupOp, depth: usize) -> Result<WhereNode, String> {
        if op == WhereGroupOp::Or { self.chain(WhereGroupOp::And, depth) } else { self.unary(depth) }
    }

    fn unary(&mut self, depth: usize) -> Result<WhereNode, String> {
        if depth > MAX_PARSE_DEPTH {
            return Err("filter is nested too deeply".to_owned());
        }
        self.skip_ws();
        if self.at('!') {
            let mut k = self.i + 1;
            while k < self.src.len() && is_ws_unit(self.src[k]) {
                k += 1;
            }
            if utf16::is(self.src, k, '(') {
                self.i += 1;
                return Ok(negate(self.unary(depth + 1)?));
            }
        }
        if !self.at('(') {
            return self.clause_at().map(WhereNode::Clause);
        }
        let start = self.i;
        self.i += 1;
        self.groups += 1;
        let inner = self.chain(WhereGroupOp::Or, depth + 1)?;
        self.skip_ws();
        if !self.at(')') {
            return Err(if self.i < self.src.len() {
                self.unexpected(self.i)
            } else {
                format!("\"(\" at {} is never closed", start + 1)
            });
        }
        self.i += 1;
        self.groups -= 1;
        Ok(inner)
    }

    fn clause_at(&mut self) -> Result<WhereClause, String> {
        let src = self.src;
        let start = self.i;
        let mut parens = 0usize;
        while self.i < src.len() {
            let c = src[self.i];
            // A quote opens a string only at a word boundary (O'Brien stays text) and only when it closes.
            if (c == unit('\'') || c == unit('"'))
                && !(self.i > 0 && is_word_unit(src[self.i - 1]))
                && let Some(close) = self.closing_quote(c, self.i + 1)
            {
                self.i = close + 1;
                continue;
            }
            if utf16::starts_with(src, self.i, "&&") || utf16::starts_with(src, self.i, "||") {
                break;
            }
            if c == unit('(') {
                parens += 1;
            } else if c == unit(')') {
                if parens > 0 {
                    parens -= 1;
                } else if self.groups > 0 {
                    break;
                }
            }
            self.i += 1;
        }
        let part = utf16::text(utf16::trim(&src[start..self.i]));
        if part.is_empty() {
            return Err(format!("empty clause in \"{}\" — {WHERE_HINT}", self.text));
        }
        parse_clause(&part)
    }
}

fn parse_clause(part: &str) -> Result<WhereClause, String> {
    if part == "open" || part == "!open" {
        return Ok(WhereClause { not: part == "!open", ..clause(WhereOp::Open) });
    }
    if let Some(m) = CLAUSE_RE.find(part) {
        let group = |i: usize| m.group(i).map_or("", |r| &part[r]);
        let op_raw = group(2);
        let op = match op_raw {
            "=" | "===" | "==" => WhereOp::Eq,
            "!==" | "!=" => WhereOp::Ne,
            "<" => WhereOp::Lt,
            "<=" => WhereOp::Le,
            ">" => WhereOp::Gt,
            ">=" => WhereOp::Ge,
            _ => WhereOp::Contains,
        };
        let rhs = js::trim(group(3));
        if rhs.is_empty() {
            return Err(format!("\"{part}\" has no value after {op_raw}"));
        }
        if rhs.starts_with(['=', '<', '>', '!', '~']) {
            return Err(format!("\"{part}\" has two operators — {WHERE_HINT}"));
        }
        let mut out = left_side(clause(op), group(1));
        match STATE_REF_RE.find(rhs).and_then(|r| r.group(1)) {
            Some(key) => out.r#ref = Some(rhs[key].to_owned()),
            None => out.value = Some(literal(rhs)),
        }
        return Ok(out);
    }
    if let Some(f) = FLAG_RE.find(part) {
        let negated = f.group(1).is_some_and(|r| !r.is_empty());
        let field = f.group(2).map_or("", |r| &part[r]);
        return Ok(WhereClause { not: negated, ..left_side(clause(WhereOp::Truthy), field) });
    }
    Err(format!("\"{part}\" is not a filter — {WHERE_HINT}"))
}

fn clause(op: WhereOp) -> WhereClause {
    WhereClause { op, field: None, lref: None, not: false, value: None, r#ref: None }
}

fn left_side(mut c: WhereClause, field: &str) -> WhereClause {
    match field.strip_prefix("state.") {
        Some(key) => c.lref = Some(key.to_owned()),
        None => c.field = Some(field.to_owned()),
    }
    c
}

fn negate(n: WhereNode) -> WhereNode {
    match n {
        WhereNode::Clause(c) => WhereNode::Clause(WhereClause { not: !c.not, ..c }),
        WhereNode::Group(g) => WhereNode::Group(WhereGroup { not: !g.not, ..g }),
    }
}

fn literal(rhs: &str) -> Value {
    if let Some(inner) = QUOTED_RE.find(rhs).and_then(|q| q.group(2)) {
        return Value::String(rhs[inner].to_owned());
    }
    if js::is_numeric_text(rhs) {
        return Value::Number(js::numeric_text_value(rhs));
    }
    match rhs {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => Value::String(rhs.to_owned()),
    }
}

/// Whether an item passes a filter.
pub fn match_where(item: Option<&Value>, node: &WhereNode, state: Option<&Value>) -> bool {
    let (r, not) = match node {
        WhereNode::Clause(c) => (match_clause(item, c, state), c.not),
        WhereNode::Group(g) if g.op == WhereGroupOp::And => (g.of.iter().all(|c| match_where(item, c, state)), g.not),
        WhereNode::Group(g) => (g.of.iter().any(|c| match_where(item, c, state)), g.not),
    };
    r != not
}

/// [`match_where`] for filter text. A filter that doesn't parse filters nothing
/// (the validator rejects it before it is ever stored).
pub fn match_where_text(item: Option<&Value>, filter: &str, state: Option<&Value>) -> bool {
    parse_where(filter).map_or(true, |node| match_where(item, &node, state))
}

fn get_path<'a>(obj: Option<&'a Value>, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(obj, |cur, k| own(cur, k).map(Some)).flatten()
}

fn lower(v: Option<&Value>) -> String {
    v.map(text).unwrap_or_default().to_lowercase()
}

// The clause's own test; match_where applies `not`.
fn match_clause(item: Option<&Value>, c: &WhereClause, state: Option<&Value>) -> bool {
    if c.op == WhereOp::Open {
        let closed_by_hours = own(own(item, "hours"), "closed") == Some(&Value::Bool(true));
        return !closed_by_hours && lower(own(item, "status")) != "closed";
    }
    let v = match &c.lref {
        Some(lref) => get_path(state, lref),
        None => get_path(item, c.field.as_deref().unwrap_or("")),
    };
    if c.op == WhereOp::Truthy {
        return v.is_some_and(truthy);
    }
    let want = match &c.r#ref {
        Some(key) => own(state, key),
        None => c.value.as_ref(),
    };
    compare_field(c.op, v, want.unwrap_or(&Value::Null))
}

fn compare_field(op: WhereOp, v: Option<&Value>, want: &Value) -> bool {
    match op {
        WhereOp::Contains => {
            let needle = lower(Some(want));
            match v {
                Some(Value::Array(items)) => items.iter().any(|el| lower(Some(el)).contains(&needle)),
                None | Some(Value::Null | Value::Object(_)) => false,
                Some(scalar) => lower(Some(scalar)).contains(&needle),
            }
        }
        WhereOp::Eq | WhereOp::Ne => {
            let eq = match v {
                Some(Value::Array(items)) => items.iter().any(|el| field_eq(el, want)),
                other => field_eq(other.unwrap_or(&Value::Null), want),
            };
            eq == (op == WhereOp::Eq)
        }
        _ => {
            let Some(scalar @ (Value::Bool(_) | Value::Number(_) | Value::String(_))) = v else { return false };
            let op = match op {
                WhereOp::Lt => BinaryOp::Lt,
                WhereOp::Le => BinaryOp::Le,
                WhereOp::Gt => BinaryOp::Gt,
                _ => BinaryOp::Ge,
            };
            compare(op, scalar, want)
        }
    }
}

// Filters compare text case-insensitively and numbers as numbers.
fn field_eq(v: &Value, want: &Value) -> bool {
    if v.is_null() || want.is_null() {
        return v.is_null() && want.is_null();
    }
    let is_bool = |x: &Value| matches!(x, Value::Bool(_));
    if let (Some(x), Some(y), false, false) = (to_num(v), to_num(want), is_bool(v), is_bool(want)) {
        return x == y;
    }
    if is_bool(v) || is_bool(want) {
        return js::to_string(Some(v)) == js::to_string(Some(want));
    }
    lower(Some(v)) == lower(Some(want))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&CLAUSE_RE, &FLAG_RE, &STATE_REF_RE, &QUOTED_RE] {
            assert!(!crate::re::is_match(re, "\u{0}"));
        }
    }

    #[test]
    fn reads_clauses_and_groups() {
        let n = parse_where("(open || rating>=4.6) && state.mode != 'off'").expect("a filter");
        let WhereNode::Group(g) = &n else { panic!("expected a group") };
        assert_eq!((g.op, g.of.len()), (WhereGroupOp::And, 2));
        assert!(where_reads_state(&n));
        assert_eq!(parse_where("(open || rating>4").expect_err("unclosed"), "\"(\" at 1 is never closed");
    }
}
