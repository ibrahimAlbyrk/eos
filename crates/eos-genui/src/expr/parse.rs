use super::token::{Tok, TokKind, tokenize};
use super::{
    BinaryOp, EXPR_FUNCTIONS, EXPR_MAX_LENGTH, EXPR_ROOTS, ExprAst, ExprError, ExprFunction, FORBIDDEN_KEYS,
    MAX_PARSE_DEPTH, UnaryOp,
};
use crate::js::is_blank;
use crate::utf16;

pub fn parse_expr(src: &str) -> Result<ExprAst, ExprError> {
    if is_blank(src) {
        return Err(ExprError::new("expression is empty", 0));
    }
    let units = utf16::units(src);
    if units.len() > EXPR_MAX_LENGTH {
        return Err(ExprError::new(format!("expression is {} chars, max {EXPR_MAX_LENGTH}", units.len()), 0));
    }
    let toks = tokenize(&units)?;
    let mut p = Parser { toks: &toks, p: 0 };
    let ast = p.ternary(0)?;
    let t = p.peek();
    if t.kind != TokKind::End {
        let shown = match &t.kind {
            TokKind::Op(v) => v,
            TokKind::Id(v) => v.as_str(),
            _ => "value",
        };
        return Err(ExprError::new(format!("unexpected \"{shown}\" at {}", t.at + 1), t.at));
    }
    Ok(ast)
}

/// `None` when valid, else the reason.
pub fn check_expr(src: &str) -> Option<String> {
    parse_expr(src).err().map(|e| e.message)
}

/// The names an expression reads: bare identifiers ("save") and scoped ones
/// ("state.save", "data.places", "item.name"), each once, in reading order.
/// Function names are not included; an expression that does not parse reads none.
pub fn expr_refs(src: &str) -> Vec<String> {
    let Ok(ast) = parse_expr(src) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    let mut add = |name: String| {
        if !out.contains(&name) {
            out.push(name);
        }
    };
    // Depth-first, left to right; the right-hand sides wait on the stack.
    let mut pending = vec![&ast];
    while let Some(n) = pending.pop() {
        match n {
            ExprAst::Id(name) => {
                if !EXPR_ROOTS.contains(&name.as_str()) {
                    add(name.clone());
                }
            }
            ExprAst::Member { obj, prop } => match obj.as_ref() {
                ExprAst::Id(root) if EXPR_ROOTS.contains(&root.as_str()) => add(format!("{root}.{prop}")),
                other => pending.push(other),
            },
            ExprAst::Index { obj, index } => pending.extend([index.as_ref(), obj.as_ref()]),
            ExprAst::Unary { a, .. } => pending.push(a),
            ExprAst::Binary { a, b, .. } => pending.extend([b.as_ref(), a.as_ref()]),
            ExprAst::Cond { c, a, b } => pending.extend([b.as_ref(), a.as_ref(), c.as_ref()]),
            ExprAst::Call { args, .. } => pending.extend(args.iter().rev()),
            ExprAst::Num(_) | ExprAst::Str(_) | ExprAst::Lit(_) => {}
        }
    }
    out
}

fn allowed() -> String {
    EXPR_FUNCTIONS.join(", ")
}

// Precedence climbing. `depth` bounds the recursion exactly as the dashboard's
// parser does, so both reject the same inputs as nested too deeply.
struct Parser<'a> {
    toks: &'a [Tok],
    p: usize,
}

