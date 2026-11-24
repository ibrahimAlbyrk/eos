//! A page template as a tree the checks, the renderers and `arrange` share,
//! read from the markup parser's nodes and written back to markup.

use eos_genui::markup::{MarkupElement, MarkupNode};
use serde_json::Value;

use super::slots::{Seg, parse_segments, write_segments};

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Element(Element),
    Text(TextNode),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<Attr>,
    pub children: Vec<Node>,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    pub name: String,
    pub value: AttrValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    /// A quoted value: literal text and slots.
    Text(Vec<Seg>),
    /// A `{…}` value (a Button's or a Live part's `args`).
    Json(Value),
    /// A bare attribute.
    Flag,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextNode {
    pub segs: Vec<Seg>,
    /// Whether the source had white space before or after the text: the parser
    /// trims it, and words beside an inline element must stay apart.
    pub space_before: bool,
    pub space_after: bool,
    pub line: usize,
    pub col: usize,
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&AttrValue> {
        self.attrs.iter().find(|a| a.name == name).map(|a| &a.value)
    }

    /// A quoted attribute that holds no slot, as plain text.
    pub fn literal(&self, name: &str) -> Option<&str> {
        match self.attr(name)? {
            AttrValue::Text(segs) => match segs.as_slice() {
                [] => Some(""),
                [Seg::Lit(text)] => Some(text),
                _ => None,
            },
            _ => None,
        }
    }

    pub fn part(&self) -> Option<&str> {
        self.literal("part")
    }

    pub fn is_component(&self) -> bool {
        self.name.starts_with(|c: char| c.is_ascii_uppercase())
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(Node::as_element)
    }
}

impl Node {
    pub fn as_element(&self) -> Option<&Element> {
        match self {
            Node::Element(el) => Some(el),
            Node::Text(_) => None,
        }
    }
}

/// Converts the parser's nodes; `units` is the source in UTF-16, which the
/// parser's offsets count, to find the white space it trimmed. A slot problem
/// in text or an attribute comes back as `(line, col, message)`.
pub(crate) fn from_markup(
    nodes: &[MarkupNode],
    units: &[u16],
    problems: &mut Vec<(usize, usize, String)>,
) -> Vec<Node> {
    nodes.iter().map(|node| convert(node, units, problems)).collect()
}

fn convert(node: &MarkupNode, units: &[u16], problems: &mut Vec<(usize, usize, String)>) -> Node {
    match node {
        MarkupNode::Text(text) => {
            let at = text.pos.offset;
            let segs = parse_segments(&text.text).unwrap_or_else(|message| {
                problems.push((text.pos.line, text.pos.col, message));
                Vec::new()
            });
            Node::Text(TextNode {
                segs,
                space_before: at > 0 && units.get(at - 1).is_some_and(|u| is_space(*u)),
                space_after: space_after(units, at),
                line: text.pos.line,
                col: text.pos.col,
            })
        }
        MarkupNode::Element(el) => Node::Element(convert_element(el, units, problems)),
    }
}

fn convert_element(el: &MarkupElement, units: &[u16], problems: &mut Vec<(usize, usize, String)>) -> Element {
    let attrs = el
        .attrs
        .iter()
        .map(|(name, value)| {
            let pos = el.attr_pos.get(name).copied().unwrap_or(el.pos);
            let value = match value {
                eos_genui::Value::String(text) => AttrValue::Text(parse_segments(text).unwrap_or_else(|message| {
                    problems.push((pos.line, pos.col, format!("{name}: {message}")));
                    Vec::new()
                })),
                eos_genui::Value::Bool(true) => AttrValue::Flag,
                other => AttrValue::Json(serde_json::to_value(other).unwrap_or(Value::Null)),
            };
            Attr { name: name.to_string(), value }
        })
        .collect();
    Element {
        name: el.name.clone(),
        attrs,
        children: from_markup(&el.children, units, problems),
        line: el.pos.line,
        col: el.pos.col,
    }
}

fn is_space(u: u16) -> bool {
    matches!(u, 0x20 | 0x09 | 0x0a | 0x0d)
}

/// The text runs to the next tag; white space just before it was trimmed.
fn space_after(units: &[u16], from: usize) -> bool {
    let end =
        units[from.min(units.len())..].iter().position(|u| *u == u16::from(b'<')).map_or(units.len(), |i| from + i);
    end > 0 && units.get(end - 1).is_some_and(|u| is_space(*u))
}

/// The tree as markup the parser reads back to the same tree.
pub fn to_markup(nodes: &[Node]) -> String {
    let mut out = String::new();
    for node in nodes {
        write_node(node, &mut out);
    }
    out
}

fn write_node(node: &Node, out: &mut String) {
    match node {
        Node::Text(text) => {
            if text.space_before {
                out.push(' ');
            }
            out.push_str(&write_segments(&text.segs));
            if text.space_after {
                out.push(' ');
            }
        }
        Node::Element(el) => {
            out.push('<');
            out.push_str(&el.name);
            for attr in &el.attrs {
                out.push(' ');
                out.push_str(&attr.name);
                match &attr.value {
                    AttrValue::Flag => {}
                    AttrValue::Text(segs) => {
                        out.push_str("=\"");
                        out.push_str(&write_segments(segs).replace('&', "&amp;").replace('"', "&quot;"));
                        out.push('"');
                    }
                    AttrValue::Json(value) => {
                        out.push('=');
                        out.push('{');
                        out.push_str(&value.to_string());
                        out.push('}');
                    }
                }
            }
            if el.children.is_empty() {
                out.push_str("/>");
                return;
            }
            out.push('>');
            for child in &el.children {
                write_node(child, out);
            }
            out.push_str("</");
            out.push_str(&el.name);
            out.push('>');
        }
    }
}
