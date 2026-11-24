//! The parts Eos draws itself, per mode: filter chips, disclosures,
//! buttons, asks and live parts.

use serde_json::Value;

use crate::template::Element;

use super::Mode;
use super::format::escape;
use super::html::{MASK, Walker, text_segs};

impl<'a> Walker<'a, '_> {
    pub(super) fn component(&mut self, el: &'a Element) {
        let part = el.part().unwrap_or_default().to_owned();
        let label = el.attr("label").and_then(text_segs).map(|segs| self.attr_text(segs)).unwrap_or_default();
        let index = self.index.last().copied();
        match (el.name.as_str(), self.mode) {
            ("Filters", Mode::Frame) => self.filter_chips(el),
            ("Filters", _) => {}
            ("Disclosure", Mode::Text) => {
                let title = el.attr("title").and_then(text_segs).map(|s| self.plain_text(s)).unwrap_or_default();
                self.out.push_str(&format!("\n\n{title}\n\n"));
                self.nodes(&el.children);
            }
            (_, Mode::Text) if el.name != "Live" => {}
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
                if self.mode == Mode::Text {
                    let outer = self.live.replace(answer.unwrap_or(&Value::Null));
                    self.nodes(&el.children);
                    self.live = outer;
                    return;
                }
                let query = el.literal("query").unwrap_or_default();
                let start = self.out.len();
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
                if self.found.is_none() && self.only.as_deref() == Some(part.as_str()) {
                    self.found = Some(self.out[start..].to_owned());
                }
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
