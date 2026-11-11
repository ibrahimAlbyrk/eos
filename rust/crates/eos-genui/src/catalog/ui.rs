//! The `ui` of a view: every element against the catalog, the data it references
//! and the actions it names.

use std::collections::HashSet;

use indexmap::IndexSet;

use super::actions::ActionInfo;
use super::attr_check::{attr_number, attr_problem};
use super::components::{AttrDef, AttrKind, COMPONENTS, ChildPolicy, component_def};
use super::data::DataInfo;
use super::limits::{GENUI_LIMITS, URL_RE};
use super::problems::{ViewProblem, key_path, show, with_value};
use crate::attrs::{data_ref_in, parse_chips, parse_cols, parse_options, split_ids, split_labels};
use crate::expr::{check_where, expr_refs, has_template, match_where, parse_where, where_reads_state};
use crate::js::{self, OBJECT_PROTOTYPE_KEYS};
use crate::markup::{MarkupElement, MarkupNode, tag_label};
use crate::re::is_match;
use crate::value::{Object, Value};

pub(crate) struct UiContext<'a, 'v> {
    pub(crate) data: &'a DataInfo<'v>,
    pub(crate) actions: &'a ActionInfo<'v>,
    pub(crate) problems: &'a mut Vec<ViewProblem>,
    pub(crate) warnings: &'a mut Vec<ViewProblem>,
    pub(crate) binds: HashSet<String>,
    pub(crate) images: HashSet<String>,
    pub(crate) maps: usize,
    pub(crate) elements: usize,
    pub(crate) depth: usize,
    pub(crate) components: IndexSet<&'static str>,
    // Deferred checks that need every bind= first.
    expr_checks: Vec<ExprCheck>,
}

struct ExprCheck {
    path: String,
    expr: String,
    in_item: bool,
}

impl<'a, 'v> UiContext<'a, 'v> {
    pub(crate) fn new(
        data: &'a DataInfo<'v>,
        actions: &'a ActionInfo<'v>,
        problems: &'a mut Vec<ViewProblem>,
        warnings: &'a mut Vec<ViewProblem>,
    ) -> Self {
        let images = data.images.iter().map(|u| (*u).to_owned()).collect();
        UiContext {
            data,
            actions,
            problems,
            warnings,
            binds: HashSet::new(),
            images,
            maps: 0,
            elements: 0,
            depth: 0,
            components: IndexSet::new(),
            expr_checks: Vec::new(),
        }
    }

    fn problem(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.problems.push(ViewProblem::new(path, message));
    }

    fn warning(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.warnings.push(ViewProblem::new(path, message));
    }

    /// Checks every element, top level first, each before its children. The walk
    /// keeps its own stack: a document can nest as deep as it is long.
    pub(crate) fn visit(&mut self, nodes: &[MarkupNode]) {
        let mut pending: Vec<(&MarkupElement, usize, bool)> =
            nodes.iter().rev().filter_map(MarkupNode::as_element).map(|el| (el, 1, false)).collect();
        while let Some((el, depth, in_item)) = pending.pop() {
            let child_in_item = self.element(el, depth, in_item);
            pending.extend(
                el.children.iter().rev().filter_map(MarkupNode::as_element).map(|c| (c, depth + 1, child_in_item)),
            );
        }
    }

