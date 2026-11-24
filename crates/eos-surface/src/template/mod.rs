//! Page templates: Eos page markup, the markup syntax of a View with a fixed
//! list of HTML elements and five components, slots that put data in as text,
//! repeats, guards and the part names pointing picks.
//!
//! ```text
//! <section part="lead"><h2>{lead.title}</h2>
//!   <img part="lead-image" if="lead.image" src="{lead.image}" alt="{lead.image.alt}"/></section>
//! <article part="stories" each="stories"><h3>{item.title}</h3></article>
//! ```

mod check;
mod rules;
mod scope;
mod slots;
mod tree;

use eos_genui::markup::parse_markup;

use crate::limits::TEMPLATE_BYTES;
use crate::problem::Problem;
use crate::types::Contract;

pub use rules::{COMPONENTS, Component, ELEMENTS, EOS_TARGETS, ISSUE_FIELDS};
pub use slots::{Format, Seg, Slot};
pub use tree::{Attr, AttrValue, Element, Node, TextNode, to_markup};

pub(crate) use scope::{Scope, SlotType};
pub(crate) use slots::parse_segments;

/// A template that passed every check, with what it names.
#[derive(Debug, Clone, PartialEq)]
pub struct PageTemplate {
    pub nodes: Vec<Node>,
    /// Every part name, in document order.
    pub parts: Vec<String>,
    /// The direct actions its Buttons run.
    pub actions: Vec<String>,
    /// The named queries its Live parts read.
    pub queries: Vec<String>,
}

impl PageTemplate {
    /// Reads and checks a template against the contract it fills from. Every
    /// problem comes back at once, each at `template:<line>:<col>`.
    pub fn check(src: &str, contract: &Contract) -> Result<PageTemplate, Vec<Problem>> {
        if src.len() > TEMPLATE_BYTES {
            return Err(vec![Problem::new("template", format!("is {} bytes, max {TEMPLATE_BYTES}", src.len()))]);
        }
        let parsed = parse_markup(src);
        let units: Vec<u16> = src.encode_utf16().collect();
        let mut found = Vec::new();
        let nodes = tree::from_markup(&parsed.nodes, &units, &mut found);
        let mut problems: Vec<(usize, usize, String)> =
            parsed.errors.into_iter().map(|e| (e.line, e.col, e.message)).collect();
        problems.append(&mut found);
        let mut checker = check::Checker::new(Scope::new(&contract.fields));
        checker.nodes(&nodes, 0);
        checker.finish();
        problems.append(&mut checker.problems);
        let mut style_problems = Vec::new();
        for (line, col, style) in &checker.found.styles {
            let place = |_: u32, _: u32| format!("template:{line}:{col}");
            if let Err(mut found) = crate::css::sanitize_inline(style, &place) {
                style_problems.append(&mut found);
            }
        }
        if nodes.iter().all(|n| n.as_element().is_none()) {
            problems.push((1, 1, "holds no element".into()));
        }
        if !problems.is_empty() {
            problems.sort_by_key(|(line, col, _)| (*line, *col));
            return Err(problems.into_iter().map(|(l, c, m)| at(l, c, m)).chain(style_problems).collect());
        }
        if !style_problems.is_empty() {
            return Err(style_problems);
        }
        let found = checker.found;
        Ok(PageTemplate { nodes, parts: found.parts, actions: found.actions, queries: found.queries })
    }

    pub fn to_markup(&self) -> String {
        to_markup(&self.nodes)
    }

    /// The Live part named `part`: the query it reads and the argument
    /// template filled from the issue's data.
    pub fn live_part(&self, part: &str) -> Option<LivePart> {
        fn find<'n>(nodes: &'n [Node], part: &str) -> Option<&'n Element> {
            nodes.iter().filter_map(Node::as_element).find_map(|el| {
                if el.name == "Live" && el.part() == Some(part) { Some(el) } else { find(&el.children, part) }
            })
        }
        let el = find(&self.nodes, part)?;
        let args = match el.attr("args") {
            Some(AttrValue::Json(serde_json::Value::Object(map))) => map.clone(),
            _ => serde_json::Map::new(),
        };
        Some(LivePart { query: el.literal("query")?.to_owned(), args })
    }
}

/// A Live part as the core reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct LivePart {
    pub query: String,
    pub args: serde_json::Map<String, serde_json::Value>,
}

pub(crate) fn at(line: usize, col: usize, message: impl Into<String>) -> Problem {
    Problem::new(format!("template:{line}:{col}"), message)
}
