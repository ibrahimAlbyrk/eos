//! The checks of a template against its contract: elements, attributes, parts,
//! slots, repeats and the guards optional fields need.

use serde_json::Value;

use crate::types::Type;

use super::rules::{
    ATTRIBUTES, ELEMENTS, EOS_TARGETS, MAX_NESTING, MAX_REPEATS, SECTIONING, VOID, component, element_attributes,
};
use super::scope::{Resolved, Scope, SlotType};
use super::slots::{Format, Seg, Slot, is_path, parse_segments};
use super::tree::{AttrValue, Element, Node, TextNode};

/// What the walk collects besides its problems.
#[derive(Debug, Default)]
pub(crate) struct Found {
    pub(crate) parts: Vec<String>,
    pub(crate) actions: Vec<String>,
    pub(crate) queries: Vec<String>,
    /// The lists a repeat walks, for `Filters of=`.
    pub(crate) repeated: Vec<String>,
    /// `(line, col, of)` of each `Filters`.
    pub(crate) filters: Vec<(usize, usize, String)>,
    /// `(line, col, declarations)` of each `style=`, for the style check.
    pub(crate) styles: Vec<(usize, usize, String)>,
    last_heading: u8,
}

pub(crate) struct Checker<'a> {
    pub(crate) found: Found,
    pub(crate) problems: Vec<(usize, usize, String)>,
    scope: Scope<'a>,
}

impl<'a> Checker<'a> {
    pub(crate) fn new(scope: Scope<'a>) -> Self {
        Checker { found: Found { last_heading: 1, ..Found::default() }, problems: Vec::new(), scope }
    }

    pub(crate) fn nodes(&mut self, nodes: &[Node], depth: usize) {
        for node in nodes {
            match node {
                Node::Text(text) => self.text(text),
                Node::Element(el) => self.element(el, depth + 1),
            }
        }
    }

    fn problem(&mut self, line: usize, col: usize, message: impl Into<String>) {
        self.problems.push((line, col, message.into()));
    }

    fn text(&mut self, text: &TextNode) {
        for seg in &text.segs {
            if let Seg::Slot(slot) = seg {
                self.slot(text.line, text.col, slot, Use::Text);
            }
        }
    }

    fn element(&mut self, el: &Element, depth: usize) {
        let label = label(el);
        if depth > MAX_NESTING {
            self.problem(el.line, el.col, format!("{label} nests deeper than {MAX_NESTING} levels"));
            return;
        }
        let comp = component(&el.name);
        if comp.is_none() && !ELEMENTS.contains(&el.name.as_str()) {
            let message = if el.is_component() {
                format!("{label} is not a component: Filters, Disclosure, Button, Ask or Live")
            } else {
                format!("{label} is not an element a page may use")
            };
            self.problem(el.line, el.col, message);
            return;
        }
        let saved = self.scope.clone();
        self.attributes(el, &label);
        let needs_part = comp.is_some() || SECTIONING.contains(&el.name.as_str()) || el.attr("each").is_some();
        if needs_part && el.attr("part").is_none() {
            self.problem(el.line, el.col, format!("{label} needs a part name: part=\"…\""));
        }
        if let Some(comp) = comp {
            for required in comp.required {
                if el.attr(required).is_none() {
                    self.problem(el.line, el.col, format!("{label} needs {required}="));
                }
            }
            if !comp.children && !el.children.is_empty() {
                self.problem(el.line, el.col, format!("{label} holds nothing: write it <{}/>", el.name));
            }
        }
        if VOID.contains(&el.name.as_str()) && !el.children.is_empty() {
            self.problem(el.line, el.col, format!("{label} holds nothing: write it <{}/>", el.name));
        }
        match el.name.as_str() {
            "img" => {
                for needed in ["src", "alt"] {
                    if el.attr(needed).is_none() {
                        self.problem(el.line, el.col, format!("{label} needs {needed}="));
                    }
                }
            }
            "a" if el.attr("href").is_none() => self.problem(el.line, el.col, format!("{label} needs href=")),
            name => {
                if let Some(level) = heading_level(name) {
                    if level > self.found.last_heading + 1 {
                        let message =
                            format!("{label} skips a heading level: h{} comes before it", self.found.last_heading);
                        self.problem(el.line, el.col, message);
                    }
                    self.found.last_heading = level;
                }
            }
        }
        if el.name == "Live" {
            self.scope.in_live = true;
        }
        self.nodes(&el.children, depth);
        self.scope = saved;
    }

