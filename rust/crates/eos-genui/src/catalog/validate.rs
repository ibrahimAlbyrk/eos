//! `validate_view` — the full check a `present` call passes before it is stored.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::actions::validate_actions;
use super::data::{kb, validate_data};
use super::limits::{ENTITY_TYPES, GENUI_ICONS, GENUI_LIMITS, GENUI_TONES, PRESENT_KEYS, VIEW_ID_RE};
use super::problems::{ViewProblem, show};
use super::ui::UiContext;
use crate::js;
use crate::markup::{MarkupNode, parse_markup};
use crate::re::is_match;
use crate::value::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionStat {
    pub name: String,
    pub count: usize,
    /// The entity type most items share; `None` for untyped rows.
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStats {
    pub ui_bytes: usize,
    pub data_bytes: usize,
    pub elements: usize,
    pub depth: usize,
    pub components: Vec<String>,
    pub collections: Vec<CollectionStat>,
    pub images: usize,
    pub sites: usize,
    pub maps: usize,
    pub primary_actions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewValidation {
    Ok { warnings: Vec<ViewProblem>, stats: ViewStats },
    Rejected { problems: Vec<ViewProblem>, warnings: Vec<ViewProblem> },
}

impl ViewValidation {
    pub fn is_ok(&self) -> bool {
        matches!(self, ViewValidation::Ok { .. })
    }

    pub fn warnings(&self) -> &[ViewProblem] {
        match self {
            ViewValidation::Ok { warnings, .. } | ViewValidation::Rejected { warnings, .. } => warnings,
        }
    }

    /// Empty when the view is accepted.
    pub fn problems(&self) -> &[ViewProblem] {
        match self {
            ViewValidation::Ok { .. } => &[],
            ViewValidation::Rejected { problems, .. } => problems,
        }
    }
}

/// Checks the raw input of a `present` call. Every problem is listed (a model
/// fixes them all in one more call); warnings come back either way.
pub fn validate_view(input: &Value) -> ViewValidation {
    let mut problems: Vec<ViewProblem> = Vec::new();
    let mut warnings: Vec<ViewProblem> = Vec::new();
    let Value::Object(input) = input else {
        return ViewValidation::Rejected {
            problems: vec![ViewProblem::new("input", "must be an object with title, ui and summary")],
            warnings,
        };
    };
    for key in input.keys() {
        if !PRESENT_KEYS.contains(&key) {
            warnings.push(ViewProblem::new(
                key,
                format!("is not a present field — ignored (fields: {})", PRESENT_KEYS.join(", ")),
            ));
        }
    }

    match text_field(input.get("title")) {
        None => problems.push(ViewProblem::new("title", "is required — a short heading for the view")),
        Some(title) => check_length("title", title, GENUI_LIMITS.title_chars, &mut problems),
    }
    match text_field(input.get("summary")) {
        None => problems
            .push(ViewProblem::new("summary", "is required — the plain-text answer shown when the view can't render")),
        Some(summary) => check_length("summary", summary, GENUI_LIMITS.summary_chars, &mut problems),
    }

    for (key, allowed) in [("tone", GENUI_TONES), ("icon", GENUI_ICONS)] {
        let value = input.get(key);
        if value.is_some() && !value.and_then(Value::as_str).is_some_and(|v| allowed.contains(&v)) {
            problems.push(ViewProblem::new(key, format!("{} is not one of {}", show(value), allowed.join(", "))));
        }
    }
    let replaces = input.get("replaces");
    if replaces.is_some() && !replaces.and_then(Value::as_str).is_some_and(|v| is_match(&VIEW_ID_RE, v)) {
        problems.push(ViewProblem::new(
            "replaces",
            format!(
                "{} is not a view id (v_ + 12 letters/digits, from an earlier \"view … rendered\")",
                show(replaces)
            ),
        ));
    }

    let data = validate_data(input.get("data"), &mut problems, &mut warnings);
    let actions = validate_actions(input.get("actions"), &mut problems, &mut warnings);

    let mut ctx = UiContext::new(&data, &actions, &mut problems, &mut warnings);
    let mut ui_bytes = 0;
    match text_field(input.get("ui")) {
        None => ctx.problems.push(ViewProblem::new("ui", "is required — the markup that lays out the view")),
        Some(ui) => {
            ui_bytes = ui.len();
            if ui_bytes > GENUI_LIMITS.ui_bytes {
                let message = format!(
                    "is {}, max {} — move repeated content into data and reference it",
                    kb(ui_bytes),
                    kb(GENUI_LIMITS.ui_bytes)
                );
                ctx.problems.push(ViewProblem::new("ui", message));
            }
            let parsed = parse_markup(ui);
            ctx.problems.extend(
                parsed.errors.iter().map(|e| ViewProblem::new(format!("ui line {}", e.line), e.message.clone())),
            );
            let has_elements = parsed.nodes.iter().any(|n| matches!(n, MarkupNode::Element(_)));
            if !has_elements && parsed.errors.is_empty() {
                ctx.problems.push(ViewProblem::new("ui", "has no components — e.g. <Card of=\"places\" pick=\"…\"/>"));
            }
            ctx.visit(&parsed.nodes);
            ctx.check_expr_refs();
        }
    }

    let images = ctx.images.len();
    if images > GENUI_LIMITS.images {
        ctx.problems.push(ViewProblem::new(
            "data",
            format!("{images} images, max {} — keep the ones that matter", GENUI_LIMITS.images),
        ));
    }
    let (elements, depth, maps) = (ctx.elements, ctx.depth, ctx.maps);
    let mut components: Vec<String> = ctx.components.iter().map(|c| (*c).to_owned()).collect();

    if !problems.is_empty() {
        return ViewValidation::Rejected { problems, warnings };
    }
    components.sort();
    let collections = data
        .collections
        .iter()
        .map(|(name, items)| CollectionStat {
            name: (*name).to_owned(),
            count: items.len(),
            kind: dominant_type(items),
        })
        .collect();
    let stats = ViewStats {
        ui_bytes,
        data_bytes: data.bytes,
        elements,
        depth,
        components,
        collections,
        images,
        sites: data.sites.len(),
        maps,
        primary_actions: actions.primary,
    };
    ViewValidation::Ok { warnings, stats }
}

// A text field that is set: a string with something other than whitespace in it.
fn text_field(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !js::is_blank(s))
}

fn check_length(path: &str, text: &str, max: usize, problems: &mut Vec<ViewProblem>) {
    let len = js::len16(text);
    if len > max {
        problems.push(ViewProblem::new(path, format!("is {len} characters, max {max}")));
    }
}

// The `type` most items carry, when it names an entity.
fn dominant_type(items: &[&Value]) -> Option<String> {
    let mut counts: IndexMap<&str, usize> = IndexMap::new();
    for kind in items.iter().filter_map(|it| it.get("type")).filter_map(Value::as_str) {
        *counts.entry(kind).or_default() += 1;
    }
    // The first to reach the highest count wins a tie.
    let mut best: Option<(&str, usize)> = None;
    for (kind, n) in counts {
        if n > best.map_or(0, |b| b.1) {
            best = Some((kind, n));
        }
    }
    best.map(|b| b.0).filter(|k| ENTITY_TYPES.contains(k)).map(str::to_owned)
}

/// "6 places" — the largest collection, for the tool's success line.
pub fn stats_line(stats: &ViewStats) -> String {
    // The first of the largest: a later collection has to be strictly bigger.
    let mut top: Option<&CollectionStat> = None;
    for c in stats.collections.iter().filter(|c| c.name != "sources") {
        if top.is_none_or(|t| c.count > t.count) {
            top = Some(c);
        }
    }
    top.map(|t| format!("{} {}", t.count, t.name)).unwrap_or_default()
}
