use std::borrow::Cow;
use std::cmp::Ordering;

use super::parse::parse_expr;
use super::{BinaryOp, ExprAst, ExprFunction, ExprScope, FORBIDDEN_KEYS, UnaryOp};
use crate::js;
use crate::value::Value;

/// The value of an expression, or null when it doesn't parse or can't be computed.
pub fn eval_expr(src: &str, scope: &ExprScope<'_>) -> Value {
    match parse_expr(src) {
        Ok(ast) => eval_ast(&ast, scope),
        Err(_) => Value::Null,
    }
}

pub fn eval_ast(ast: &ExprAst, scope: &ExprScope<'_>) -> Value {
    norm(ev(ast, scope).into_owned())
}

// Values borrowed from the scope stay borrowed until an operator needs its own.
// A missing value (JavaScript's undefined) is null throughout: nothing in the
// language tells them apart.
type Ev<'a> = Cow<'a, Value>;

const NULL: Value = Value::Null;

fn owned<'a>(v: Value) -> Ev<'a> {
    Cow::Owned(v)
}

fn ev<'a>(n: &ExprAst, scope: &ExprScope<'a>) -> Ev<'a> {
    match n {
        ExprAst::Num(v) => owned(Value::Number(*v)),
        ExprAst::Str(v) => owned(Value::String(v.clone())),
        ExprAst::Lit(v) => owned(v.map_or(Value::Null, Value::Bool)),
        ExprAst::Id(name) => resolve_name(name, scope),
        ExprAst::Member { obj, prop } => member(ev(obj, scope), prop),
        ExprAst::Index { obj, index } => {
            let key = ev(index, scope);
            let obj = ev(obj, scope);
            let is_list = matches!(obj.as_ref(), Value::Array(_));
            match key.as_ref() {
                Value::Number(k) if is_list => element(obj, *k),
                Value::String(k) => member(obj, k),
                Value::Number(k) => member(obj, &js::number_to_string(*k)),
                _ => owned(Value::Null),
            }
        }
        ExprAst::Unary { op, a } => {
            let a = ev(a, scope);
            if *op == UnaryOp::Not {
                return owned(Value::Bool(!truthy(&a)));
            }
            match to_num(&a) {
                Some(x) => owned(Value::Number(if *op == UnaryOp::Neg { -x } else { x })),
                None => owned(Value::Null),
            }
        }
        ExprAst::Binary { op, a, b } => binary(*op, a, b, scope),
        ExprAst::Cond { c, a, b } => {
            if truthy(&ev(c, scope)) {
                ev(a, scope)
            } else {
                ev(b, scope)
            }
        }
        ExprAst::Call { function, args } => {
            let args: Vec<Ev<'a>> = args.iter().map(|a| ev(a, scope)).collect();
            owned(call(*function, &args))
        }
    }
}

// obj[k] on a list: negative counts from the end; anything off the list is missing.
fn element(list: Ev<'_>, k: f64) -> Ev<'_> {
    let len = list.as_array().map_or(0, <[Value]>::len);
    let k = k.trunc();
    let at = if k < 0.0 { len as f64 + k } else { k };
    if !(at >= 0.0 && at < len as f64) {
        return owned(Value::Null);
    }
    let at = at as usize;
    match list {
        Cow::Borrowed(Value::Array(items)) => Cow::Borrowed(&items[at]),
        Cow::Owned(Value::Array(mut items)) => owned(items.swap_remove(at)),
        _ => owned(Value::Null),
    }
}

pub(crate) fn own<'a>(obj: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    if FORBIDDEN_KEYS.contains(&key) {
        return None;
    }
    obj?.get(key)
}