    /// Checks every attribute; `each=` and `if=` change the scope the
    /// element's own other attributes and its children see, so they go first.
    fn attributes(&mut self, el: &Element, label: &str) {
        let comp = component(&el.name);
        for attr in &el.attrs {
            let name = attr.name.as_str();
            let allowed = match comp {
                Some(comp) => comp.attrs.contains(&name) || matches!(name, "part" | "if" | "unless"),
                None => ATTRIBUTES.contains(&name) || element_attributes(&el.name).contains(&name),
            };
            if !allowed {
                self.problem(el.line, el.col, format!("{label} may not carry {name}="));
                continue;
            }
            match (&attr.value, name) {
                (AttrValue::Flag, _) => self.problem(el.line, el.col, format!("{label}: {name}= needs a value")),
                (AttrValue::Json(_), n) if n != "args" => {
                    self.problem(el.line, el.col, format!("{label}: {name}= takes a quoted value, not {{…}}"));
                }
                _ => {}
            }
        }
        if let Some(list) = self.literal_path(el, "each", label) {
            match self.scope.resolve(&list) {
                Ok(resolved) => {
                    let name = el.literal("as").unwrap_or("item").to_owned();
                    self.repeat(el, label, &name, &resolved);
                }
                Err(message) => self.problem(el.line, el.col, format!("{label}: each={list}: {message}")),
            }
        } else if el.attr("as").is_some() {
            self.problem(el.line, el.col, format!("{label}: as= names a repeat's item and needs each="));
        }
        if let Some(path) = self.literal_path(el, "if", label) {
            match self.scope.resolve(&path) {
                // An absent field is false: a guard never needs a guard.
                Ok(resolved) => self.scope.guards.push(resolved.canon),
                Err(message) => self.problem(el.line, el.col, format!("{label}: if={path}: {message}")),
            }
        }
        if let Some(path) = self.literal_path(el, "unless", label) {
            match self.scope.resolve(&path) {
                Ok(_) => {}
                Err(message) => self.problem(el.line, el.col, format!("{label}: unless={path}: {message}")),
            }
        }
        for attr in &el.attrs {
            self.attribute(el, label, &attr.name, &attr.value);
        }
    }

    fn repeat(&mut self, el: &Element, label: &str, name: &str, list: &Resolved<'a>) {
        if self.scope.repeats() >= MAX_REPEATS {
            self.problem(el.line, el.col, format!("{label} repeats inside {MAX_REPEATS} repeats; two levels at most"));
            return;
        }
        if self.scope.repeats() > 0 && el.attr("as").is_none() {
            self.problem(el.line, el.col, format!("{label} repeats inside a repeat: name its item with as=\"…\""));
        }
        if name != "item" && (self.scope.takes_name(name) || !is_path(name) || name.contains('.')) {
            self.problem(el.line, el.col, format!("{label}: as={name} must be a new single name"));
            return;
        }
        // The list itself may be optional: an absent list repeats nothing.
        let outer: Vec<&String> = list.optionals.iter().filter(|o| **o != list.canon).collect();
        for optional in outer {
            if !self.scope.is_guarded(optional) {
                self.problem(el.line, el.col, format!("{label}: {optional} is optional: guard it with if=\"…\""));
            }
        }
        match self.scope.enter_repeat(name, list) {
            Ok(()) => self.found.repeated.push(list.canon.clone()),
            Err(message) => self.problem(el.line, el.col, format!("{label}: each=: {message}")),
        }
    }

    fn literal_path(&mut self, el: &Element, name: &str, label: &str) -> Option<String> {
        el.attr(name)?;
        match el.literal(name) {
            Some(path) if is_path(path) => Some(path.to_owned()),
            _ => {
                self.problem(el.line, el.col, format!("{label}: {name}= takes a field path such as lead.image"));
                None
            }
        }
    }

