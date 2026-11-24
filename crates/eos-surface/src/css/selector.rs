//! The selectors a page may write: elements, classes, descendant and child,
//! lists, `:first-child`, `:last-child` and `:nth-child(odd|even)`. Matching
//! them is what inlines a style on each element of a mail.

use crate::template::ELEMENTS;

use super::tokens::{T, Tok};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Pseudo {
    FirstChild,
    LastChild,
    Odd,
    Even,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Compound {
    pub element: Option<String>,
    pub classes: Vec<String>,
    pub pseudo: Vec<Pseudo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Combinator {
    Descendant,
    Child,
}

/// One selector of a list: compounds left to right, each but the first with
/// how it hangs off the one before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selector {
    pub parts: Vec<(Combinator, Compound)>,
}

/// What matching needs of one element: its name, its classes, where it sits
/// among its parent's elements.
#[derive(Debug, Clone)]
pub struct ElementRef {
    pub name: String,
    pub classes: Vec<String>,
    /// 1-based.
    pub index: usize,
    pub last: bool,
}

impl Selector {
    /// `(classes and pseudo-classes, elements)`, compared as CSS does.
    pub(crate) fn specificity(&self) -> (usize, usize) {
        let classes = self.parts.iter().map(|(_, c)| c.classes.len() + c.pseudo.len()).sum();
        let elements = self.parts.iter().filter(|(_, c)| c.element.is_some()).count();
        (classes, elements)
    }

    /// Whether it selects the last element of `chain` (root first).
    pub(crate) fn matches(&self, chain: &[ElementRef]) -> bool {
        let Some(((_, last), rest)) = self.parts.split_last() else { return false };
        let Some((el, ancestors)) = chain.split_last() else { return false };
        compound_matches(last, el) && self.rest_match(rest, self.parts.last().map(|p| p.0), ancestors)
    }

    fn rest_match(
        &self,
        parts: &[(Combinator, Compound)],
        combinator: Option<Combinator>,
        chain: &[ElementRef],
    ) -> bool {
        let Some(((next_comb, compound), rest)) = parts.split_last() else { return true };
        match combinator {
            Some(Combinator::Child) => chain
                .split_last()
                .is_some_and(|(el, up)| compound_matches(compound, el) && self.rest_match(rest, Some(*next_comb), up)),
            _ => (0..chain.len())
                .rev()
                .any(|i| compound_matches(compound, &chain[i]) && self.rest_match(rest, Some(*next_comb), &chain[..i])),
        }
    }

    pub(crate) fn write(&self) -> String {
        let mut out = String::new();
        for (i, (comb, compound)) in self.parts.iter().enumerate() {
            if i > 0 {
                out.push_str(if *comb == Combinator::Child { ">" } else { " " });
            }
            if let Some(el) = &compound.element {
                out.push_str(el);
            }
            for class in &compound.classes {
                out.push('.');
                out.push_str(class);
            }
            for pseudo in &compound.pseudo {
                out.push_str(match pseudo {
                    Pseudo::FirstChild => ":first-child",
                    Pseudo::LastChild => ":last-child",
                    Pseudo::Odd => ":nth-child(odd)",
                    Pseudo::Even => ":nth-child(even)",
                });
            }
        }
        out
    }
}

fn compound_matches(c: &Compound, el: &ElementRef) -> bool {
    c.element.as_ref().is_none_or(|name| *name == el.name)
        && c.classes.iter().all(|class| el.classes.contains(class))
        && c.pseudo.iter().all(|p| match p {
            Pseudo::FirstChild => el.index == 1,
            Pseudo::LastChild => el.last,
            Pseudo::Odd => el.index % 2 == 1,
            Pseudo::Even => el.index.is_multiple_of(2),
        })
}

/// Reads a selector list, or says what in it a page may not write.
pub(crate) fn parse_list(prelude: &[T]) -> Result<Vec<Selector>, String> {
    let mut out = Vec::new();
    for piece in prelude.split(|t| t.tok == Tok::Comma) {
        out.push(parse_one(piece)?);
    }
    Ok(out)
}

fn parse_one(tokens: &[T]) -> Result<Selector, String> {
    let mut parts: Vec<(Combinator, Compound)> = Vec::new();
    let mut current = Compound::default();
    let mut pending = Combinator::Descendant;
    let mut in_compound = false;
    let mut i = 0;
    let finish = |parts: &mut Vec<(Combinator, Compound)>, current: &mut Compound, pending: Combinator| {
        parts.push((pending, std::mem::take(current)));
    };
    while i < tokens.len() {
        match &tokens[i].tok {
            Tok::Ws => {
                if in_compound {
                    finish(&mut parts, &mut current, pending);
                    pending = Combinator::Descendant;
                    in_compound = false;
                }
            }
            Tok::Delim('>') => {
                if in_compound {
                    finish(&mut parts, &mut current, pending);
                    in_compound = false;
                }
                if parts.is_empty() {
                    return Err("a selector may not start with >".into());
                }
                pending = Combinator::Child;
            }
            Tok::Ident(name) if !in_compound => {
                let name = name.to_ascii_lowercase();
                if !ELEMENTS.contains(&name.as_str()) {
                    return Err(format!("{name} is not an element a page may use"));
                }
                current.element = Some(name);
                in_compound = true;
            }
            Tok::Delim('.') => {
                let Some(Tok::Ident(class)) = tokens.get(i + 1).map(|t| &t.tok) else {
                    return Err("a . names a class".into());
                };
                current.classes.push(class.clone());
                in_compound = true;
                i += 1;
            }
            Tok::Colon => {
                let pseudo = match tokens.get(i + 1).map(|t| &t.tok) {
                    Some(Tok::Ident(name)) if name == "first-child" => Pseudo::FirstChild,
                    Some(Tok::Ident(name)) if name == "last-child" => Pseudo::LastChild,
                    Some(Tok::Func(name, args)) if name == "nth-child" => match super::tokens::write(args).as_str() {
                        "odd" => Pseudo::Odd,
                        "even" => Pseudo::Even,
                        other => return Err(format!(":nth-child({other}) takes odd or even")),
                    },
                    _ => {
                        return Err(
                            "the only pseudo-classes are :first-child, :last-child and :nth-child(odd|even)".into()
                        );
                    }
                };
                current.pseudo.push(pseudo);
                in_compound = true;
                i += 1;
            }
            Tok::Delim('*') => return Err("* selects every element: name the element or a class".into()),
            Tok::Hash(_) => return Err("a page has no ids: select a class".into()),
            Tok::Square(_) => return Err("a page has no attribute selectors: select a class".into()),
            Tok::Bad(what) => return Err(format!("{what} may not be in a selector")),
            _ => return Err("is not a selector a page may write".into()),
        }
        i += 1;
    }
    if in_compound {
        finish(&mut parts, &mut current, pending);
    } else if pending == Combinator::Child || parts.is_empty() {
        return Err("a selector is missing".into());
    }
    Ok(Selector { parts })
}