fn resolve_name<'a>(name: &str, scope: &ExprScope<'a>) -> Ev<'a> {
    let root = match name {
        "item" => Some(scope.item),
        "state" => Some(scope.state),
        "data" => Some(scope.data),
        _ => None,
    };
    if let Some(root) = root {
        return Cow::Borrowed(root.unwrap_or(&NULL));
    }
    [scope.item, scope.state, scope.data]
        .into_iter()
        .find_map(|src| own(src, name))
        .map_or(owned(Value::Null), Cow::Borrowed)
}

fn member<'a>(obj: Ev<'a>, prop: &str) -> Ev<'a> {
    match obj {
        Cow::Borrowed(Value::Array(items)) => {
            owned(Value::Array(items.iter().map(|el| member(Cow::Borrowed(el), prop).into_owned()).collect()))
        }
        Cow::Owned(Value::Array(items)) => {
            owned(Value::Array(items.into_iter().map(|el| member(owned(el), prop).into_owned()).collect()))
        }
        Cow::Borrowed(v) => own(Some(v), prop).map_or(owned(Value::Null), Cow::Borrowed),
        Cow::Owned(mut v) => {
            let taken = match &mut v {
                Value::Object(o) if !FORBIDDEN_KEYS.contains(&prop) => o.remove(prop),
                _ => None,
            };
            owned(taken.unwrap_or(Value::Null))
        }
    }
}

fn binary<'a>(op: BinaryOp, an: &ExprAst, bn: &ExprAst, scope: &ExprScope<'a>) -> Ev<'a> {
    if op == BinaryOp::And {
        let a = ev(an, scope);
        return if truthy(&a) { ev(bn, scope) } else { a };
    }
    if op == BinaryOp::Or {
        let a = ev(an, scope);
        return if truthy(&a) { a } else { ev(bn, scope) };
    }
    let a = ev(an, scope);
    let b = ev(bn, scope);
    let (a, b) = (a.as_ref(), b.as_ref());
    let out = match op {
        BinaryOp::Eq => Value::Bool(loose_eq(a, b)),
        BinaryOp::Ne => Value::Bool(!loose_eq(a, b)),
        BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => Value::Bool(compare(op, a, b)),
        BinaryOp::Add => match (to_num(a), to_num(b)) {
            (Some(x), Some(y)) => Value::Number(x + y),
            _ if matches!(a, Value::String(_)) || matches!(b, Value::String(_)) => {
                Value::String(format!("{}{}", text(a), text(b)))
            }
            _ => Value::Null,
        },
        _ => match (to_num(a), to_num(b)) {
            (Some(x), Some(y)) => match op {
                BinaryOp::Sub => Value::Number(x - y),
                BinaryOp::Mul => Value::Number(x * y),
                _ if y == 0.0 => Value::Null,
                BinaryOp::Div => Value::Number(x / y),
                _ => Value::Number(x % y),
            },
            _ => Value::Null,
        },
    };
    owned(out)
}

