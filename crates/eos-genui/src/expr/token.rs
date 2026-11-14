use super::ExprError;
use crate::js::is_ws_unit;
use crate::re::{is_ident_start, is_ident_unit};
use crate::utf16::{self, ascii, unit};

#[derive(Debug, Clone, PartialEq)]
pub(super) enum TokKind {
    Num(f64),
    Str(String),
    Id(String),
    Op(&'static str),
    End,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Tok {
    pub(super) kind: TokKind,
    pub(super) at: usize,
}

// Longest first: the first that matches wins.
const OPS: &[&str] = &[
    "===", "!==", "&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", ",", ".", "[",
    "]", "?", ":",
];

pub(super) fn tokenize(src: &[u16]) -> Result<Vec<Tok>, ExprError> {
    let mut out = Vec::new();
    let mut i = 0;
    let digit = |at: usize| src.get(at).is_some_and(|u| ascii(*u).is_ascii_digit());
    while i < src.len() {
        let c = src[i];
        if is_ws_unit(c) {
            i += 1;
            continue;
        }
        if digit(i) || (c == unit('.') && digit(i + 1)) {
            let end = number_end(src, i);
            out.push(Tok { kind: TokKind::Num(number_value(&src[i..end])), at: i });
            i = end;
            continue;
        }
        if c == unit('\'') || c == unit('"') {
            let mut v: Vec<u16> = Vec::new();
            let mut k = i + 1;
            while k < src.len() && src[k] != c {
                if src[k] == unit('\\') && k + 1 < src.len() {
                    k += 1;
                    v.push(match ascii(src[k]) {
                        b'n' => unit('\n'),
                        b't' => unit('\t'),
                        _ => src[k],
                    });
                } else {
                    v.push(src[k]);
                }
                k += 1;
            }
            if k >= src.len() {
                return Err(ExprError::new(format!("string starting at {} is never closed", i + 1), i));
            }
            out.push(Tok { kind: TokKind::Str(utf16::text(&v)), at: i });
            i = k + 1;
            continue;
        }
        if is_ident_start(c) {
            let mut k = i + 1;
            while k < src.len() && is_ident_unit(src[k]) {
                k += 1;
            }
            out.push(Tok { kind: TokKind::Id(utf16::text(&src[i..k])), at: i });
            i = k;
            continue;
        }
        let Some(op) = OPS.iter().find(|op| utf16::starts_with(src, i, op)) else {
            return Err(ExprError::new(format!("unexpected \"{}\" at {}", utf16::text(&[c]), i + 1), i));
        };
        let kind = match *op {
            "===" => "==",
            "!==" => "!=",
            other => other,
        };
        out.push(Tok { kind: TokKind::Op(kind), at: i });
        i += op.len();
    }
    out.push(Tok { kind: TokKind::End, at: src.len() });
    Ok(out)
}

// ^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)? — the caller saw a digit, or a dot before one.
fn number_end(src: &[u16], start: usize) -> usize {
    let digit = |at: usize| src.get(at).is_some_and(|u| ascii(*u).is_ascii_digit());
    let mut i = start;
    while digit(i) {
        i += 1;
    }
    if utf16::is(src, i, '.') && (i > start || digit(i + 1)) {
        i += 1;
        while digit(i) {
            i += 1;
        }
    }
    if src.get(i).is_some_and(|u| matches!(ascii(*u), b'e' | b'E')) {
        let mut k = i + 1;
        if src.get(k).is_some_and(|u| matches!(ascii(*u), b'+' | b'-')) {
            k += 1;
        }
        if digit(k) {
            while digit(k) {
                k += 1;
            }
            i = k;
        }
    }
    i
}

fn number_value(lit: &[u16]) -> f64 {
    let text: String = lit.iter().map(|u| char::from(ascii(*u))).collect();
    crate::js::parse_decimal(&text)
}
