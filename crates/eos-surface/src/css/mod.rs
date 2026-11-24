//! A page's style: one stylesheet in a CSS subset, read with `cssparser`,
//! checked strictly (a declaration Eos would drop is a problem, with its
//! line), written back from what was understood, and cascaded onto each
//! element for mail, which keeps only inline styles.

mod fonts;
mod props;
mod selector;
mod sheet;
mod tokens;

use crate::limits::STYLE_BYTES;
use crate::problem::Problem;

pub use fonts::{FAMILIES, Family, SYSTEM, font_faces};
pub use selector::ElementRef;
pub use sheet::{Decl, Media};

use sheet::{Problems, Rule, families_in, parse_inline, parse_sheet};

/// A stylesheet that passed every check.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StyleSheet {
    rules: Vec<Rule>,
}

/// What the page is drawn on, for which `@media` rules apply.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Medium {
    pub width: f32,
    pub print: bool,
    pub more_contrast: bool,
}

impl StyleSheet {
    pub fn sanitize(src: &str) -> Result<StyleSheet, Vec<Problem>> {
        if src.len() > STYLE_BYTES {
            return Err(vec![Problem::new("style", format!("is {} bytes, max {STYLE_BYTES}", src.len()))]);
        }
        let place = |line: u32, col: u32| format!("style:{line}:{col}");
        let mut problems = Problems { place: &place, list: Vec::new() };
        let rules = parse_sheet(src, &mut problems);
        if problems.list.is_empty() { Ok(StyleSheet { rules }) } else { Err(problems.list) }
    }

    /// The sheet as CSS: only what was understood, with custom properties
    /// resolved.
    pub fn to_css(&self) -> String {
        let mut out = String::new();
        for rule in &self.rules {
            let selectors: Vec<String> = rule.selectors.iter().map(|s| s.write()).collect();
            let body = write_decls(&rule.decls);
            let block = format!("{}{{{body}}}", selectors.join(","));
            match &rule.media {
                None => out.push_str(&block),
                Some(media) => out.push_str(&format!("@media {}{{{block}}}", media_text(media))),
            }
            out.push('\n');
        }
        out
    }

    /// Every shipped family a declaration names, for the faces to inline.
    pub fn families(&self) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        for decl in self.rules.iter().flat_map(|r| &r.decls).filter(|d| d.property == "font-family") {
            for family in families_in(&decl.value) {
                if !out.contains(&family) {
                    out.push(family);
                }
            }
        }
        out
    }

    /// The declarations that apply to the last element of `chain` (root
    /// first) on `medium`, in cascade order: a later one wins.
    pub fn cascade(&self, chain: &[ElementRef], medium: &Medium) -> Vec<Decl> {
        let mut matched: Vec<(bool, (usize, usize), usize, &Decl)> = Vec::new();
        let mut order = 0;
        for rule in self.rules.iter().filter(|r| applies(r.media.as_ref(), medium)) {
            let best = rule.selectors.iter().filter(|s| s.matches(chain)).map(|s| s.specificity()).max();
            for decl in &rule.decls {
                order += 1;
                if let Some(specificity) = best {
                    matched.push((decl.important, specificity, order, decl));
                }
            }
        }
        matched.sort_by_key(|(important, specificity, order, _)| (*important, *specificity, *order));
        matched.into_iter().map(|(_, _, _, decl)| decl.clone()).collect()
    }
}

fn applies(media: Option<&Media>, medium: &Medium) -> bool {
    match media {
        None => true,
        Some(Media::Print) => medium.print,
        Some(Media::MoreContrast) => medium.more_contrast,
        Some(Media::MaxWidth(px)) => medium.width <= *px,
        Some(Media::MinWidth(px)) => medium.width >= *px,
    }
}

fn media_text(media: &Media) -> String {
    match media {
        Media::Print => "print".into(),
        Media::MoreContrast => "(prefers-contrast: more)".into(),
        Media::MaxWidth(px) => format!("(max-width: {px}px)"),
        Media::MinWidth(px) => format!("(min-width: {px}px)"),
    }
}

/// Declarations as one `style=` value, the last of a property winning.
pub fn write_decls(decls: &[Decl]) -> String {
    decls
        .iter()
        .map(|d| format!("{}:{}{}", d.property, d.value, if d.important { " !important" } else { "" }))
        .collect::<Vec<_>>()
        .join(";")
}

/// Checks one `style=` attribute; problems name where it stands.
pub fn sanitize_inline(src: &str, place: &dyn Fn(u32, u32) -> String) -> Result<Vec<Decl>, Vec<Problem>> {
    let mut problems = Problems { place, list: Vec::new() };
    let decls = parse_inline(src, &mut problems);
    if problems.list.is_empty() { Ok(decls) } else { Err(problems.list) }
}