fn call(function: ExprFunction, args: &[Ev<'_>]) -> Value {
    let arg = |i: usize| args.get(i).map_or(&NULL, |a| a.as_ref());
    let number = |x: Option<f64>| x.map_or(Value::Null, Value::Number);
    match function {
        ExprFunction::Sum => Value::Number(nums(args).iter().fold(0.0, |s, x| s + x)),
        ExprFunction::Min => number(
            nums(args)
                .into_iter()
                .reduce(|m, x| if x < m || (x == 0.0 && m == 0.0 && x.is_sign_negative()) { x } else { m }),
        ),
        ExprFunction::Max => number(
            nums(args)
                .into_iter()
                .reduce(|m, x| if x > m || (x == 0.0 && m == 0.0 && m.is_sign_negative()) { x } else { m }),
        ),
        ExprFunction::Avg => {
            let xs = nums(args);
            number((!xs.is_empty()).then(|| xs.iter().fold(0.0, |s, x| s + x) / xs.len() as f64))
        }
        ExprFunction::Count => {
            let mut n = 0.0;
            for a in args {
                count(a, &mut n);
            }
            Value::Number(n)
        }
        ExprFunction::Round => number(to_num(arg(0)).map(|x| {
            let d = to_num(arg(1)).unwrap_or(0.0).trunc().clamp(0.0, 10.0);
            let f = 10f64.powi(d as i32);
            round_half_up(x * f) / f
        })),
        ExprFunction::Abs => number(to_num(arg(0)).map(f64::abs)),
        ExprFunction::Floor => number(to_num(arg(0)).map(f64::floor)),
        ExprFunction::Ceil => number(to_num(arg(0)).map(f64::ceil)),
        ExprFunction::Fv => {
            // Monthly contributions compounded monthly — "save P a month at R for Y years".
            let (Some(pay), Some(rate), Some(years)) = (to_num(arg(0)), to_num(arg(1)), to_num(arg(2))) else {
                return Value::Null;
            };
            let r = rate / 12.0;
            let months = round_half_up(years * 12.0);
            if months <= 0.0 {
                return Value::Number(0.0);
            }
            // `**` in V8 and `powf` here both call the platform's pow; on another
            // libm the last digit of a result may differ from the recorded vectors.
            Value::Number(if r == 0.0 { pay * months } else { pay * (((1.0 + r).powf(months) - 1.0) / r) })
        }
    }
}

/// `Math.round`: halves go up, toward +∞.
fn round_half_up(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn count(v: &Value, n: &mut f64) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| count(x, n)),
        Value::Null | Value::Bool(false) => {}
        Value::String(s) if s.is_empty() => {}
        _ => *n += 1.0,
    }
}

fn nums(args: &[Ev<'_>]) -> Vec<f64> {
    fn visit(v: &Value, out: &mut Vec<f64>) {
        match v {
            Value::Array(items) => items.iter().for_each(|x| visit(x, out)),
            Value::Bool(_) => {}
            other => out.extend(to_num(other)),
        }
    }
    let mut out = Vec::new();
    for a in args {
        visit(a, &mut out);
    }
    out
}

pub(crate) fn to_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.is_finite().then_some(*n),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::String(s) if js::is_numeric_text(s) => Some(js::numeric_text_value(s)),
        _ => None,
    }
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Array(items) => !items.is_empty(),
        Value::Number(n) => *n != 0.0 && !n.is_nan(),
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Bool(true) | Value::Object(_) => true,
    }
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    if a.is_null() || b.is_null() {
        return a.is_null() && b.is_null();
    }
    if matches!(a, Value::Number(_)) || matches!(b, Value::Number(_)) {
        return matches!((to_num(a), to_num(b)), (Some(x), Some(y)) if x == y);
    }
    match (a, b) {
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        _ => false,
    }
}

pub(crate) fn compare(op: BinaryOp, a: &Value, b: &Value) -> bool {
    let is_bool = |v: &Value| matches!(v, Value::Bool(_));
    let c = match (to_num(a), to_num(b)) {
        (Some(x), Some(y)) if !is_bool(a) && !is_bool(b) => x - y,
        _ => match (a, b) {
            (Value::String(x), Value::String(y)) => match js::cmp16(x, y) {
                Ordering::Less => -1.0,
                Ordering::Greater => 1.0,
                Ordering::Equal => 0.0,
            },
            _ => return false,
        },
    };
    match op {
        BinaryOp::Lt => c < 0.0,
        BinaryOp::Le => c <= 0.0,
        BinaryOp::Gt => c > 0.0,
        _ => c >= 0.0,
    }
}

/// How a value reads as text in `+` and in filters.
pub(crate) fn text(v: &Value) -> String {
    match v {
        Value::Null | Value::Object(_) => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => js::number_to_string(*n),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(text).collect::<Vec<_>>().join(", "),
    }
}

// Numbers that are not finite have no JSON form: they read as null.
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) if !n.is_finite() => Value::Null,
        Value::Array(items) => Value::Array(items.into_iter().map(norm).collect()),
        other => other,
    }
}