    // Returns whether the element's children render once per item.
    fn element(&mut self, el: &MarkupElement, depth: usize, in_item: bool) -> bool {
        let (data, actions) = (self.data, self.actions);
        self.elements += 1;
        self.depth = self.depth.max(depth);
        let path = ui_path(el);
        if depth == GENUI_LIMITS.depth + 1 {
            self.problem(&path, format!("is nested {depth} deep, max {} — flatten the layout", GENUI_LIMITS.depth));
        }
        let Some(def) = component_def(&el.name) else {
            let hint = if el.name.starts_with(|c: char| c.is_ascii_lowercase()) {
                " (text is markdown — use **bold**, not HTML)"
            } else {
                ""
            };
            let names: Vec<&str> = COMPONENTS.iter().map(|c| c.name).collect();
            self.problem(&path, format!("unknown component{hint} — use one of {}", names.join(", ")));
            return in_item;
        };
        let name = def.name;
        self.components.insert(name);
        let attrs = def.all_attrs();
        let known = |attr: &str| attrs.iter().find(|(n, _)| *n == attr).map(|(_, a)| *a);

        for (attr, value) in el.attrs.iter() {
            let Some(a) = known(attr) else {
                // The TypeScript looks the attribute up in an object literal, where an
                // inherited member counts as found and then accepts anything.
                if !OBJECT_PROTOTYPE_KEYS.contains(&attr) {
                    self.warning(format!("{path}.{attr}"), format!("is not an attribute of <{name}> — ignored"));
                }
                continue;
            };
            if a.kind.templatable() && is_template(Some(value)) {
                continue;
            }
            if let Some(message) = attr_problem(a, value) {
                self.problem(format!("{path}.{attr}"), with_value(&message, Some(value)));
            }
        }
        for (attr, a) in &attrs {
            if a.required && el.attr(attr).is_none() {
                self.problem(&path, format!("needs {attr}="));
            }
        }
        let element_children: Vec<&MarkupElement> = el.element_children().collect();
        let has_text = el.children.iter().any(|c| matches!(c, MarkupNode::Text(_)));
        for group in def.needs {
            let present = group
                .iter()
                .any(|g| if *g == "children" { !element_children.is_empty() } else { el.attr(g).is_some() });
            if !present {
                let wanted: Vec<String> = group
                    .iter()
                    .map(|g| if *g == "children" { "child elements".to_owned() } else { format!("{g}=") })
                    .collect();
                self.problem(&path, format!("needs {}", wanted.join(" or ")));
            }
        }

        // Children.
        if def.children == ChildPolicy::None && (!element_children.is_empty() || has_text) {
            self.warning(&path, format!("takes no children — write <{name} …/>; its content is ignored"));
        } else if def.children == ChildPolicy::Text && !element_children.is_empty() {
            let inside: Vec<String> = element_children.iter().map(|c| format!("<{}>", c.name)).collect();
            self.warning(&path, format!("shows text only — {} inside it is ignored", inside.join(", ")));
        }

        // Data references.
        let of = match el.attr("of") {
            Some(Value::String(of)) => Some(of.as_str()),
            _ if name == "Sources" => Some("sources"),
            _ => None,
        };
        let mut items: Option<&[&Value]> = None;
        if let Some(of) = of {
            let collection = data.collections.get(of);
            if name == "Sources" {
                if of == "sources" && !data.has_key("sources") {
                    self.problem(&path, "data has no sources — add data.sources [{title, url, at}]");
                } else if of != "sources" && collection.is_none() {
                    self.problem(&path, format!("data has no collection \"{of}\" — {}", self.collection_names()));
                }
            } else if let Some(collection) = collection {
                items = Some(collection);
            } else {
                let why = if data.has_key(of) {
                    format!("data.{of} is not a list of objects")
                } else {
                    format!("data has no collection \"{of}\"")
                };
                let is_object = data.raw.and_then(|raw| raw.get(of)).is_some_and(|v| v.as_object().is_some());
                let hint = if is_object {
                    format!(" — for label/value rows write <KeyValue items=\"{of}\"/>")
                } else {
                    String::new()
                };
                self.problem(&path, format!("{why} — {}{hint}", self.collection_names()));
            }
        }
        for (attr, a) in &attrs {
            if let (AttrKind::Json, Some(Value::String(key))) = (a.kind, el.attr(attr)) {
                self.check_data_ref(format!("{path}.{attr}"), attr, a, key);
            }
        }

        if let (Some(items), Some(of)) = (items, of) {
            let no_ids = IndexSet::new();
            let ids = data.ids.get(of).unwrap_or(&no_ids);
            if let Some(v) = el.attr("pick").filter(|v| !is_template(Some(v)))
                && !ids.contains(&js::to_string(Some(v)))
            {
                let listed = list_ids(ids);
                let listed = if listed.is_empty() { "none (give items an id)" } else { &listed };
                self.problem(format!("{path}.pick"), format!("{} is not an id in {of} — ids: {listed}", show(Some(v))));
            }
            for id in split_ids(el.attr("skip")) {
                if !ids.contains(&id) {
                    self.warning(format!("{path}.skip"), format!("\"{id}\" is not an id in {of}"));
                }
            }
            let fields: HashSet<&str> = items.iter().filter_map(|it| it.as_object()).flat_map(Object::keys).collect();
            // title="title" renders the word itself on every item: a field is read only as "{title}".
            for (attr, a) in def.attrs {
                if let (true, Some(Value::String(v))) = (a.item, el.attr(attr))
                    && !has_template(v)
                    && fields.contains(v.as_str())
                {
                    let shown = show(el.attr(attr));
                    let fix = format!("{attr}=\"{{{v}}}\"");
                    self.problem(
                        format!("{path}.{attr}"),
                        format!("{shown} prints the word itself on every item — to show the {v} field write {fix}"),
                    );
                }
            }
            if name == "Table" {
                for col in parse_cols(el.attr("cols")) {
                    if !fields.contains(col.key.as_str()) {
                        self.warning(
                            format!("{path}.cols"),
                            format!("\"{}\" is not a field of any {of} item — the column stays empty", col.key),
                        );
                    }
                }
            }
            if name == "Chart" {
                for key in split_ids(el.attr("x")).into_iter().chain(split_ids(el.attr("y"))) {
                    if !fields.contains(key.as_str()) {
                        self.warning(&path, format!("\"{key}\" is not a field of any {of} item"));
                    }
                }
            }
            if let ("Meter", Some(Value::String(v))) = (name, el.attr("value"))
                && !has_template(v)
                && !js::is_numeric_text(v)
                && !fields.contains(v.as_str())
            {
                self.warning(format!("{path}.value"), format!("\"{v}\" is not a field of any {of} item"));
            }
            if let Some(Value::String(sort)) = el.attr("sort") {
                let field = sort.strip_prefix('-').map_or(sort.as_str(), |rest| rest.trim_start_matches(js::is_ws));
                let field = field.split('.').next().unwrap_or_default();
                if !field.is_empty() && !fields.contains(field) {
                    self.warning(format!("{path}.sort"), format!("\"{field}\" is not a field of any {of} item"));
                }
            }
            if name == "Map" {
                let missing = items
                    .iter()
                    .filter(|it| {
                        !matches!(it.get("geo"), Some(Value::Array(_)))
                            && !matches!(it.get("address"), Some(Value::String(_)))
                    })
                    .count();
                if missing > 0 {
                    self.warning(
                        &path,
                        format!("{missing} of {} {of} have no geo or address — they get no pin", items.len()),
                    );
                }
            }
            if name == "Carousel" {
                self.check_carousel(&path, static_count(items, el, ids));
            }
        } else if name == "Carousel" && !element_children.is_empty() && of.is_none() {
            self.check_carousel(&path, element_children.len() as f64);
        }
        if name == "Filters" {
            self.check_chips(el, &path);
        }

        // Action references.
        for (attr, a) in &attrs {
            let Some(v) = el.attr(attr) else { continue };
            match (a.kind, v) {
                (AttrKind::Actions, _) => {
                    for id in split_ids(Some(v)) {
                        if !actions.ids.contains(id.as_str()) {
                            self.problem(
                                format!("{path}.{attr}"),
                                format!("action \"{id}\" is not defined — {}", self.action_list()),
                            );
                        }
                    }
                }
                (AttrKind::Action, Value::String(id)) => {
                    if !actions.ids.contains(id.as_str()) {
                        self.problem(
                            format!("{path}.{attr}"),
                            format!("action \"{id}\" is not defined — {}", self.action_list()),
                        );
                    } else if let ("Form", Some(kind)) =
                        (name, actions.kinds.get(id.as_str()).filter(|k| !k.is_empty() && **k != "send"))
                    {
                        self.problem(
                            format!("{path}.{attr}"),
                            format!("\"{id}\" is kind \"{kind}\" — a Form submits a send action"),
                        );
                    }
                }
                (AttrKind::State, Value::String(key)) => {
                    self.binds.insert(key.clone());
                }
                (AttrKind::Expr, Value::String(expr)) => {
                    self.expr_checks.push(ExprCheck { path: format!("{path}.{attr}"), expr: expr.clone(), in_item })
                }
                _ => {}
            }
        }

        // Specific shapes.
        if name == "Map" {
            self.maps += 1;
            if self.maps == GENUI_LIMITS.maps + 1 {
                self.problem(
                    &path,
                    format!(
                        "is map {}, max {} per view — use one Map (filters and tabs can switch what it shows)",
                        self.maps, GENUI_LIMITS.maps
                    ),
                );
            }
        }
        // A warning, not a problem: views citing past the end rendered before this check.
        if let (Some(a), Some(v)) = (known("source"), el.attr("source").filter(|v| !is_template(Some(v)))) {
            let n = if attr_problem(a, v).is_none() { attr_number(v).unwrap_or(0.0) } else { 0.0 };
            if n > data.sources_count as f64 {
                self.warning(format!("{path}.source"), data.sources_hint(n));
            }
        }
        if let ("Image", Some(Value::String(src))) = (name, el.attr("src"))
            && !has_template(src)
        {
            self.images.insert(src.clone());
        }
        if name == "Gallery"
            && let Some(Value::Array(urls)) = data_ref_in(el.attr("images"), data.raw)
        {
            for (i, u) in urls.iter().enumerate() {
                match u {
                    Value::String(u) if is_match(&URL_RE, u) => {
                        self.images.insert(u.clone());
                    }
                    other => self.problem(
                        format!("{path}.images[{i}]"),
                        format!("{} must be an http(s) URL", show(Some(other))),
                    ),
                }
            }
        }
        if name == "Tabs" {
            let labels = split_labels(el.attr("labels"));
            let n = element_children.len();
            if !(GENUI_LIMITS.tabs_min..=GENUI_LIMITS.tabs_max).contains(&n) {
                let s = if n == 1 { "" } else { "s" };
                self.warning(
                    &path,
                    format!("has {n} tab{s} — use {}–{} child elements", GENUI_LIMITS.tabs_min, GENUI_LIMITS.tabs_max),
                );
            }
            for (i, c) in element_children.iter().enumerate() {
                if labels.get(i).is_none() && !matches!(c.attr("label"), Some(Value::String(_))) {
                    self.warning(ui_path(c), format!("tab {} has no label= — it shows as \"Tab {}\"", i + 1, i + 1));
                }
            }
        }
        if matches!(name, "Segmented" | "Select" | "Choice") {
            let options = parse_options(el.attr("options"));
            let n = options.len();
            if el.attr("options").is_some() && n < 2 {
                self.problem(
                    format!("{path}.options"),
                    format!("has {n} option{}, needs at least 2", if n == 1 { "" } else { "s" }),
                );
            }
            if let Some(Value::String(dflt)) = el.attr("default")
                && !has_template(dflt)
                && n > 0
                && !options.iter().any(|o| o.value == *dflt || o.label == *dflt)
            {
                self.warning(
                    format!("{path}.default"),
                    format!("\"{dflt}\" is not one of the options — the first option starts selected"),
                );
            }
        }

        in_item || name == "List"
    }