impl Parser<'_> {
    fn peek(&self) -> &Tok {
        // The token list always ends with End and the cursor never passes it.
        &self.toks[self.p.min(self.toks.len() - 1)]
    }

    fn is_op(&self, v: &str) -> bool {
        matches!(&self.peek().kind, TokKind::Op(op) if *op == v)
    }

    fn expect_op(&mut self, v: &str) -> Result<(), ExprError> {
        if !self.is_op(v) {
            let at = self.peek().at;
            return Err(ExprError::new(format!("expected \"{v}\" at {}", at + 1), at));
        }
        self.p += 1;
        Ok(())
    }

    fn too_deep(&self) -> ExprError {
        ExprError::new("expression is nested too deeply", self.peek().at)
    }

    fn ternary(&mut self, depth: usize) -> Result<ExprAst, ExprError> {
        if depth > MAX_PARSE_DEPTH {
            return Err(self.too_deep());
        }
        let c = self.binary(0, depth)?;
        if !self.is_op("?") {
            return Ok(c);
        }
        self.p += 1;
        let a = self.ternary(depth + 1)?;
        self.expect_op(":")?;
        let b = self.ternary(depth + 1)?;
        Ok(ExprAst::Cond { c: Box::new(c), a: Box::new(a), b: Box::new(b) })
    }

    fn binary(&mut self, min_prec: u8, depth: usize) -> Result<ExprAst, ExprError> {
        let mut left = self.unary(depth + 1)?;
        while let TokKind::Op(v) = self.peek().kind {
            let Some((op, prec)) = BinaryOp::from_op(v) else { break };
            if prec <= min_prec {
                break;
            }
            self.p += 1;
            let right = self.binary(prec, depth + 1)?;
            left = ExprAst::Binary { op, a: Box::new(left), b: Box::new(right) };
        }
        Ok(left)
    }

    fn unary(&mut self, depth: usize) -> Result<ExprAst, ExprError> {
        if depth > MAX_PARSE_DEPTH {
            return Err(self.too_deep());
        }
        let op = match self.peek().kind {
            TokKind::Op("!") => Some(UnaryOp::Not),
            TokKind::Op("-") => Some(UnaryOp::Neg),
            TokKind::Op("+") => Some(UnaryOp::Pos),
            _ => None,
        };
        if let Some(op) = op {
            self.p += 1;
            return Ok(ExprAst::Unary { op, a: Box::new(self.unary(depth + 1)?) });
        }
        let base = self.primary(depth)?;
        self.postfix(base, depth)
    }

    fn primary(&mut self, depth: usize) -> Result<ExprAst, ExprError> {
        let t = self.peek().clone();
        match t.kind {
            TokKind::Num(v) => {
                self.p += 1;
                Ok(ExprAst::Num(v))
            }
            TokKind::Str(v) => {
                self.p += 1;
                Ok(ExprAst::Str(v))
            }
            TokKind::Id(name) => {
                self.p += 1;
                match name.as_str() {
                    "true" => return Ok(ExprAst::Lit(Some(true))),
                    "false" => return Ok(ExprAst::Lit(Some(false))),
                    "null" => return Ok(ExprAst::Lit(None)),
                    _ => {}
                }
                if self.is_op("(") {
                    let Some(function) = ExprFunction::from_name(&name) else {
                        return Err(ExprError::new(
                            format!("unknown function {name}() — allowed: {}", allowed()),
                            t.at,
                        ));
                    };
                    self.p += 1;
                    let mut args = Vec::new();
                    if !self.is_op(")") {
                        loop {
                            args.push(self.ternary(depth + 1)?);
                            if !self.is_op(",") {
                                break;
                            }
                            self.p += 1;
                        }
                    }
                    self.expect_op(")")?;
                    return Ok(ExprAst::Call { function, args });
                }
                if FORBIDDEN_KEYS.contains(&name.as_str()) {
                    return Err(ExprError::new(format!("\"{name}\" is not allowed"), t.at));
                }
                Ok(ExprAst::Id(name))
            }
            TokKind::Op("(") => {
                self.p += 1;
                let inner = self.ternary(depth + 1)?;
                self.expect_op(")")?;
                Ok(inner)
            }
            TokKind::End => Err(ExprError::new("expression ends too early", t.at)),
            TokKind::Op(v) => Err(ExprError::new(format!("unexpected \"{v}\" at {}", t.at + 1), t.at)),
        }
    }

    fn postfix(&mut self, base: ExprAst, depth: usize) -> Result<ExprAst, ExprError> {
        let mut node = base;
        loop {
            if self.is_op(".") {
                self.p += 1;
                let t = self.peek().clone();
                let TokKind::Id(prop) = t.kind else {
                    return Err(ExprError::new(format!("expected a field name after \".\" at {}", t.at + 1), t.at));
                };
                if FORBIDDEN_KEYS.contains(&prop.as_str()) {
                    return Err(ExprError::new(format!("\"{prop}\" is not allowed"), t.at));
                }
                self.p += 1;
                if self.is_op("(") {
                    return Err(ExprError::new(format!("only {} can be called", allowed()), t.at));
                }
                node = ExprAst::Member { obj: Box::new(node), prop };
                continue;
            }
            if self.is_op("[") {
                self.p += 1;
                let index = self.ternary(depth + 1)?;
                self.expect_op("]")?;
                node = ExprAst::Index { obj: Box::new(node), index: Box::new(index) };
                continue;
            }
            if self.is_op("(") {
                return Err(ExprError::new(format!("only {} can be called", allowed()), self.peek().at));
            }
            return Ok(node);
        }
    }
}
