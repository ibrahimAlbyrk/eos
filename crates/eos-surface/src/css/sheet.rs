//! Reading a page's stylesheet into rules Eos understood, refusing what a page
//! may not say, and resolving custom properties to their values.

use std::collections::HashMap;

use crate::problem::Problem;

use super::fonts;
use super::props::{FUNCTIONS, PROPERTIES, REFUSED, narrowed};
use super::selector::{Selector, parse_list};
use super::tokens::{T, Tok, read, write};

/// Where a rule applies besides the screen at any width.
#[derive(Debug, Clone, PartialEq)]
pub enum Media {
    MaxWidth(f32),
    MinWidth(f32),
    Print,
    MoreContrast,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decl {
    pub property: String,
    pub value: String,
    pub important: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Rule {
    pub media: Option<Media>,
    pub selectors: Vec<Selector>,
    pub decls: Vec<Decl>,
}

/// Collects problems at `style:<line>:<col>` (or the place an inline style
/// stands).
pub(crate) struct Problems<'a> {
    pub place: &'a dyn Fn(u32, u32) -> String,
    pub list: Vec<Problem>,
}

impl Problems<'_> {
    pub(crate) fn add(&mut self, t: &T, message: impl Into<String>) {
        self.list.push(Problem::new((self.place)(t.line, t.col), message));
    }
}

/// Raw declarations before custom properties are resolved.
struct RawDecl {
    property: String,
    value: Vec<T>,
    important: bool,
    at: T,
}

pub(crate) fn parse_sheet(src: &str, problems: &mut Problems<'_>) -> Vec<Rule> {
    let tokens = read(src, 1);
    let mut raw_rules: Vec<(Option<Media>, Vec<Selector>, Vec<RawDecl>)> = Vec::new();
    rules(&tokens, None, problems, &mut raw_rules);
    let mut custom: HashMap<String, Vec<T>> = HashMap::new();
    for (_, _, decls) in &raw_rules {
        for decl in decls.iter().filter(|d| d.property.starts_with("--")) {
            custom.insert(decl.property.clone(), decl.value.clone());
        }
    }
    raw_rules
        .into_iter()
        .map(|(media, selectors, decls)| Rule { media, selectors, decls: finish(decls, &custom, problems) })
        .filter(|rule| !rule.decls.is_empty())
        .collect()
}

/// A `style=` attribute's declarations, with no custom properties of its own.
pub(crate) fn parse_inline(src: &str, problems: &mut Problems<'_>) -> Vec<Decl> {
    let tokens = read(src, 0);
    let decls = declarations(&tokens, problems);
    finish(decls, &HashMap::new(), problems)
}

fn rules(
    tokens: &[T],
    media: Option<&Media>,
    problems: &mut Problems<'_>,
    out: &mut Vec<(Option<Media>, Vec<Selector>, Vec<RawDecl>)>,
) {
    let mut prelude: Vec<T> = Vec::new();
    for t in tokens {
        match &t.tok {
            Tok::Curly(body) => {
                let prelude_now = std::mem::take(&mut prelude);
                let first = prelude_now.iter().find(|p| p.tok != Tok::Ws);
                if let Some(at @ T { tok: Tok::At(name), .. }) = first {
                    if name != "media" {
                        problems.add(at, format!("@{name} is refused: a page may use @media only"));
                        continue;
                    }
                    if media.is_some() {
                        problems.add(at, "@media may not sit inside @media");
                        continue;
                    }
                    let condition: Vec<T> =
                        prelude_now.iter().skip_while(|p| p.tok != Tok::At("media".into())).skip(1).cloned().collect();
                    match parse_media(&condition) {
                        Ok(m) => rules(body, Some(&m), problems, out),
                        Err(message) => problems.add(at, message),
                    }
                    continue;
                }
                let Some(at) = first else {
                    problems.add(t, "a rule has no selector");
                    continue;
                };
                match parse_list(&prelude_now) {
                    Ok(selectors) => out.push((media.cloned(), selectors, declarations(body, problems))),
                    Err(message) => problems.add(at, message),
                }
            }
            Tok::Semi => {
                if let Some(at) = prelude.iter().find(|p| p.tok != Tok::Ws) {
                    let message = match &at.tok {
                        Tok::At(name) => format!("@{name} is refused: a page may use @media only"),
                        _ => "a declaration outside a rule".into(),
                    };
                    problems.add(at, message);
                }
                prelude.clear();
            }
            _ => prelude.push(t.clone()),
        }
    }
    if let Some(at) = prelude.iter().find(|p| p.tok != Tok::Ws) {
        problems.add(at, "a rule is never finished");
    }
}