    fn collection_names(&self) -> String {
        if self.data.collections.is_empty() {
            return "data has no collections".to_owned();
        }
        format!("collections: {}", self.data.collections.keys().copied().collect::<Vec<_>>().join(", "))
    }

    fn action_list(&self) -> String {
        if self.actions.ids.is_empty() {
            return "the view defines no actions".to_owned();
        }
        format!("actions: {}", self.actions.ids.iter().copied().collect::<Vec<_>>().join(", "))
    }

    // A {…} attribute given as a string names a data key (items="limits").
    fn check_data_ref(&mut self, path: String, attr: &str, a: &AttrDef, key: &str) {
        let data = self.data;
        let Some(v) = data.raw.and_then(|raw| raw.get(key)) else {
            let keys = data.keys();
            let known =
                if keys.is_empty() { "data has none".to_owned() } else { format!("data keys: {}", keys.join(", ")) };
            self.problem(path, format!("\"{key}\" is not a data key — {known}"));
            return;
        };
        if !matches!(v, Value::Array(_) | Value::Object(_)) {
            let doc = a.doc.map(|doc| format!(" ({attr}: {doc})")).unwrap_or_default();
            self.problem(path, format!("{} is {}, not a list or object{doc}", key_path("data", key), show(Some(v))));
        }
    }