    fn attribute(&mut self, el: &Element, label: &str, name: &str, value: &AttrValue) {
        let (line, col) = (el.line, el.col);
        match (name, value) {
            ("each" | "as" | "if" | "unless", _) | (_, AttrValue::Flag) => {}
            ("part", _) => match el.literal("part") {
                Some(part) if is_part_name(part) => {
                    if self.found.parts.iter().any(|p| p == part) {
                        self.problem(line, col, format!("{label}: part {part} is used twice; part names are unique"));
                    } else {
                        self.found.parts.push(part.to_owned());
                    }
                }
                _ => self.problem(line, col, format!("{label}: part= is a name of a-z, 0-9 and -, up to 40")),
            },
            ("args", AttrValue::Json(Value::Object(map))) => {
                for value in map.values() {
                    self.json_slots(line, col, value);
                }
            }
            ("args", _) => self.problem(line, col, format!("{label}: args= is an object: args={{{{\"key\": \"…\"}}}}")),
            ("action" | "query", _) => match el.literal(name) {
                Some(id) if is_action_id(id) => {
                    let list = if name == "action" { &mut self.found.actions } else { &mut self.found.queries };
                    if !list.iter().any(|a| a == id) {
                        list.push(id.to_owned());
                    }
                }
                _ => self.problem(line, col, format!("{label}: {name}= names an id such as routine.run_again")),
            },
            ("of", _) => {
                let Some(list) = self.literal_path(el, "of", label) else { return };
                match self.scope.resolve(&list) {
                    Ok(resolved) => {
                        let Resolved { ty: SlotType::Of(Type::List { of, .. }), canon, .. } = resolved else {
                            self.problem(line, col, format!("{label}: of={list} is not a list"));
                            return;
                        };
                        self.found.filters.push((line, col, canon));
                        self.filter_by(el, label, of);
                    }
                    Err(message) => self.problem(line, col, format!("{label}: of={list}: {message}")),
                }
            }
            ("by", _) => {}
            ("class", AttrValue::Text(segs)) => {
                for seg in segs {
                    match seg {
                        Seg::Lit(text) if text.chars().all(|c| c.is_ascii_alphanumeric() || " -_".contains(c)) => {}
                        Seg::Lit(_) => {
                            self.problem(line, col, format!("{label}: class= holds names of a-z, 0-9, - and _"))
                        }
                        Seg::Slot(slot) => self.slot(line, col, slot, Use::Class),
                    }
                }
            }
            ("style", _) => match el.literal("style") {
                Some(text) => self.found.styles.push((line, col, text.to_owned())),
                None => self.problem(line, col, format!("{label}: style= may not hold a slot")),
            },
            ("lang", _) => {
                let ok = el.literal("lang").is_some_and(|l| {
                    (2..=16).contains(&l.len()) && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                });
                if !ok {
                    self.problem(line, col, format!("{label}: lang= is a language tag such as en or tr"));
                }
            }
            ("dir", _) => {
                if !matches!(el.literal("dir"), Some("ltr" | "rtl" | "auto")) {
                    self.problem(line, col, format!("{label}: dir= is ltr, rtl or auto"));
                }
            }
            ("colspan" | "rowspan", _) => {
                let ok = el.literal(name).and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=99).contains(&n));
                if !ok {
                    self.problem(line, col, format!("{label}: {name}= is a number from 1 to 99"));
                }
            }
            ("src", AttrValue::Text(segs)) => self.single_slot(el, label, name, segs, Use::Image),
            ("datetime", AttrValue::Text(segs)) => self.single_slot(el, label, name, segs, Use::Time),
            ("href", AttrValue::Text(segs)) => {
                if el.literal("href").is_some_and(|t| EOS_TARGETS.contains(&t)) {
                    return;
                }
                self.single_slot(el, label, name, segs, Use::Link);
            }
            (_, AttrValue::Text(segs)) => {
                for seg in segs {
                    if let Seg::Slot(slot) = seg {
                        self.slot(line, col, slot, Use::Attr);
                    }
                }
            }
            (_, AttrValue::Json(_)) => {}
        }
    }

    fn filter_by(&mut self, el: &Element, label: &str, item: &Type) {
        let Some(by) = el.literal("by") else { return };
        let ok = match item {
            Type::Object { fields } => fields
                .iter()
                .any(|f| f.name == by && f.required && matches!(f.ty, Type::Text { .. } | Type::Enum { .. })),
            _ => false,
        };
        if !ok {
            self.problem(
                el.line,
                el.col,
                format!("{label}: by={by} must be a required text or enum field of each item"),
            );
        }
    }

    fn single_slot(&mut self, el: &Element, label: &str, name: &str, segs: &[Seg], use_: Use) {
        match segs {
            [Seg::Slot(slot)] => self.slot(el.line, el.col, slot, use_),
            _ => {
                let what = match use_ {
                    Use::Image => "one slot of an image field, src=\"{lead.image}\"".to_owned(),
                    Use::Link => {
                        format!("one slot of a url field, href=\"{{item.url}}\", or {}", EOS_TARGETS.join(", "))
                    }
                    _ => "one slot of a date or datetime field".to_owned(),
                };
                self.problem(el.line, el.col, format!("{label}: {name}= takes {what}"));
            }
        }
    }

    fn json_slots(&mut self, line: usize, col: usize, value: &Value) {
        match value {
            Value::String(text) => match parse_segments(text) {
                Ok(segs) => {
                    for seg in segs {
                        if let Seg::Slot(slot) = seg {
                            self.slot(line, col, &slot, Use::Arg);
                        }
                    }
                }
                Err(message) => self.problem(line, col, format!("args: {message}")),
            },
            Value::Array(items) => items.iter().for_each(|v| self.json_slots(line, col, v)),
            Value::Object(map) => map.values().for_each(|v| self.json_slots(line, col, v)),
            _ => {}
        }
    }

    fn slot(&mut self, line: usize, col: usize, slot: &Slot, use_: Use) {
        let resolved = match self.scope.resolve(&slot.path) {
            Ok(resolved) => resolved,
            Err(message) => return self.problem(line, col, format!("{{{}}}: {message}", slot.path)),
        };
        for optional in &resolved.optionals {
            if !self.scope.is_guarded(optional) {
                let message = format!(
                    "{{{}}}: {optional} is optional: use it under if=\"{optional_path}\"",
                    slot.path,
                    optional_path = slot.path
                );
                self.problem(line, col, message);
                return;
            }
        }
        if let Err(message) = fits(resolved.ty, use_, slot.format.as_ref()) {
            self.problem(line, col, format!("{{{}}}: {message}", slot.path));
        }
    }

    /// The checks that need the whole walk.
    pub(crate) fn finish(&mut self) {
        for (line, col, of) in std::mem::take(&mut self.found.filters) {
            if !self.found.repeated.contains(&of) {
                self.problem(line, col, format!("<Filters of=\"{of}\">: no element repeats {of} with each="));
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Use {
    Text,
    Attr,
    Arg,
    Class,
    Image,
    Link,
    Time,
}

/// Whether a value of `ty` may go where it is used, in the format it names.
fn fits(ty: SlotType<'_>, use_: Use, format: Option<&Format>) -> Result<(), String> {
    use Type as T;
    let any = matches!(ty, SlotType::Any);
    match use_ {
        Use::Image => {
            return if matches!(ty, SlotType::Of(T::Image)) || any {
                Ok(())
            } else {
                Err("src= takes an image field".into())
            };
        }
        Use::Link => {
            return if matches!(ty, SlotType::Of(T::Url) | SlotType::Url) || any {
                Ok(())
            } else {
                Err("href= takes a url field".into())
            };
        }
        Use::Time => {
            return if matches!(ty, SlotType::Of(T::Date | T::DateTime) | SlotType::Date) || any {
                Ok(())
            } else {
                Err("datetime= takes a date or datetime field".into())
            };
        }
        Use::Class => {
            return if matches!(ty, SlotType::Of(T::Enum { .. })) {
                Ok(())
            } else {
                Err("a slot in class= must be an enum field".into())
            };
        }
        Use::Text | Use::Attr | Use::Arg => {}
    }
    match ty {
        SlotType::Of(T::Image) => return Err("is an image: show it with <img src=\"…\"/>".into()),
        SlotType::Of(T::Bool) => return Err("is true or false: use it in if= or unless=".into()),
        SlotType::Of(T::Object { .. }) => return Err("is an object: name one of its fields".into()),
        SlotType::Of(T::List { .. }) => return Err("is a list: repeat it with each=".into()),
        SlotType::Of(T::LongText { .. }) if use_ != Use::Text => {
            return Err("is long text: it goes in an element's text, not an attribute".into());
        }
        _ => {}
    }
    let Some(format) = format else { return Ok(()) };
    let ok = any
        || match format {
            Format::Date | Format::Weekday => matches!(ty, SlotType::Of(T::Date | T::DateTime) | SlotType::Date),
            Format::Time | Format::DateTime => matches!(ty, SlotType::Of(T::DateTime)),
            Format::Number | Format::Count(_) => matches!(ty, SlotType::Of(T::Number | T::Int) | SlotType::Int),
        };
    if ok { Ok(()) } else { Err("its format does not fit its type".into()) }
}

fn heading_level(name: &str) -> Option<u8> {
    match name {
        "h1" => Some(1),
        "h2" => Some(2),
        "h3" => Some(3),
        "h4" => Some(4),
        _ => None,
    }
}

fn is_part_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_action_id(id: &str) -> bool {
    (1..=80).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// `<section part="lead">`, as problems name an element.
pub(crate) fn label(el: &Element) -> String {
    match el.part() {
        Some(part) => format!("<{} part=\"{part}\">", el.name),
        None => format!("<{}>", el.name),
    }
}
