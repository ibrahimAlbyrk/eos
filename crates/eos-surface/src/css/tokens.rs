//! A stylesheet as a tree of plain tokens, read with `cssparser`. Every later
//! step walks this tree; nothing of the source text is copied through, so
//! what Eos writes out is only what it understood.

use cssparser::{ParseError, Parser, ParserInput, ToCss, Token};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Ident(String),
    At(String),
    Hash(String),
    Str(String),
    /// A number, percentage or dimension, written as CSS.
    Num(String),
    Delim(char),
    Ws,
    Colon,
    Semi,
    Comma,
    Func(String, Vec<T>),
    Paren(Vec<T>),
    Square(Vec<T>),
    Curly(Vec<T>),
    /// Something a page may never write, with what it is.
    Bad(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct T {
    pub tok: Tok,
    /// 1-based, as problems name a line.
    pub line: u32,
    pub col: u32,
}

pub(crate) fn read(src: &str, first_line: u32) -> Vec<T> {
    let mut input = ParserInput::new(src);
    let mut parser = Parser::new(&mut input);
    let mut out = Vec::new();
    read_into(&mut parser, first_line, &mut out);
    out
}

fn read_into(p: &mut Parser<'_, '_>, first_line: u32, out: &mut Vec<T>) {
    loop {
        let at = p.current_source_location();
        let (line, col) = (at.line + first_line, at.column);
        let Ok(token) = p.next_including_whitespace() else { return };
        let token = token.clone();
        let tok = match &token {
            Token::Ident(v) => Tok::Ident(v.to_string()),
            Token::AtKeyword(v) => Tok::At(v.to_ascii_lowercase()),
            Token::Hash(v) | Token::IDHash(v) => Tok::Hash(v.to_string()),
            Token::QuotedString(v) => Tok::Str(v.to_string()),
            Token::Number { .. } | Token::Percentage { .. } | Token::Dimension { .. } => {
                Tok::Num(token.to_css_string())
            }
            Token::Delim(c) => Tok::Delim(*c),
            Token::WhiteSpace(_) => Tok::Ws,
            Token::Comment(_) => continue,
            Token::Colon => Tok::Colon,
            Token::Semicolon => Tok::Semi,
            Token::Comma => Tok::Comma,
            Token::UnquotedUrl(_) | Token::BadUrl(_) => Tok::Bad("url()"),
            Token::BadString(_) => Tok::Bad("a string that never closes"),
            Token::CDO | Token::CDC => Tok::Bad("an HTML comment mark"),
            Token::Function(name) => Tok::Func(name.to_ascii_lowercase(), nested(p, first_line)),
            Token::ParenthesisBlock => Tok::Paren(nested(p, first_line)),
            Token::SquareBracketBlock => Tok::Square(nested(p, first_line)),
            Token::CurlyBracketBlock => Tok::Curly(nested(p, first_line)),
            Token::CloseParenthesis | Token::CloseSquareBracket | Token::CloseCurlyBracket => {
                Tok::Bad("a bracket that closes nothing")
            }
            Token::IncludeMatch
            | Token::DashMatch
            | Token::PrefixMatch
            | Token::SuffixMatch
            | Token::SubstringMatch => Tok::Bad("an attribute selector"),
        };
        out.push(T { tok, line, col });
    }
}

fn nested(p: &mut Parser<'_, '_>, first_line: u32) -> Vec<T> {
    let mut inner = Vec::new();
    let _ = p.parse_nested_block(|p| {
        read_into(p, first_line, &mut inner);
        Ok::<(), ParseError<'_, ()>>(())
    });
    inner
}

/// Tokens as CSS, white space folded to one space.
pub(crate) fn write(tokens: &[T]) -> String {
    let mut out = String::new();
    for t in tokens {
        write_one(&t.tok, &mut out);
    }
    out.trim().to_owned()
}

fn write_one(tok: &Tok, out: &mut String) {
    match tok {
        Tok::Ident(v) => {
            let _ = cssparser::serialize_identifier(v, out);
        }
        Tok::At(v) => {
            out.push('@');
            out.push_str(v);
        }
        Tok::Hash(v) => {
            out.push('#');
            let _ = cssparser::serialize_name(v, out);
        }
        Tok::Str(v) => {
            let _ = cssparser::serialize_string(v, out);
        }
        Tok::Num(v) => out.push_str(v),
        Tok::Delim(c) => out.push(*c),
        Tok::Ws => {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        }
        Tok::Colon => out.push(':'),
        Tok::Semi => out.push(';'),
        Tok::Comma => out.push(','),
        Tok::Func(name, inner) => {
            out.push_str(name);
            out.push('(');
            out.push_str(&write(inner));
            out.push(')');
        }
        Tok::Paren(inner) => {
            out.push('(');
            out.push_str(&write(inner));
            out.push(')');
        }
        Tok::Square(inner) => {
            out.push('[');
            out.push_str(&write(inner));
            out.push(']');
        }
        Tok::Curly(inner) => {
            out.push('{');
            out.push_str(&write(inner));
            out.push('}');
        }
        Tok::Bad(_) => {}
    }
}