    fn check_carousel(&mut self, path: &str, n: f64) {
        let shown = js::number_to_string(n);
        if n > GENUI_LIMITS.carousel_max as f64 {
            let max = GENUI_LIMITS.carousel_max;
            self.problem(path, format!("{shown} items, max {max} — paginate or filter (limit={max}, where=)"));
        } else if n < GENUI_LIMITS.carousel_min as f64 {
            let s = if n == 1.0 { "" } else { "s" };
            self.problem(
                path,
                format!(
                    "{shown} item{s}, min {} — show them in a Grid, List or Card instead",
                    GENUI_LIMITS.carousel_min
                ),
            );
        }
    }

    fn check_chips(&mut self, el: &MarkupElement, path: &str) {
        if el.attr("chips").is_none() {
            return;
        }
        let chips = parse_chips(el.attr("chips"));
        if chips.is_empty() {
            self.problem(format!("{path}.chips"), "has no chips — \"Label: filter, Label: filter\"");
            return;
        }
        for (i, chip) in chips.iter().enumerate() {
            if let Some(e) = check_where(&chip.r#where) {
                self.problem(format!("{path}.chips[{i}]"), format!("\"{}\": {e}", chip.label));
            }
        }
        for on in split_labels(el.attr("on")) {
            let found = if !on.is_empty() && on.bytes().all(|b| b.is_ascii_digit()) {
                js::string_to_number(&on) < chips.len() as f64
            } else {
                chips.iter().any(|c| c.label == on)
            };
            if !found {
                self.warning(format!("{path}.on"), format!("\"{on}\" is not a chip index or label"));
            }
        }
    }

