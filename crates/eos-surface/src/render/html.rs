//! The template tree drawn as HTML for one mode. Data reaches the output only
//! through [`escape`], a checked `http(s)` link or a stored image; every
//! element and attribute written is one the template checks allowed.

use serde_json::Value;

use crate::css::{sanitize_inline, write_decls};
use crate::template::{AttrValue, Element, Node, Seg, TextNode};

use super::format::{escape, has_bidi_controls, plain};
use super::{ImageState, Mode, RenderInput, truthy};

/// What a masked secret shows.
pub(crate) const MASK: &str = "••••";
const VOID: &[&str] = &["hr", "br", "img"];
/// Attributes the walker writes itself or that only steer it.
const STEERING: &[&str] = &["part", "each", "as", "if", "unless", "class", "style", "src", "href", "alt"];

/// The page's body: the template drawn with the issue's data.
pub fn render_body(input: &RenderInput<'_>, mode: Mode) -> String {
    let issue = input.issue.as_value();
    let filters = filters_of(&input.design.template.nodes);
    let mut walker = Walker {
        input,
        mode,
        issue: &issue,
        vars: Vec::new(),
        live: None,
        index: Vec::new(),
        filters,
        out: String::new(),
    };
    walker.nodes(&input.design.template.nodes);
    walker.out
}

struct Walker<'a, 'i> {
    input: &'a RenderInput<'i>,
    mode: Mode,
    issue: &'a Value,
    vars: Vec<(&'a str, &'a Value)>,
    live: Option<&'a Value>,
    /// The index of each repeat the walk is inside, innermost last.
    index: Vec<usize>,
    /// `(of, by)` of each Filters, for the repeats they narrow.
    filters: Vec<(String, String)>,
    out: String,
}