fn parse_media(condition: &[T]) -> Result<Media, String> {
    let words: Vec<&T> = condition.iter().filter(|t| t.tok != Tok::Ws).collect();
    let words: &[&T] = match words.as_slice() {
        [T { tok: Tok::Ident(screen), .. }, T { tok: Tok::Ident(and), .. }, rest @ ..]
            if screen == "screen" && and == "and" =>
        {
            rest
        }
        all => all,
    };
    let refused = || "@media takes print, (max-width: …px), (min-width: …px) or (prefers-contrast: more)".to_owned();
    match words {
        [T { tok: Tok::Ident(print), .. }] if print == "print" => Ok(Media::Print),
        [T { tok: Tok::Paren(inner), .. }] => {
            let inner: Vec<&T> = inner.iter().filter(|t| t.tok != Tok::Ws).collect();
            match inner.as_slice() {
                [T { tok: Tok::Ident(feature), .. }, T { tok: Tok::Colon, .. }, T { tok: value, .. }] => {
                    match (feature.as_str(), value) {
                        ("prefers-contrast", Tok::Ident(more)) if more == "more" => Ok(Media::MoreContrast),
                        ("max-width" | "min-width", Tok::Num(n)) => {
                            let px: f32 = n.strip_suffix("px").and_then(|v| v.parse().ok()).ok_or_else(refused)?;
                            Ok(if feature == "max-width" { Media::MaxWidth(px) } else { Media::MinWidth(px) })
                        }
                        _ => Err(refused()),
                    }
                }
                _ => Err(refused()),
            }
        }
        _ => Err(refused()),
    }
}

fn declarations(tokens: &[T], problems: &mut Problems<'_>) -> Vec<RawDecl> {
    let mut out = Vec::new();
    for piece in tokens.split(|t| t.tok == Tok::Semi) {
        let mut items = piece.iter().skip_while(|t| t.tok == Tok::Ws);
        let Some(name) = items.next() else { continue };
        let Tok::Ident(property) = &name.tok else {
            problems.add(name, "a declaration starts with a property name");
            continue;
        };
        let property = if property.starts_with("--") { property.clone() } else { property.to_ascii_lowercase() };
        if !matches!(items.find(|t| t.tok != Tok::Ws).map(|t| &t.tok), Some(Tok::Colon)) {
            problems.add(name, format!("{property} needs a : and a value"));
            continue;
        }
        let mut value: Vec<T> = items.cloned().collect();
        let important = strip_important(&mut value);
        if value.iter().all(|t| t.tok == Tok::Ws) {
            problems.add(name, format!("{property} has no value"));
            continue;
        }
        out.push(RawDecl { property, value, important, at: name.clone() });
    }
    out
}

fn strip_important(value: &mut Vec<T>) -> bool {
    while value.last().is_some_and(|t| t.tok == Tok::Ws) {
        value.pop();
    }
    let n = value.len();
    let is_important = n >= 2
        && matches!(&value[n - 1].tok, Tok::Ident(i) if i.eq_ignore_ascii_case("important"))
        && value[n - 2].tok == Tok::Delim('!');
    if is_important {
        value.truncate(n - 2);
    }
    is_important
}

/// Checks each declaration and resolves `var()`; custom properties
/// themselves are not written out.
fn finish(decls: Vec<RawDecl>, custom: &HashMap<String, Vec<T>>, problems: &mut Problems<'_>) -> Vec<Decl> {
    let mut out = Vec::new();
    for decl in decls {
        if decl.property.starts_with("--") {
            continue;
        }
        if let Some((_, why)) = REFUSED.iter().find(|(p, _)| *p == decl.property) {
            problems.add(&decl.at, format!("{} is refused: {why}", decl.property));
            continue;
        }
        if !PROPERTIES.contains(&decl.property.as_str()) {
            problems.add(&decl.at, format!("{} is not a property a page may set", decl.property));
            continue;
        }
        let value = match resolve(&decl.value, custom, 0) {
            Ok(value) => value,
            Err(message) => {
                problems.add(&decl.at, format!("{}: {message}", decl.property));
                continue;
            }
        };
        if let Err(message) = check_value(&value) {
            problems.add(&decl.at, format!("{}: {message}", decl.property));
            continue;
        }
        let written = write(&value);
        if let Some(allowed) = narrowed(&decl.property)
            && !allowed.contains(&written.as_str())
        {
            problems.add(&decl.at, format!("{}: {written} is refused; it takes {}", decl.property, allowed.join(", ")));
            continue;
        }
        if decl.property == "font-family"
            && let Err(message) = check_families(&value)
        {
            problems.add(&decl.at, message);
            continue;
        }
        out.push(Decl { property: decl.property, value: written, important: decl.important });
    }
    out
}

