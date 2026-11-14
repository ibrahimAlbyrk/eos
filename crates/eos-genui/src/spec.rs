//! What surrounds a view: its id, the `present_app` check, and the text the two
//! tools hand back to the model.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::catalog::{GENUI_LIMITS, VIEW_ID_RE, ViewProblem, ViewStats, format_problems, stats_line};
use crate::js;
use crate::re::{is_match, pattern};
use crate::value::Value;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("must be a view id (v_ + 12 letters/digits)")]
    InvalidViewId,
}

/// The id of a rendered view: `v_` + 12 base62 characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ViewId(String);

impl ViewId {
    pub fn parse(id: &str) -> Result<Self, Error> {
        if is_match(&VIEW_ID_RE, id) { Ok(ViewId(id.to_owned())) } else { Err(Error::InvalidViewId) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ViewId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ViewId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let id = String::deserialize(d)?;
        ViewId::parse(&id).map_err(serde::de::Error::custom)
    }
}

const BASE62: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// A fresh view id. `random` fills the buffer it is given; it is asked again
/// until twelve usable bytes have come out.
pub fn new_view_id(mut random: impl FnMut(&mut [u8; 16])) -> ViewId {
    let mut out = String::with_capacity(14);
    out.push_str("v_");
    while out.len() < 14 {
        let mut bytes = [0u8; 16];
        random(&mut bytes);
        // 248 = 62 * 4: reject the tail so every character is equally likely.
        for byte in bytes.into_iter().filter(|b| *b < 248) {
            if out.len() < 14 {
                out.push(char::from(BASE62[usize::from(byte % 62)]));
            }
        }
    }
    ViewId(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppValidation {
    Ok { warnings: Vec<ViewProblem>, html_bytes: usize },
    Rejected { problems: Vec<ViewProblem>, warnings: Vec<ViewProblem> },
}

impl AppValidation {
    pub fn is_ok(&self) -> bool {
        matches!(self, AppValidation::Ok { .. })
    }
}

pattern!(HTML_DOC_RE, r"<html[\s>]", "i");
pattern!(HTML_TAG_RE, r"<[a-z!][^>]*>", "i");
pattern!(EXTERNAL_SCRIPT_RE, r"<script[^>]+\bsrc\s*=", "i");
pattern!(EXTERNAL_LINK_RE, r#"<link[^>]+\bhref\s*=\s*["']?https?:"#, "i");

const APP_FIELDS: &[&str] = &["title", "html", "summary", "height"];

/// `present_app`'s full check: one HTML document within the limits.
pub fn validate_app(input: &Value) -> AppValidation {
    let l = GENUI_LIMITS;
    let mut problems: Vec<ViewProblem> = Vec::new();
    let mut warnings: Vec<ViewProblem> = Vec::new();
    let Value::Object(o) = input else {
        return AppValidation::Rejected {
            problems: vec![ViewProblem::new("input", "must be an object with title, html and summary")],
            warnings,
        };
    };
    for key in o.keys().filter(|k| !APP_FIELDS.contains(k)) {
        warnings.push(ViewProblem::new(key, "is not a present_app field — ignored"));
    }
    let text = |key: &str| o.get(key).and_then(Value::as_str).filter(|s| !js::is_blank(s));
    let too_long =
        |s: &str, max: usize| (js::len16(s) > max).then(|| format!("is {} characters, max {max}", js::len16(s)));
    match text("title") {
        None => problems.push(ViewProblem::new("title", "is required — a short name for the app")),
        Some(title) => problems.extend(too_long(title, l.title_chars).map(|m| ViewProblem::new("title", m))),
    }
    match text("summary") {
        None => problems.push(ViewProblem::new("summary", "is required — what the app does, in plain text")),
        Some(summary) => problems.extend(too_long(summary, l.summary_chars).map(|m| ViewProblem::new("summary", m))),
    }
    if let Some(h) = o.get("height") {
        let fits = h
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n >= l.app_height_min as f64 && n <= l.app_height_max as f64);
        if !fits {
            problems.push(ViewProblem::new(
                "height",
                format!("{} is outside {}–{}", js::stringify(h), l.app_height_min, l.app_height_max),
            ));
        }
    }
    let mut html_bytes = 0;
    match text("html") {
        None => problems.push(ViewProblem::new("html", "is required — one self-contained HTML document")),
        Some(html) => {
            html_bytes = html.len();
            if html_bytes > l.app_html_bytes {
                let kb = (html_bytes as f64 / 1024.0 + 0.5).floor();
                problems.push(ViewProblem::new(
                    "html",
                    format!("is {kb} KB, max {} KB — inline less", l.app_html_bytes / 1024),
                ));
            }
            let docs = HTML_DOC_RE.find_iter(html).count();
            if docs > 1 {
                problems.push(ViewProblem::new("html", format!("holds {docs} <html> documents — send one")));
            }
            if !is_match(&HTML_TAG_RE, html) {
                problems.push(ViewProblem::new("html", "has no HTML tags — send an HTML document"));
            }
            if is_match(&EXTERNAL_SCRIPT_RE, html) || is_match(&EXTERNAL_LINK_RE, html) {
                warnings.push(ViewProblem::new(
                    "html",
                    "loads external files — the sandbox blocks the network, inline them",
                ));
            }
        }
    }
    if problems.is_empty() {
        AppValidation::Ok { warnings, html_bytes }
    } else {
        AppValidation::Rejected { problems, warnings }
    }
}

/// The body of a 400 from the view and app routes: `error` is what the tool
/// hands the model, `problems` the same list structured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenuiRejection {
    pub error: String,
    pub problems: Vec<ViewProblem>,
}

pub fn genui_rejection(problems: &[ViewProblem]) -> GenuiRejection {
    GenuiRejection { error: format_problems(problems), problems: problems.to_vec() }
}

/// The tool text when the user turned visual answers off.
pub const GENUI_OFF_TEXT: &str = "Visual answers are off — answer in text";

/// "view v_… rendered · 6 places · 2 images unresolved → monograms", then warnings.
pub fn present_success_text(
    view_id: &str,
    stats: &ViewStats,
    unresolved_images: usize,
    warnings: &[ViewProblem],
) -> String {
    let mut parts = vec![format!("view {view_id} rendered")];
    let line = stats_line(stats);
    if !line.is_empty() {
        parts.push(line);
    }
    if unresolved_images > 0 {
        parts.push(format!(
            "{unresolved_images} image{} unresolved → monograms",
            if unresolved_images == 1 { "" } else { "s" }
        ));
    }
    let head = parts.join(" · ");
    if warnings.is_empty() {
        return head;
    }
    let mut lines = vec![head, "warnings (fix next time, no need to re-present):".to_owned()];
    lines.extend(warnings.iter().map(|w| format!("· {}: {}", w.path, w.message)));
    lines.join("\n")
}

pub fn app_success_text(view_id: &str) -> String {
    format!("view {view_id} rendered · app")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&HTML_DOC_RE, &HTML_TAG_RE, &EXTERNAL_SCRIPT_RE, &EXTERNAL_LINK_RE] {
            assert!(!is_match(re, "\u{0}"));
        }
    }

    #[test]
    fn view_ids() {
        assert!(ViewId::parse("v_7Hq2abcdEFGH").is_ok());
        for bad in ["v_7Hq2", "v_7Hq2abcdEFG!", "x_7Hq2abcdEFGH", "v_7Hq2abcdEFGHI"] {
            assert_eq!(ViewId::parse(bad), Err(Error::InvalidViewId), "{bad}");
        }
        assert_eq!(new_view_id(|b| b.fill(0)).as_str(), "v_AAAAAAAAAAAA");
        let mut next = 247u8;
        let id = new_view_id(|b| {
            for slot in b.iter_mut() {
                next = next.wrapping_add(1);
                *slot = next;
            }
        });
        assert_eq!(id.as_str(), "v_ABCDEFGHIJKL");
    }
}