    /// The checks that had to wait for every `bind=`: names read by expressions
    /// and by `{state.key}` holes in action text.
    pub(crate) fn check_expr_refs(&mut self) {
        let (data, actions) = (self.data, self.actions);
        for r in &actions.state_refs {
            if !self.bound(&r.key) {
                let key = &r.key;
                self.warning(
                    &r.path,
                    format!("{{state.{key}}} is never bound (bind=\"{key}\") or set — it prints empty"),
                );
            }
        }
        for check in std::mem::take(&mut self.expr_checks) {
            for name in expr_refs(&check.expr) {
                let (root, rest) = match name.split_once('.') {
                    Some((root, rest)) => (Some(root), rest),
                    None => (None, name.as_str()),
                };
                match root {
                    Some("item") => {}
                    Some("state") if !self.bound(rest) => {
                        self.warning(
                            &check.path,
                            format!("state.{rest} is never bound (bind=\"{rest}\") or set — it reads as empty"),
                        );
                    }
                    Some("data") if !data.has_key(rest) => {
                        self.warning(&check.path, format!("data.{rest} does not exist — it reads as empty"));
                    }
                    None if !check.in_item && !self.bound(rest) && !data.has_key(rest) => {
                        self.warning(
                            &check.path,
                            format!("\"{rest}\" is not a state key (bind=) or data key — it reads as empty"),
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    // A state key some input binds or some action sets.
    fn bound(&self, key: &str) -> bool {
        self.binds.contains(key) || self.actions.set_keys.contains(key)
    }
}

fn ui_path(el: &MarkupElement) -> String {
    format!("ui line {} {}", el.pos.line, tag_label(el))
}

fn is_template(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(has_template)
}

fn list_ids(ids: &IndexSet<String>) -> String {
    let shown: Vec<&str> = ids.iter().take(10).map(String::as_str).collect();
    if ids.len() > 10 { format!("{}, …", shown.join(", ")) } else { shown.join(", ") }
}

// How many items a collection element shows, as far as that is known before any
// state exists: a filter that reads state is not applied.
fn static_count(items: &[&Value], el: &MarkupElement, ids: &IndexSet<String>) -> f64 {
    let filter = match el.attr("where") {
        Some(Value::String(text)) => parse_where(text).ok().filter(|node| !where_reads_state(node)),
        _ => None,
    };
    let skip: HashSet<String> = split_ids(el.attr("skip")).into_iter().filter(|id| ids.contains(id)).collect();
    let n = items
        .iter()
        .filter(|it| filter.as_ref().is_none_or(|node| match_where(Some(**it), node, None)))
        .filter(|it| skip.is_empty() || !skip.contains(&js::to_string(it.get("id"))))
        .count() as f64;
    let limit = js::to_number(el.attr("limit"));
    if limit.is_finite() && limit > 0.0 { n.min(limit) } else { n }
}
