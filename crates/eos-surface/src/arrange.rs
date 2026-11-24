//! Reshaping a page by pointing, with no agent (05 gap 19): the part the
//! reader pointed at is removed, or moved before the element before it or
//! after the element after it, among its siblings. The design that comes
//! out passes the same checks as any other.

use serde_json::{Value, json};

use crate::design::PageDesign;
use crate::template::{Node, to_markup};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrangeOp {
    Remove,
    MoveUp,
    MoveDown,
}

impl ArrangeOp {
    pub fn parse(word: &str) -> Option<ArrangeOp> {
        match word {
            "remove" => Some(ArrangeOp::Remove),
            "move_up" => Some(ArrangeOp::MoveUp),
            "move_down" => Some(ArrangeOp::MoveDown),
            _ => None,
        }
    }
}

/// The body of `design` with `op` done to `part`, or why it cannot be done.
pub fn arrange(design: &PageDesign, part: &str, op: ArrangeOp) -> Result<Value, String> {
    let mut nodes = design.template.nodes.clone();
    match apply(&mut nodes, part, op) {
        Some(true) => {}
        Some(false) => return Err(format!("`{part}` has nothing to move past there")),
        None => return Err(format!("the page has no part `{part}`")),
    }
    let mut body = design.to_body();
    body["template"] = json!(to_markup(&nodes));
    Ok(body)
}

/// `Some(done)` once the part is found among `nodes` or below them.
fn apply(nodes: &mut Vec<Node>, part: &str, op: ArrangeOp) -> Option<bool> {
    let found = nodes.iter().position(|n| n.as_element().is_some_and(|el| el.part() == Some(part)));
    if let Some(at) = found {
        let siblings: Vec<usize> = (0..nodes.len()).filter(|i| nodes[*i].as_element().is_some()).collect();
        let place = siblings.iter().position(|i| *i == at)?;
        return Some(match op {
            ArrangeOp::Remove => {
                nodes.remove(at);
                true
            }
            ArrangeOp::MoveUp if place > 0 => {
                nodes.swap(at, siblings[place - 1]);
                true
            }
            ArrangeOp::MoveDown if place + 1 < siblings.len() => {
                nodes.swap(at, siblings[place + 1]);
                true
            }
            _ => false,
        });
    }
    nodes.iter_mut().find_map(|node| match node {
        Node::Element(el) => apply(&mut el.children, part, op),
        Node::Text(_) => None,
    })
}
