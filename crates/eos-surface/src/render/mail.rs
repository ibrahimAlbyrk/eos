//! A page issue as mail (05 Q9): one column at most 640 px in a wrapper
//! table, every style inlined on its element, custom properties already
//! resolved, flex, grid and columns laid out as stacked blocks, web fonts
//! replaced by each family's fallback stack, images as `cid:` parts, and a
//! plain-text part drawn from the same template.

use crate::css::{Decl, ElementRef, FAMILIES, Medium, StyleSheet, write_decls};

use super::format::escape;
use super::{Mode, RenderInput, render_body};

use crate::limits::MAIL_WIDTH;

const MEDIUM: Medium = Medium { width: MAIL_WIDTH as f32, print: false, more_contrast: false };

/// Properties mail clients lay out differently or not at all: the blocks
/// they shape stack instead.
const DROPPED: &[&str] = &[
    "flex",
    "flex-direction",
    "flex-wrap",
    "flex-flow",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "justify-content",
    "justify-items",
    "align-items",
    "align-self",
    "align-content",
    "order",
    "grid",
    "grid-template-columns",
    "grid-template-rows",
    "grid-template-areas",
    "grid-column",
    "grid-row",
    "grid-area",
    "grid-auto-flow",
    "grid-auto-columns",
    "grid-auto-rows",
    "gap",
    "row-gap",
    "column-gap",
    "columns",
    "column-count",
    "column-width",
    "column-rule",
    "break-inside",
    "break-before",
    "break-after",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "text-wrap",
    "aspect-ratio",
    "object-fit",
    "object-position",
];

/// The two parts of a mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailBody {
    pub html: String,
    pub text: String,
}

/// The issue as a mail. `image_src` in `input` answers `cid:` names.
pub fn mail_body(input: &RenderInput<'_>) -> MailBody {
    let body = render_body(input, Mode::Mail);
    let title = escape(input.title);
    let html = format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title></head>\
<body style=\"margin:0;padding:0;background:#101010\">\
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#101010\"><tr><td align=\"center\" style=\"padding:24px 12px\">\
<table role=\"presentation\" width=\"{MAIL_WIDTH}\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:100%;max-width:{MAIL_WIDTH}px\"><tr>\
<td style=\"color:#e9e9e9;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;text-align:left\">{body}</td>\
</tr></table></td></tr></table></body></html>",
        lang = escape(input.lang),
    );
    MailBody { html, text: tidy_text(&render_body(input, Mode::Text)) }
}

/// The style one element of a mail carries: what the sheet gives it, then
/// its own, laid out for mail. The last of a property wins and stays.
pub(crate) fn inline_style(sheet: &StyleSheet, chain: &[ElementRef], own: Vec<Decl>) -> String {
    let mut decls = base(chain.last().map_or("", |el| el.name.as_str()));
    // The items of a flex or grid box stack: each its own block.
    if let Some((_, parent)) = chain.split_last()
        && !parent.is_empty()
        && sheet
            .cascade(parent, &MEDIUM)
            .iter()
            .rev()
            .find(|d| d.property == "display")
            .is_some_and(|d| d.value == "flex" || d.value == "grid")
    {
        decls.push(Decl { property: "display".into(), value: "block".into(), important: false });
    }
    decls.extend(sheet.cascade(chain, &MEDIUM));
    decls.extend(own);
    let mut kept: Vec<Decl> = Vec::new();
    for mut decl in decls {
        if DROPPED.contains(&decl.property.as_str()) {
            continue;
        }
        match decl.property.as_str() {
            "display" if matches!(decl.value.as_str(), "flex" | "grid") => decl.value = "block".into(),
            "font-family" => decl.value = mail_families(&decl.value),
            _ => {}
        }
        decl.value = first_of_clamp(&decl.value);
        kept.retain(|k| k.property != decl.property);
        kept.push(decl);
    }
    write_decls(&kept)
}

fn base(tag: &str) -> Vec<Decl> {
    let decl = |property: &str, value: &str| Decl { property: property.into(), value: value.into(), important: false };
    match tag {
        "img" => vec![decl("display", "block"), decl("max-width", "100%"), decl("height", "auto"), decl("border", "0")],
        "a" => vec![decl("color", "inherit")],
        _ => Vec::new(),
    }
}

/// A stack with each shipped family replaced by the faces mail has.
fn mail_families(stack: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for name in stack.split(',').map(|n| n.trim().to_owned()) {
        let bare = name.trim_matches(['"', '\'']);
        let names: Vec<String> = match FAMILIES.iter().find(|f| f.name.eq_ignore_ascii_case(bare)) {
            Some(family) => family.mail.split(',').map(|n| n.trim().to_owned()).collect(),
            None => vec![name],
        };
        for n in names {
            if !out.iter().any(|o| o.trim_matches(['"', '\'']).eq_ignore_ascii_case(n.trim_matches(['"', '\'']))) {
                out.push(n);
            }
        }
    }
    out.join(", ")
}

/// `clamp(40px, 6vw, 68px)` as its least value: mail clients that do not
/// know `clamp` drop the whole declaration.
fn first_of_clamp(value: &str) -> String {
    let Some(start) = value.find("clamp(") else { return value.to_owned() };
    let inner = &value[start + 6..];
    let Some(end) = inner.find(')') else { return value.to_owned() };
    let first = inner[..end].split(',').next().unwrap_or_default().trim();
    format!("{}{first}{}", &value[..start], first_of_clamp(&inner[end + 1..]))
}

/// Paragraphs apart by one blank line, lines trimmed.
fn tidy_text(raw: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in raw.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")) {
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(&line);
    }
    out.push('\n');
    out
}
