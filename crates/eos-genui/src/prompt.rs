//! `catalog_prompt()`: the compact catalog reference that goes into the `present`
//! tool's description. Generated from the catalog so the docs the model reads
//! never drift from what the validator accepts.

use crate::catalog::{
    AttrDef, AttrKind, COMPONENT_GROUPS, COMPONENTS, ComponentDef, ComponentGroup, GENUI_ICONS, GENUI_LIMITS,
    GENUI_TONES,
};
use crate::expr::EXPR_FUNCTIONS;
use crate::js::number_to_string;

fn group_title(group: ComponentGroup) -> &'static str {
    match group {
        ComponentGroup::Layout => "Layout",
        ComponentGroup::Content => "Content",
        ComponentGroup::Data => "Data",
        ComponentGroup::Entities => "Entities",
        ComponentGroup::Geo => "Geo",
        ComponentGroup::Inputs => "Inputs",
    }
}

fn attr_text(name: &str, a: &AttrDef) -> String {
    let mut s = name.to_owned();
    if a.kind == AttrKind::Enum && !a.brief {
        s.push_str(&format!("={}", a.values.join("|")));
    } else if let (AttrKind::Int | AttrKind::Number, Some(min), Some(max)) = (a.kind, a.min, a.max)
        && max < 1e6
    {
        s.push_str(&format!("={}–{}", number_to_string(min), number_to_string(max)));
    }
    if a.required {
        s.push('*');
    }
    if let Some(doc) = a.doc {
        s.push_str(&format!(" ({doc})"));
    }
    s
}

// The names of every {…} attribute, each once, in catalog order.
fn json_attr_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    for (name, a) in COMPONENTS.iter().flat_map(|c| c.attrs) {
        if a.kind == AttrKind::Json && !names.contains(name) {
            names.push(name);
        }
    }
    names
}

fn component_line(def: &ComponentDef) -> String {
    let mut attrs: Vec<String> = def.attrs.iter().map(|(n, a)| attr_text(n, a)).collect();
    if def.collection.is_some() {
        attrs.push("⊂".to_owned());
    }
    let body = if attrs.is_empty() { String::new() } else { format!(" {}", attrs.join(" ")) };
    format!("{}{body} — {}", def.name, def.doc)
}

pub fn catalog_prompt() -> String {
    let l = GENUI_LIMITS;
    let functions: Vec<&str> = EXPR_FUNCTIONS.iter().copied().filter(|f| *f != "fv").collect();
    let mut lines: Vec<String> = vec![
        "# present — visual answers".to_owned(),
        "Write the keys in this order: title, tone, icon, replaces, data, actions, ui, summary.".to_owned(),
        format!("- title ≤ {} chars. tone (one accent): {}. icon: {}.", l.title_chars, GENUI_TONES.join("|"), GENUI_ICONS.join(" ")),
        "- replaces: id of an earlier view this one updates (it folds to a stub).".to_owned(),
        "- data: each entity once; a collection is an array of objects. ui only references data — never repeat a row in markup.".to_owned(),
        format!(
            "- actions: {{id: {{label, kind, primary?, text?, href?, set?}}}} — send (posts a turn to you; text may template {{field}} and {{state.key}}; default = label) · prefill (text → composer) · open (href: URL, file path, maps:{{geo}}) · copy (text) · set ({{stateKey: value}}, local). ≤ {} primary.",
            l.primary_actions
        ),
        format!("- ui ≤ {} KB. summary: the answer as plain text ≤ {} chars (fallback, notifications, phones).", l.ui_bytes / 1024, l.summary_chars),
        String::new(),
        "## Entities {type, id, …} — extra fields stay usable in templates".to_owned(),
        "Place: name rating(0–5) reviews price(1–4) geo[lat,lon] address hours{until|closed|text} area cuisine distance".to_owned(),
        "Product: name price currency brand specs inStock · Event: name start end venue geo price · Person: name role org".to_owned(),
        "Article: title author date excerpt · Media: title kind duration · File: path line added removed · Generic: any".to_owned(),
        "All: image (http URL from results, never invented) site (domain → logo) url source (1-based into data.sources) tags[]. Untyped rows need no type/id; a type naming no entity is a plain field.".to_owned(),
        "data.sources: [{title, url, site, at, note}] — required when stating facts. Unknown → leave it out.".to_owned(),
        String::new(),
        "## Markup".to_owned(),
        format!(
            "<Tag a=\"text\" n={{3}} list={{[\"a\",\"b\"]}} flag>children</Tag> · <Tag a=\"x\"/>. {{…}} is JSON, never JS. Text children: inline markdown, no HTML. Depth ≤ {}.",
            l.depth
        ),
        format!("A {{…}} attr ({}) may name a data key: items=\"limits\".", json_attr_names().join(" ")),
        "⊂ = takes of=\"collection\" + where= sort=\"field|-field\" limit= skip=\"ids\".".to_owned(),
        "Field attrs (x y cols, Meter value) take a bare name (y=\"amount\"); text attrs read a field only in braces (meta=\"{cuisine} · {area}\"): title=\"title\" prints \"title\". Omit title/text/meta to show the item's own.".to_owned(),
        "Lists: ids \"a b\" or \"a, b\"; labels \"A | B\" or \"A, B\"; or JSON arrays.".to_owned(),
        "where: open · field · !field · field op value (== != < <= > >= ~contains), joined by && or || (&& binds tighter), ( ) groups; state.key on either side.".to_owned(),
        format!(
            "expr (Value, Progress, when=): arithmetic, comparisons, && || ! ?:; names = state keys, item fields, data (places.rating = all ratings); fns {} fv(payment, annualRate, years).",
            functions.join(" ")
        ),
        "Inputs bind=\"key\" to view state. Any element: when=\"expr\", label= (its tab in Tabs). Filters and selection apply to every lens of a collection.".to_owned(),
        String::new(),
        "## Components (* required)".to_owned(),
    ];
    for group in COMPONENT_GROUPS {
        lines.push(format!("{}:", group_title(*group)));
        lines.extend(COMPONENTS.iter().filter(|c| c.group == *group).map(|c| format!("- {}", component_line(c))));
    }
    lines.push(String::new());
    lines.push(format!(
        "Limits: data ≤ {} KB · Carousel {}–{} items · ≤ {} Map · ≤ {} images. A rejected call lists each problem with its path — fix all, call again.",
        l.data_bytes / 1024,
        l.carousel_min,
        l.carousel_max,
        l.maps,
        l.images
    ));
    lines.join("\n")
}