impl<'a> Walker<'a, '_> {
    fn resolve(&self, path: &str) -> Option<&'a Value> {
        let mut names = path.split('.');
        let first = names.next()?;
        let root: &'a Value = if let Some((_, value)) = self.vars.iter().rev().find(|(name, _)| *name == first) {
            value
        } else if first == "issue" {
            self.issue
        } else if first == "query" {
            self.live?
        } else {
            self.input.data.get(first)?
        };
        names.try_fold(root, |value, name| value.get(name)).filter(|v| !v.is_null())
    }

    fn nodes(&mut self, nodes: &'a [Node]) {
        for node in nodes {
            match node {
                Node::Text(text) => self.text(text),
                Node::Element(el) => self.element(el),
            }
        }
    }

    fn text(&mut self, text: &TextNode) {
        if text.space_before {
            self.out.push(' ');
        }
        for seg in &text.segs {
            match seg {
                Seg::Lit(lit) => self.out.push_str(&escape(lit)),
                Seg::Slot(slot) => {
                    let value = self.resolve(&slot.path).map(|v| plain(v, slot.format.as_ref(), self.input.offset));
                    let value = value.unwrap_or_default();
                    let html = self.text_html(&value);
                    self.out.push_str(&html);
                }
            }
        }
        if text.space_after {
            self.out.push(' ');
        }
    }

    /// A value in an element's text: masked when it looks like a secret,
    /// paragraphs kept, a run that turns the text direction isolated.
    fn text_html(&self, value: &str) -> String {
        if (self.input.is_secret)(value) {
            return format!("<span class=\"eos-secret\" title=\"hidden: looks like a secret\">{MASK}</span>");
        }
        let paragraphs: Vec<String> = value
            .split("\n\n")
            .map(|p| escape(&p.split_whitespace().collect::<Vec<_>>().join(" ")))
            .filter(|p| !p.is_empty())
            .collect();
        let html = paragraphs.join("<br><br>");
        if has_bidi_controls(value) { format!("<bdi>{html}</bdi>") } else { html }
    }

    /// A value in an attribute: masked, escaped.
    fn attr_text(&self, segs: &[Seg]) -> String {
        let mut out = String::new();
        for seg in segs {
            match seg {
                Seg::Lit(lit) => out.push_str(lit),
                Seg::Slot(slot) => {
                    let value = self.resolve(&slot.path).map(|v| plain(v, slot.format.as_ref(), self.input.offset));
                    let value = value.unwrap_or_default();
                    if (self.input.is_secret)(&value) {
                        out.push_str(MASK);
                    } else {
                        out.push_str(&value);
                    }
                }
            }
        }
        escape(&out)
    }

    fn element(&mut self, el: &'a Element) {
        if let Some(path) = el.literal("if")
            && !truthy(self.resolve(path))
        {
            return;
        }
        if let Some(path) = el.literal("unless")
            && truthy(self.resolve(path))
        {
            return;
        }
        let Some(list_path) = el.literal("each") else { return self.one(el, None) };
        let Some(Value::Array(items)) = self.resolve(list_path) else { return };
        let name = el.literal("as").unwrap_or("item");
        let filter_by = self.filters.iter().find(|(of, _)| of == list_path).map(|(_, by)| by.clone());
        for (i, item) in items.iter().enumerate() {
            self.vars.push((name, item));
            self.index.push(i);
            let filter = filter_by.as_ref().map(|by| {
                let value = item.get(by).and_then(Value::as_str).unwrap_or_default().to_owned();
                (list_path.to_owned(), value)
            });
            self.one(el, filter);
            self.index.pop();
            self.vars.pop();
        }
    }

    /// One copy of an element; `filter` marks a repeat's item a Filters narrows.
    fn one(&mut self, el: &'a Element, filter: Option<(String, String)>) {
        if el.is_component() {
            return self.component(el);
        }
        match el.name.as_str() {
            "img" => return self.image(el),
            "a" => return self.link(el),
            _ => {}
        }
        self.open(&el.name, el, filter);
        if !VOID.contains(&el.name.as_str()) {
            self.nodes(&el.children);
            self.close(&el.name);
        }
    }

    fn open(&mut self, tag: &str, el: &Element, filter: Option<(String, String)>) {
        self.out.push('<');
        self.out.push_str(tag);
        if let Some(AttrValue::Text(segs)) = el.attr("class") {
            let class: String = self
                .attr_text(segs)
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { ' ' })
                .collect();
            let class = class.split_whitespace().collect::<Vec<_>>().join(" ");
            if !class.is_empty() {
                self.out.push_str(&format!(" class=\"{class}\""));
            }
        }
        if let Some(style) = el.literal("style")
            && let Ok(decls) = sanitize_inline(style, &|_, _| String::new())
        {
            self.out.push_str(&format!(" style=\"{}\"", escape(&write_decls(&decls))));
        }
        for attr in el.attrs.iter().filter(|a| !STEERING.contains(&a.name.as_str())) {
            if let AttrValue::Text(segs) = &attr.value {
                let value = self.attr_text(segs);
                self.out.push_str(&format!(" {}=\"{value}\"", attr.name));
            }
        }
        if let Some(alt) = el.attr("alt").and_then(text_segs) {
            let alt = self.attr_text(alt);
            self.out.push_str(&format!(" alt=\"{alt}\""));
        }
        self.marks(el);
        if let Some((of, value)) = filter
            && self.mode == Mode::Frame
        {
            self.out.push_str(&format!(" data-filter-of=\"{}\" data-filter-value=\"{}\"", escape(&of), escape(&value)));
        }
        self.out.push('>');
    }

    /// `data-part` and `data-index`, which pointing, reading signals and
    /// printing read; mail has no use for them.
    fn marks(&mut self, el: &Element) {
        if self.mode == Mode::Mail {
            return;
        }
        if let Some(part) = el.part() {
            self.out.push_str(&format!(" data-part=\"{}\"", escape(part)));
            if let Some(i) = self.index.last() {
                self.out.push_str(&format!(" data-index=\"{i}\""));
            }
        }
    }

    fn close(&mut self, tag: &str) {
        self.out.push_str(&format!("</{tag}>"));
    }

    fn image(&mut self, el: &'a Element) {
        let image = match el.attr("src") {
            Some(AttrValue::Text(segs)) => match segs.as_slice() {
                [Seg::Slot(slot)] => self.resolve(&slot.path),
                _ => None,
            },
            _ => None,
        };
        let src = image.and_then(|i| i.get("src")).and_then(Value::as_str);
        let stored = src.and_then(|src| match self.input.images.get(src) {
            Some(ImageState::Ready { hash }) => (self.input.image_src)(hash),
            _ => None,
        });
        match stored {
            Some(url) => {
                self.open("img", el, None);
                // The src is Eos's own: a raw-origin path, a data: URI or a cid:.
                let tail = format!(" src=\"{}\" decoding=\"async\">", escape(&url));
                self.out.pop();
                self.out.push_str(&tail);
            }
            None => {
                let alt = el.attr("alt").and_then(text_segs).map(|segs| self.attr_text(segs)).unwrap_or_default();
                self.out.push_str("<span class=\"eos-image-missing\" role=\"img\"");
                self.out.push_str(&format!(" aria-label=\"{alt}\""));
                self.marks(el);
                self.out.push_str(&format!(">{alt}</span>"));
            }
        }
    }

    fn link(&mut self, el: &'a Element) {
        let target = match el.attr("href") {
            Some(AttrValue::Text(segs)) => match segs.as_slice() {
                [Seg::Lit(eos)] if eos.starts_with("eos:") => Some(self.eos_target(eos)),
                [Seg::Slot(slot)] => {
                    self.resolve(&slot.path).and_then(Value::as_str).filter(|u| is_web(u)).map(str::to_owned)
                }
                _ => None,
            },
            _ => None,
        };
        let Some(href) = target else {
            self.open("span", el, None);
            self.nodes(&el.children);
            return self.close("span");
        };
        self.open("a", el, None);
        self.out.pop();
        self.out.push_str(&format!(" href=\"{}\" rel=\"noopener noreferrer\">", escape(&href)));
        self.nodes(&el.children);
        self.close("a");
    }

    /// `eos:needs-you` in the frame (its runtime opens it); `eos://needs-you`
    /// everywhere else, which opens Eos.
    fn eos_target(&self, target: &str) -> String {
        match self.mode {
            Mode::Frame => target.to_owned(),
            _ => format!("eos://{}", &target["eos:".len()..]),
        }
    }

    fn component(&mut self, el: &'a Element) {
        let part = el.part().unwrap_or_default().to_owned();
        let label = el.attr("label").and_then(text_segs).map(|segs| self.attr_text(segs)).unwrap_or_default();
        let index = self.index.last().copied();
        match (el.name.as_str(), self.mode) {
            ("Filters", Mode::Frame) => self.filter_chips(el),
            ("Filters", _) => {}
            ("Disclosure", Mode::Mail) => {
                let title = el.attr("title").and_then(text_segs).map(|s| self.attr_text(s)).unwrap_or_default();
                self.out.push_str(&format!("<div><p><strong>{title}</strong></p>"));
                self.nodes(&el.children);
                self.out.push_str("</div>");
            }
            ("Disclosure", _) => {
                let title = el.attr("title").and_then(text_segs).map(|s| self.attr_text(s)).unwrap_or_default();
                self.out.push_str("<details class=\"eos-disclosure\"");
                self.marks(el);
                self.out.push_str(&format!("><summary>{title}</summary>"));
                self.nodes(&el.children);
                self.out.push_str("</details>");
            }
            ("Button" | "Ask", Mode::Frame) => {
                let kind = if el.name == "Ask" { "ask" } else { "button" };
                self.out.push_str(&format!(
                    "<button type=\"button\" class=\"eos-{kind}\" data-{kind}=\"{}\"",
                    escape(&part)
                ));
                self.marks(el);
                self.out.push_str(&format!(">{label}</button>"));
            }
            ("Button" | "Ask", Mode::Phone) => {
                let index = index.map(|i| i.to_string()).unwrap_or_default();
                let href = format!("eos-action:{}/{}/{index}", self.input.issue.id, part);
                self.out.push_str(&format!("<a class=\"eos-button\" href=\"{}\"", escape(&href)));
                self.marks(el);
                self.out.push_str(&format!(">{label}</a>"));
            }
            ("Button" | "Ask", Mode::Mail) => {
                let mut href = format!("eos://issue/{}?button={part}", self.input.issue.id);
                if let Some(i) = index {
                    href.push_str(&format!("&index={i}"));
                }
                self.out.push_str(&format!("<a href=\"{}\">{label} · Open in Eos</a>", escape(&href)));
            }
            ("Button" | "Ask", Mode::Share) => {}
            ("Live", _) => {
                let answer = self.input.live.get(&part);
                if self.mode != Mode::Frame && answer.is_none() {
                    return;
                }
                let query = el.literal("query").unwrap_or_default();
                self.out.push_str("<div class=\"eos-live\"");
                self.marks(el);
                if self.mode == Mode::Frame {
                    self.out.push_str(&format!(" data-live=\"{}\"", escape(query)));
                }
                self.out.push('>');
                if let Some(answer) = answer {
                    let outer = self.live.replace(answer);
                    self.nodes(&el.children);
                    self.live = outer;
                }
                self.out.push_str("</div>");
            }
            _ => {}
        }
    }

    /// One chip for all, then one per value the repeated items hold, in the
    /// order they first appear.
    fn filter_chips(&mut self, el: &Element) {
        let (Some(of), Some(by)) = (el.literal("of"), el.literal("by")) else { return };
        let mut values: Vec<String> = Vec::new();
        if let Some(Value::Array(items)) = self.resolve(of) {
            for value in items.iter().filter_map(|item| item.get(by).and_then(Value::as_str)) {
                if !values.iter().any(|v| v == value) {
                    values.push(value.to_owned());
                }
            }
        }
        self.out.push_str(&format!("<div class=\"eos-filters\" role=\"toolbar\" data-filters=\"{}\"", escape(of)));
        self.marks(el);
        self.out.push_str("><button type=\"button\" data-filter=\"\" aria-pressed=\"true\">All</button>");
        for value in values {
            let text = if (self.input.is_secret)(&value) { MASK.to_owned() } else { escape(&value) };
            self.out.push_str(&format!(
                "<button type=\"button\" data-filter=\"{}\" aria-pressed=\"false\">{text}</button>",
                escape(&value)
            ));
        }
        self.out.push_str("</div>");
    }
}

fn text_segs(value: &AttrValue) -> Option<&[Seg]> {
    match value {
        AttrValue::Text(segs) => Some(segs),
        _ => None,
    }
}

fn is_web(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn filters_of(nodes: &[Node]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut pending: Vec<&Node> = nodes.iter().collect();
    while let Some(node) = pending.pop() {
        let Node::Element(el) = node else { continue };
        if el.name == "Filters"
            && let (Some(of), Some(by)) = (el.literal("of"), el.literal("by"))
        {
            out.push((of.to_owned(), by.to_owned()));
        }
        pending.extend(el.children.iter());
    }
    out
}
