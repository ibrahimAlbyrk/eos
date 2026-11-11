//! The accessibility tree as indented text with `@eN` refs (the daemon's snapshot format).

use std::collections::HashMap;

use serde_json::Value;

const INTERACTIVE: &[&str] = &[
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
const LANDMARK: &[&str] = &[
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
const SKIP: &[&str] =
    &["generic", "genericcontainer", "none", "presentation", "inlinetextbox", "linebreak", "ignored", "rootwebarea"];
const STATE_PROPS: &[&str] = &["checked", "disabled", "expanded", "pressed", "selected", "invalid", "required"];

fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(other) => other.to_string(),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max { format!("{}…", flat.chars().take(max - 1).collect::<String>()) } else { flat }
}

pub(crate) fn role_of(node: &Value) -> String {
    s(node.pointer("/role/value")).to_lowercase()
}

fn props(node: &Value) -> impl Iterator<Item = (String, &Value)> {
    node.get("properties")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| (s(p.get("name")).to_lowercase(), p.pointer("/value/value").unwrap_or(&Value::Null)))
}

pub(crate) fn states_of(node: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (name, v) in props(node) {
        if !STATE_PROPS.contains(&name.as_str()) {
            continue;
        }
        let truthy = v == &Value::Bool(true) || v == "true";
        match name.as_str() {
            "checked" | "pressed" => {
                if v == "mixed" {
                    out.push(format!("{name}=mixed"));
                } else if truthy {
                    out.push(name);
                }
            }
            "expanded" => out.push(if truthy { "expanded".into() } else { "collapsed".into() }),
            "invalid" => {
                if !v.is_null() && v != &Value::Bool(false) && v != "false" && v != "" {
                    out.push("invalid".into());
                }
            }
            _ => {
                if truthy {
                    out.push(name);
                }
            }
        }
    }
    out
}

pub(crate) fn is_focusable(node: &Value) -> bool {
    props(node).any(|(name, v)| name == "focusable" && v == &Value::Bool(true))
}

pub(crate) struct Formatted {
    pub(crate) text: String,
    pub(crate) refs: Vec<(String, i64)>,
    pub(crate) next_ref: u32,
}

pub(crate) fn format(
    nodes: &[Value],
    interactive_only: bool,
    depth: Option<u32>,
    root_backend: Option<i64>,
    ref_start: u32,
) -> Formatted {
    let by_id: HashMap<String, &Value> = nodes.iter().map(|n| (s(n.get("nodeId")), n)).collect();
    let root = match root_backend {
        Some(id) => nodes.iter().find(|n| n.get("backendDOMNodeId").and_then(Value::as_i64) == Some(id)),
        None => nodes.iter().find(|n| role_of(n) == "rootwebarea").or(nodes.first()),
    };
    let mut st = Walk { by_id, lines: Vec::new(), refs: Vec::new(), ref_index: ref_start, interactive_only };
    if let Some(root) = root {
        st.walk(root, 0, depth.map(|d| d as i64).unwrap_or(i64::MAX));
    }
    Formatted { text: st.lines.join("\n"), refs: st.refs, next_ref: st.ref_index }
}

struct Walk<'a> {
    by_id: HashMap<String, &'a Value>,
    lines: Vec<String>,
    refs: Vec<(String, i64)>,
    ref_index: u32,
    interactive_only: bool,
}

impl Walk<'_> {
    fn emit(&mut self, node: &Value, indent: usize) -> Option<String> {
        let role = role_of(node);
        let name = truncate(&s(node.pointer("/name/value")), 100);
        let pad = "  ".repeat(indent);
        let quoted = Value::String(name.clone()).to_string();
        if role == "statictext" {
            return (!self.interactive_only && !name.is_empty()).then(|| format!("{pad}text {quoted}"));
        }
        if role == "heading" {
            if name.is_empty() {
                return None;
            }
            let level =
                props(node).find(|(n, _)| n == "level").map(|(_, v)| format!(" [level={v}]")).unwrap_or_default();
            return Some(format!("{pad}heading {quoted}{level}"));
        }
        let interactive = INTERACTIVE.contains(&role.as_str());
        if !interactive {
            let landmark = LANDMARK.contains(&role.as_str()) && !name.is_empty();
            let informative = !self.interactive_only && !name.is_empty() && !role.is_empty();
            return (landmark || informative).then(|| format!("{pad}{role} {quoted}"));
        }
        let mut line = format!("{pad}{role}{}", if name.is_empty() { String::new() } else { format!(" {quoted}") });
        if let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) {
            self.ref_index += 1;
            let r = format!("@e{}", self.ref_index);
            line += &format!(" {r}");
            self.refs.push((r, backend));
        }
        let states = states_of(node);
        if !states.is_empty() {
            line += &format!(" [{}]", states.join(" "));
        }
        let value = truncate(&s(node.pointer("/value/value")), 60);
        if !value.is_empty() {
            line += &format!(" = {}", Value::String(value));
        }
        Some(line)
    }

    fn walk(&mut self, node: &Value, indent: usize, depth_left: i64) {
        let role = role_of(node);
        let skip = node.get("ignored").and_then(Value::as_bool).unwrap_or(false) || SKIP.contains(&role.as_str());
        let (mut child_indent, mut child_depth) = (indent, depth_left);
        if !skip {
            let (ref_mark, idx_mark) = (self.refs.len(), self.ref_index);
            if let Some(line) = self.emit(node, indent) {
                if depth_left <= 0 {
                    self.refs.truncate(ref_mark);
                    self.ref_index = idx_mark;
                    return;
                }
                self.lines.push(line);
                child_indent = indent + 1;
                child_depth = depth_left - 1;
            }
        }
        let children: Vec<String> =
            node.get("childIds").and_then(Value::as_array).into_iter().flatten().map(|c| s(Some(c))).collect();
        for id in children {
            if let Some(child) = self.by_id.get(&id).copied() {
                self.walk(child, child_indent, child_depth);
            }
        }
    }
}
