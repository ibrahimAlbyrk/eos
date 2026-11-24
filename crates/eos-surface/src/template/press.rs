//! What a press on a page's Button or Ask means: the part names it, the
//! template says what it runs, and the repeat it sits in says which list's
//! row the press's index or id picks.

use serde_json::{Map, Value};

use super::PageTemplate;
use super::tree::{AttrValue, Element, Node};

/// A Button or Ask found by its part.
#[derive(Debug, Clone, PartialEq)]
pub struct Pressable {
    /// The direct action a Button runs; `None` for an Ask.
    pub action: Option<String>,
    /// Its argument template: slot texts over the page's fields and its row.
    pub args: Map<String, Value>,
    /// The repeat it sits in, innermost: the list's path and the name its
    /// rows go by. `None` outside any repeat.
    pub row: Option<RowOf>,
    /// Whether a repeat around it repeats inside another, so one index
    /// cannot name the row.
    pub nested: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowOf {
    pub list: String,
    pub name: String,
}

impl PageTemplate {
    /// The Button or Ask whose part is `part`.
    pub fn pressable(&self, part: &str) -> Option<Pressable> {
        find(&self.nodes, part, &mut Vec::new())
    }
}

fn find(nodes: &[Node], part: &str, repeats: &mut Vec<RowOf>) -> Option<Pressable> {
    for el in nodes.iter().filter_map(Node::as_element) {
        let repeat = el
            .literal("each")
            .map(|list| RowOf { list: list.to_owned(), name: el.literal("as").unwrap_or("item").to_owned() });
        let entered = repeat.is_some();
        if let Some(repeat) = repeat {
            repeats.push(repeat);
        }
        let found = if matches!(el.name.as_str(), "Button" | "Ask") && el.part() == Some(part) {
            Some(pressable(el, repeats))
        } else {
            find(&el.children, part, repeats)
        };
        if entered {
            repeats.pop();
        }
        if found.is_some() {
            return found;
        }
    }
    None
}

fn pressable(el: &Element, repeats: &[RowOf]) -> Pressable {
    let args = match el.attr("args") {
        Some(AttrValue::Json(Value::Object(map))) => map.clone(),
        _ => Map::new(),
    };
    Pressable {
        action: (el.name == "Button").then(|| el.literal("action").unwrap_or_default().to_owned()),
        args,
        row: repeats.last().cloned(),
        nested: repeats.len() > 1,
    }
}
