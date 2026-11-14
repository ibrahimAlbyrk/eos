//! The accessibility tree as indented text with `@eN` refs: what `browser_snapshot`
//! returns. Pure: the nodes of `Accessibility.getFullAXTree` in, the text and the refs it
//! mints out.
//!
//! Token cost is the point: ignored and generic nodes are collapsed, `interactive_only`
//! keeps what an agent can act on plus headings and named landmarks. Never markup.

use std::collections::HashMap;

use eos_domain::text::{collapse_spaces, js_trim, utf16_len, utf16_prefix};
use serde_json::Value;

/// Roles an agent can act on: always rendered, always given a ref.
const INTERACTIVE_ROLES: [&str; 20] = [
    "button",
    "link",
    "textbox",
    "searchbox",
    "textarea",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "popupbutton",
    "togglebutton",
    "disclosuretriangle",
];

/// Structure kept for orientation when it has a name, also in `interactive_only`.
const LANDMARK_ROLES: [&str; 18] = [
    "navigation",
    "banner",
    "main",
    "contentinfo",
    "complementary",
    "form",
    "region",
    "search",
    "dialog",
    "alertdialog",
    "article",
    "list",
    "table",
    "tablist",
    "menu",
    "menubar",
    "radiogroup",
    "group",
];

/// Never rendered; their children take their place.
const SKIP_ROLES: [&str; 8] =
    ["generic", "genericcontainer", "none", "presentation", "inlinetextbox", "linebreak", "ignored", "rootwebarea"];

const STATE_PROPS: [&str; 7] = ["checked", "disabled", "expanded", "pressed", "selected", "invalid", "required"];

const NAME_MAX: usize = 100;
const VALUE_MAX: usize = 60;

/// JavaScript's `String(v)` for the values an accessibility node carries; `null` and a
/// missing value read as the empty string.
pub(crate) fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match n.as_f64() {
            // `String(2.0)` is "2".
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        // An object or array never occurs here; JavaScript would print "[object Object]".
        Some(other) => other.to_string(),
    }
}

/// `JSON.stringify(s)`.
pub(crate) fn quoted(s: &str) -> String {
    Value::String(s.to_owned()).to_string()
}

/// White space collapsed and trimmed, cut to `max` UTF-16 units with an ellipsis.
fn truncate(s: &str, max: usize) -> String {
    let collapsed = collapse_spaces(s);
    let flat = js_trim(&collapsed);
    if utf16_len(flat) > max { format!("{}…", utf16_prefix(flat, max - 1)) } else { flat.to_owned() }
}

/// The node's role in lower case; empty when it has none.
pub fn role_of(node: &Value) -> String {
    text_of(node.pointer("/role/value")).to_lowercase()
}

fn properties(node: &Value) -> impl Iterator<Item = (String, Option<&Value>)> {
    node.get("properties")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| (p.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase(), p.pointer("/value/value")))
}

fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true))) || value.and_then(Value::as_str) == Some("true")
}

/// JavaScript's truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// The states that are not the default: silence means everything is normal.
pub fn states_of(node: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (name, value) in properties(node) {
        if !STATE_PROPS.contains(&name.as_str()) {
            continue;
        }
        match name.as_str() {
            "checked" | "pressed" => {
                if value.and_then(Value::as_str) == Some("mixed") {
                    out.push(format!("{name}=mixed"));
                } else if is_true(value) {
                    out.push(name);
                }
            }
            "expanded" => out.push(if is_true(value) { "expanded" } else { "collapsed" }.to_owned()),
            "invalid" => {
                if truthy(value) && value.and_then(Value::as_str) != Some("false") {
                    out.push("invalid".to_owned());
                }
            }
            _ => {
                if is_true(value) {
                    out.push(name);
                }
            }
        }
    }
    out
}

/// Whether the node says it can take the keyboard focus.
pub fn is_focusable(node: &Value) -> bool {
    properties(node).any(|(name, value)| name == "focusable" && matches!(value, Some(Value::Bool(true))))
}

fn heading_level(node: &Value) -> String {
    match properties(node).find(|(name, _)| name == "level") {
        Some((_, Some(level))) if !level.is_null() => format!(" [level={}]", text_of(Some(level))),
        _ => String::new(),
    }
}

/// How a snapshot is cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatOptions {
    pub interactive_only: bool,
    /// Lines deeper than this are left out.
    pub depth: Option<u64>,
    /// Only the subtree under this DOM node (a selector already resolved).
    pub root_backend_node_id: Option<i64>,
    /// The last ref index the tab has used: a ref string is never reused in a tab's life.
    pub ref_start: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formatted {
    pub text: String,
    /// `("@eN", backendDOMNodeId)`, in the order they appear in the text.
    pub refs: Vec<(String, i64)>,
    pub next_ref_index: u32,
}

struct Walk<'a> {
    by_id: HashMap<&'a str, &'a Value>,
    options: FormatOptions,
    lines: Vec<String>,
    refs: Vec<(String, i64)>,
    ref_index: u32,
}

fn backend_id(node: &Value) -> Option<i64> {
    node.get("backendDOMNodeId").and_then(Value::as_i64)
}

fn node_id(node: &Value) -> &str {
    node.get("nodeId").and_then(Value::as_str).unwrap_or("")
}

