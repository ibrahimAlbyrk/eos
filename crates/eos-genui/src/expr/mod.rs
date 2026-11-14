//! Safe evaluators for visual answers: no code is ever run, only these two small
//! languages are read.
//!
//! Expressions (`<Value expr>`, `<Progress expr>`, `when=`, `{…}` templates):
//! numbers, 'strings', true/false/null, `+ - * / %`, `< <= > >= == !=`, `&& || !`,
//! `?:`, `( )`, member access `a.b` and `a[0]`. Identifiers resolve to the current
//! item's fields, then state keys, then data; the roots item / state / data name
//! each scope. A member of a list maps over it (`places.rating` → every rating).
//! Calls only to: sum count min max avg round abs floor ceil
//! fv(payment, annualRate, years).
//!
//! Filters (`where=`, `<Filters chips>`): clauses joined with `&&` and `||` (`&&`
//! binds tighter), grouped with `( )` and negated with `!( )`, each one of
//! `open · field · !field · field op value` (op: `== != < <= > >= ~`). `~` is a
//! case-insensitive contains (a list contains when any element does); the value
//! may be a number, 'quoted' or bare text, true/false/null, or `state.key`, and
//! `state.key` may stand in for the field too.
//!
//! Positions in errors count UTF-16 code units from 1, as the dashboard's do.

mod eval;
mod filter;
mod parse;
mod template;
mod token;

pub use eval::{eval_ast, eval_expr, truthy};
pub use filter::{
    WhereClause, WhereGroup, WhereGroupOp, WhereNode, WhereOp, check_where, match_where, match_where_text, parse_where,
    where_reads_state,
};
pub use parse::{check_expr, expr_refs, parse_expr};
pub use template::{fill_template, has_template};

use crate::value::Value;

pub const EXPR_FUNCTIONS: &[&str] = &["sum", "count", "min", "max", "avg", "round", "abs", "floor", "ceil", "fv"];
pub const EXPR_ROOTS: &[&str] = &["item", "state", "data"];
/// In UTF-16 code units.
pub const EXPR_MAX_LENGTH: usize = 500;

pub(crate) const FORBIDDEN_KEYS: &[&str] = &["__proto__", "prototype", "constructor"];
pub(crate) const MAX_PARSE_DEPTH: usize = 40;

/// What an expression or a template hole is evaluated against.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExprScope<'a> {
    pub item: Option<&'a Value>,
    pub state: Option<&'a Value>,
    pub data: Option<&'a Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprAst {
    Num(f64),
    Str(String),
    /// `true`, `false` or (`None`) `null`.
    Lit(Option<bool>),
    Id(String),
    Member {
        obj: Box<ExprAst>,
        prop: String,
    },
    Index {
        obj: Box<ExprAst>,
        index: Box<ExprAst>,
    },
    Unary {
        op: UnaryOp,
        a: Box<ExprAst>,
    },
    Binary {
        op: BinaryOp,
        a: Box<ExprAst>,
        b: Box<ExprAst>,
    },
    Cond {
        c: Box<ExprAst>,
        a: Box<ExprAst>,
        b: Box<ExprAst>,
    },
    Call {
        function: ExprFunction,
        args: Vec<ExprAst>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
    Pos,
}

impl UnaryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            UnaryOp::Not => "!",
            UnaryOp::Neg => "-",
            UnaryOp::Pos => "+",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
}

impl BinaryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Rem => "%",
            BinaryOp::Lt => "<",
            BinaryOp::Le => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Ge => ">=",
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        }
    }

    pub(crate) fn from_op(op: &str) -> Option<(BinaryOp, u8)> {
        Some(match op {
            "||" => (BinaryOp::Or, 2),
            "&&" => (BinaryOp::And, 3),
            "==" => (BinaryOp::Eq, 4),
            "!=" => (BinaryOp::Ne, 4),
            "<" => (BinaryOp::Lt, 5),
            "<=" => (BinaryOp::Le, 5),
            ">" => (BinaryOp::Gt, 5),
            ">=" => (BinaryOp::Ge, 5),
            "+" => (BinaryOp::Add, 6),
            "-" => (BinaryOp::Sub, 6),
            "*" => (BinaryOp::Mul, 7),
            "/" => (BinaryOp::Div, 7),
            "%" => (BinaryOp::Rem, 7),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExprFunction {
    Sum,
    Count,
    Min,
    Max,
    Avg,
    Round,
    Abs,
    Floor,
    Ceil,
    Fv,
}

impl ExprFunction {
    pub fn as_str(self) -> &'static str {
        match self {
            ExprFunction::Sum => "sum",
            ExprFunction::Count => "count",
            ExprFunction::Min => "min",
            ExprFunction::Max => "max",
            ExprFunction::Avg => "avg",
            ExprFunction::Round => "round",
            ExprFunction::Abs => "abs",
            ExprFunction::Floor => "floor",
            ExprFunction::Ceil => "ceil",
            ExprFunction::Fv => "fv",
        }
    }

    pub(crate) fn from_name(name: &str) -> Option<ExprFunction> {
        Some(match name {
            "sum" => ExprFunction::Sum,
            "count" => ExprFunction::Count,
            "min" => ExprFunction::Min,
            "max" => ExprFunction::Max,
            "avg" => ExprFunction::Avg,
            "round" => ExprFunction::Round,
            "abs" => ExprFunction::Abs,
            "floor" => ExprFunction::Floor,
            "ceil" => ExprFunction::Ceil,
            "fv" => ExprFunction::Fv,
            _ => return None,
        })
    }
}

/// Why an expression did not parse; `at` is a 0-based UTF-16 offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError {
    pub message: String,
    pub at: usize,
}

impl ExprError {
    pub(crate) fn new(message: impl Into<String>, at: usize) -> Self {
        ExprError { message: message.into(), at }
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ExprError {}