const VAR_DEPTH: usize = 8;

fn resolve(value: &[T], custom: &HashMap<String, Vec<T>>, depth: usize) -> Result<Vec<T>, String> {
    if depth > VAR_DEPTH {
        return Err("custom properties refer to each other too deeply".into());
    }
    let mut out = Vec::new();
    for t in value {
        match &t.tok {
            Tok::Func(name, args) if name == "var" => {
                let mut parts = args.splitn(2, |a| a.tok == Tok::Comma);
                let head = parts.next().unwrap_or_default();
                let fallback = parts.next();
                let Some(Tok::Ident(var)) = head.iter().find(|a| a.tok != Tok::Ws).map(|a| &a.tok) else {
                    return Err("var() names a custom property: var(--ink)".into());
                };
                match custom.get(var).map(Vec::as_slice).or(fallback) {
                    Some(found) => out.extend(resolve(found, custom, depth + 1)?),
                    None => return Err(format!("var({var}) is never set")),
                }
            }
            Tok::Func(name, args) => {
                out.push(T { tok: Tok::Func(name.clone(), resolve(args, custom, depth)?), ..t.clone() });
            }
            Tok::Paren(args) => out.push(T { tok: Tok::Paren(resolve(args, custom, depth)?), ..t.clone() }),
            _ => out.push(t.clone()),
        }
    }
    Ok(out)
}

const LOADS: &str = "url() is refused: a page loads nothing";

fn check_value(value: &[T]) -> Result<(), String> {
    for t in value {
        match &t.tok {
            Tok::Bad("url()") => return Err(LOADS.into()),
            Tok::Bad(what) => return Err(format!("{what} is refused")),
            Tok::Func(name, args) => {
                if name == "url" {
                    return Err(LOADS.into());
                }
                if !FUNCTIONS.contains(&name.as_str()) {
                    return Err(format!("{name}() is not a function a page may use"));
                }
                check_value(args)?;
            }
            Tok::Paren(args) => check_value(args)?,
            Tok::Curly(_) | Tok::Square(_) => return Err("a bracket block is not a value".into()),
            Tok::At(_) | Tok::Semi | Tok::Colon => return Err("is not a value".into()),
            Tok::Str(text) if text.contains(['<', '>']) => return Err("a string may not hold < or >".into()),
            Tok::Ident(text) | Tok::Hash(text) if text.contains(['<', '>']) => {
                return Err("a name may not hold < or >".into());
            }
            Tok::Delim(c) if !matches!(c, '/' | '+' | '-' | '*' | '.' | '%') => {
                return Err(format!("{c} is not part of a value"));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Each family of a `font-family` stack must be one Eos knows.
fn check_families(value: &[T]) -> Result<(), String> {
    for family in value.split(|t| t.tok == Tok::Comma) {
        let name = match family.iter().filter(|t| t.tok != Tok::Ws).collect::<Vec<_>>().as_slice() {
            [T { tok: Tok::Str(name), .. }] => name.clone(),
            words => words
                .iter()
                .map(|t| match &t.tok {
                    Tok::Ident(word) => Ok(word.clone()),
                    _ => Err("font-family names families".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?
                .join(" "),
        };
        if fonts::known(&name).is_none() {
            let shipped: Vec<&str> = fonts::FAMILIES.iter().map(|f| f.name).collect();
            return Err(format!(
                "font-family: {name} is not a font Eos has: {}, or {}",
                shipped.join(", "),
                fonts::SYSTEM.join(", ")
            ));
        }
    }
    Ok(())
}

/// The shipped families a stack names, first one first.
pub(crate) fn families_in(value: &str) -> Vec<&'static str> {
    value
        .split(',')
        .filter_map(|name| fonts::known(name.trim().trim_matches(['"', '\''])))
        .filter(|name| fonts::shipped(name).is_some())
        .collect()
}