impl<'a> Walk<'a> {
    /// The node's line, or `None` when it has none. Mints the node's ref.
    fn emit(&mut self, node: &Value, indent: usize) -> Option<String> {
        let role = role_of(node);
        let name = truncate(&text_of(node.pointer("/name/value")), NAME_MAX);
        let pad = "  ".repeat(indent);
        let interactive = INTERACTIVE_ROLES.contains(&role.as_str());
        if role == "statictext" {
            return (!self.options.interactive_only && !name.is_empty())
                .then(|| format!("{pad}text {}", quoted(&name)));
        }
        if role == "heading" {
            return (!name.is_empty()).then(|| format!("{pad}heading {}{}", quoted(&name), heading_level(node)));
        }
        if !interactive {
            let landmark = LANDMARK_ROLES.contains(&role.as_str()) && !name.is_empty();
            let informative = !self.options.interactive_only && !name.is_empty() && !role.is_empty();
            return (landmark || informative).then(|| format!("{pad}{role} {}", quoted(&name)));
        }
        let mut line = format!("{pad}{role}");
        if !name.is_empty() {
            line.push(' ');
            line.push_str(&quoted(&name));
        }
        if let Some(backend) = backend_id(node) {
            self.ref_index += 1;
            let reference = format!("@e{}", self.ref_index);
            line.push(' ');
            line.push_str(&reference);
            self.refs.push((reference, backend));
        }
        let states = states_of(node);
        if !states.is_empty() {
            line.push_str(&format!(" [{}]", states.join(" ")));
        }
        let value = truncate(&text_of(node.pointer("/value/value")), VALUE_MAX);
        if !value.is_empty() {
            line.push_str(&format!(" = {}", quoted(&value)));
        }
        Some(line)
    }

    /// Depth first, a parent before its children. Iterative: a page decides how deep its
    /// tree is, the stack must not.
    fn walk(&mut self, root: &'a Value) {
        // A tree visits each node once; the cap only stops a malformed list that loops.
        let mut visits_left = self.by_id.len().saturating_mul(4).max(16);
        let mut stack = vec![(root, 0usize, self.options.depth)];
        while let Some((node, indent, depth_left)) = stack.pop() {
            if visits_left == 0 {
                break;
            }
            visits_left -= 1;
            let skip = node.get("ignored").and_then(Value::as_bool).unwrap_or(false)
                || SKIP_ROLES.contains(&role_of(node).as_str());
            let (mut child_indent, mut child_depth) = (indent, depth_left);
            if !skip {
                // A ref that is not in the text must not exist: undo what a pruned line minted.
                let (ref_mark, index_mark) = (self.refs.len(), self.ref_index);
                if let Some(line) = self.emit(node, indent) {
                    if depth_left == Some(0) {
                        self.refs.truncate(ref_mark);
                        self.ref_index = index_mark;
                        continue;
                    }
                    self.lines.push(line);
                    child_indent = indent + 1;
                    child_depth = depth_left.map(|d| d - 1);
                }
            }
            let children = node.get("childIds").and_then(Value::as_array).into_iter().flatten();
            let children: Vec<&'a Value> =
                children.filter_map(|id| id.as_str().and_then(|id| self.by_id.get(id).copied())).collect();
            stack.extend(children.into_iter().rev().map(|child| (child, child_indent, child_depth)));
        }
    }
}

/// Renders `nodes` (the raw array of `Accessibility.getFullAXTree`).
pub fn format_ax_tree(nodes: &[Value], options: FormatOptions) -> Formatted {
    // A repeated node id keeps its last node, as a JavaScript `Map` built from pairs does.
    let by_id: HashMap<&str, &Value> = nodes.iter().map(|node| (node_id(node), node)).collect();
    let root = match options.root_backend_node_id {
        Some(backend) => nodes.iter().find(|node| backend_id(node) == Some(backend)),
        None => nodes.iter().find(|node| role_of(node) == "rootwebarea").or_else(|| nodes.first()),
    };
    let mut walk = Walk { by_id, options, lines: Vec::new(), refs: Vec::new(), ref_index: options.ref_start };
    if let Some(root) = root {
        walk.walk(root);
    }
    Formatted { text: walk.lines.join("\n"), refs: walk.refs, next_ref_index: walk.ref_index }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_pruned_line_leaves_no_ref_behind() {
        let nodes = [
            json!({ "nodeId": "1", "role": { "value": "RootWebArea" }, "childIds": ["2"] }),
            json!({ "nodeId": "2", "role": { "value": "navigation" }, "name": { "value": "Main" }, "childIds": ["3"] }),
            json!({ "nodeId": "3", "role": { "value": "link" }, "name": { "value": "Home" }, "backendDOMNodeId": 7, "childIds": [] }),
        ];
        let options =
            FormatOptions { interactive_only: true, depth: Some(1), root_backend_node_id: None, ref_start: 4 };
        let cut = format_ax_tree(&nodes, options);
        assert_eq!(cut.text, "navigation \"Main\"");
        assert_eq!((cut.refs.len(), cut.next_ref_index), (0, 4));
        let whole = format_ax_tree(&nodes, FormatOptions { depth: None, ..options });
        assert_eq!(whole.text, "navigation \"Main\"\n  link \"Home\" @e5");
        assert_eq!(whole.refs, [("@e5".to_owned(), 7)]);
    }

    #[test]
    fn values_read_as_javascript_prints_them() {
        assert_eq!(text_of(Some(&json!(2))), "2");
        assert_eq!(text_of(Some(&json!(2.0))), "2");
        assert_eq!(text_of(Some(&json!(0.5))), "0.5");
        assert_eq!(text_of(Some(&json!(true))), "true");
        assert_eq!(text_of(Some(&Value::Null)), "");
    }
}
