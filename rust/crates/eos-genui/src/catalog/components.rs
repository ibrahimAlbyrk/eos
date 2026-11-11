//! The components a view can use and the attributes each accepts. The validator
//! and the catalog prompt are both generated from this table, so the docs a model
//! reads cannot drift from what is accepted. Order is part of the contract: it is
//! the order of the prompt and of "needs x=" problems.

use super::limits::ENTITY_TYPES;

pub const COMPONENT_GROUPS: &[ComponentGroup] = &[
    ComponentGroup::Layout,
    ComponentGroup::Content,
    ComponentGroup::Data,
    ComponentGroup::Entities,
    ComponentGroup::Geo,
    ComponentGroup::Inputs,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentGroup {
    Layout,
    Content,
    Data,
    Entities,
    Geo,
    Inputs,
}

impl ComponentGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            ComponentGroup::Layout => "layout",
            ComponentGroup::Content => "content",
            ComponentGroup::Data => "data",
            ComponentGroup::Entities => "entities",
            ComponentGroup::Geo => "geo",
            ComponentGroup::Inputs => "inputs",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrKind {
    /// Free text; may template item fields: "{cuisine} · {area}".
    Text,
    Number,
    Int,
    Bool,
    Enum,
    /// A number, or (with of=) the field that holds it.
    Numfield,
    Url,
    /// Entity ids: "moda lal".
    Ids,
    /// One entity id.
    Id,
    /// "A | B" or "A, B" or a JSON array.
    Labels,
    /// "name rating" or "name:Venue, rating:Score".
    Cols,
    /// "Label: filter, …".
    Chips,
    /// A flag, or "rating:max price:min".
    Best,
    Json,
    /// A data collection name.
    Collection,
    /// A field name of the collection's items.
    Field,
    /// One or more field names.
    Fields,
    /// Action ids: "book route".
    Actions,
    /// One action id.
    Action,
    /// A state key (inputs bind=).
    State,
    Expr,
    Where,
    /// "field" or "-field".
    Sort,
    Tone,
    Icon,
    /// A flag, or [lat, lon].
    Geo,
}

impl AttrKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AttrKind::Text => "text",
            AttrKind::Number => "number",
            AttrKind::Int => "int",
            AttrKind::Bool => "bool",
            AttrKind::Enum => "enum",
            AttrKind::Numfield => "numfield",
            AttrKind::Url => "url",
            AttrKind::Ids => "ids",
            AttrKind::Id => "id",
            AttrKind::Labels => "labels",
            AttrKind::Cols => "cols",
            AttrKind::Chips => "chips",
            AttrKind::Best => "best",
            AttrKind::Json => "json",
            AttrKind::Collection => "collection",
            AttrKind::Field => "field",
            AttrKind::Fields => "fields",
            AttrKind::Actions => "actions",
            AttrKind::Action => "action",
            AttrKind::State => "state",
            AttrKind::Expr => "expr",
            AttrKind::Where => "where",
            AttrKind::Sort => "sort",
            AttrKind::Tone => "tone",
            AttrKind::Icon => "icon",
            AttrKind::Geo => "geo",
        }
    }

    /// Kinds whose value may be a `{…}` template instead.
    pub fn templatable(self) -> bool {
        use AttrKind::{Bool, Enum, Icon, Id, Int, Number, Numfield, Text, Tone, Url};
        matches!(self, Text | Number | Int | Bool | Enum | Numfield | Url | Id | Tone | Icon)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AttrDef {
    pub kind: AttrKind,
    pub required: bool,
    /// The accepted values of an `Enum`.
    pub values: &'static [&'static str],
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Shown in the prompt after the attribute.
    pub doc: Option<&'static str>,
    /// The prompt lists the name only, not the enum values.
    pub brief: bool,
    /// Text rendered once per item of of=, so "{field}" reads that item's field.
    pub item: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildPolicy {
    None,
    Text,
    Nodes,
    Raw,
    Items,
}

impl ChildPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            ChildPolicy::None => "none",
            ChildPolicy::Text => "text",
            ChildPolicy::Nodes => "nodes",
            ChildPolicy::Raw => "raw",
            ChildPolicy::Items => "items",
        }
    }
}

/// Whether an element reads a data collection through `of=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionUse {
    /// of= must name a collection.
    Required,
    /// of= or another source.
    Optional,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ComponentDef {
    pub name: &'static str,
    pub group: ComponentGroup,
    pub doc: &'static str,
    pub attrs: &'static [(&'static str, AttrDef)],
    pub children: ChildPolicy,
    /// Set when the element also takes where / sort / limit / skip.
    pub collection: Option<CollectionUse>,
    /// At least one attribute of each group must be present (children count as "children").
    pub needs: &'static [&'static [&'static str]],
}

const fn k(kind: AttrKind) -> AttrDef {
    AttrDef { kind, required: false, values: &[], min: None, max: None, doc: None, brief: false, item: false }
}

const fn t() -> AttrDef {
    k(AttrKind::Text)
}

const fn ti() -> AttrDef {
    AttrDef { item: true, ..k(AttrKind::Text) }
}

const fn en(values: &'static [&'static str]) -> AttrDef {
    AttrDef { values, ..k(AttrKind::Enum) }
}

const fn int(min: f64, max: f64) -> AttrDef {
    AttrDef { min: Some(min), max: Some(max), ..k(AttrKind::Int) }
}

const fn num() -> AttrDef {
    k(AttrKind::Number)
}

const fn range(min: f64, max: f64) -> AttrDef {
    AttrDef { min: Some(min), max: Some(max), ..k(AttrKind::Number) }
}

const fn flag() -> AttrDef {
    k(AttrKind::Bool)
}

const fn req(a: AttrDef) -> AttrDef {
    AttrDef { required: true, ..a }
}

const fn doc(a: AttrDef, doc: &'static str) -> AttrDef {
    AttrDef { doc: Some(doc), ..a }
}

const fn brief(a: AttrDef) -> AttrDef {
    AttrDef { brief: true, ..a }
}

const GAP: &[&str] = &["sm", "md", "lg"];
const ALIGN: &[&str] = &["start", "center", "end", "stretch"];
const SIZE: &[&str] = &["sm", "md", "lg"];
const FORMAT: &[&str] = &["number", "int", "currency", "percent", "compact"];

use AttrKind as K;
use ChildPolicy as C;
use ComponentGroup as G;

/// Every element also takes these.
pub const GLOBAL_ATTRS: &[(&str, AttrDef)] =
    &[("label", doc(t(), "its tab label inside Tabs")), ("when", doc(k(K::Expr), "render only while true"))];

/// Collection elements also take these.
pub const COLLECTION_ATTRS: &[(&str, AttrDef)] =
    &[("where", k(K::Where)), ("sort", k(K::Sort)), ("limit", int(1.0, 100.0)), ("skip", k(K::Ids))];

const fn component(
    name: &'static str,
    group: ComponentGroup,
    doc: &'static str,
    attrs: &'static [(&'static str, AttrDef)],
    children: ChildPolicy,
) -> ComponentDef {
    ComponentDef { name, group, doc, attrs, children, collection: None, needs: &[] }
}

const fn collection(def: ComponentDef, collection: CollectionUse) -> ComponentDef {
    ComponentDef { collection: Some(collection), ..def }
}

const fn needs(def: ComponentDef, needs: &'static [&'static [&'static str]]) -> ComponentDef {
    ComponentDef { needs, ..def }
}

#[rustfmt::skip]
pub const COMPONENTS: &[ComponentDef] = &[
    // Layout
    component("Section", G::Layout, "titled group",
        &[("title", t()), ("meta", t()), ("icon", k(K::Icon)), ("collapsed", flag())], C::Nodes),
    component("Stack", G::Layout, "vertical flow, or a row",
        &[("gap", en(GAP)), ("dir", en(&["col", "row"])), ("align", en(ALIGN)), ("wrap", flag())], C::Nodes),
    component("Grid", G::Layout, "columns; reflows when narrow",
        &[("cols", int(1.0, 4.0)), ("gap", en(GAP)), ("min", doc(int(120.0, 480.0), "px"))], C::Nodes),
    component("Split", G::Layout, "two children side by side; stacks when narrow",
        &[("ratio", en(&["1:1", "1:2", "2:1", "2:3", "3:2"])), ("align", brief(en(ALIGN)))], C::Nodes),
    needs(collection(component("Carousel", G::Layout, "3–8 cards scrolling sideways, from of= or child elements",
        &[("of", k(K::Collection)), ("card", en(&["row", "compact", "hero"])), ("meta", ti()), ("actions", k(K::Actions))], C::Nodes),
        CollectionUse::Optional), &[&["of", "children"]]),
    component("Tabs", G::Layout, "segmented switch between child elements (each child's label=)",
        &[("bind", k(K::State)), ("labels", k(K::Labels))], C::Nodes),
    component("Disclosure", G::Layout, "row that expands to show its children",
        &[("title", req(t())), ("meta", t()), ("badge", t()), ("tone", k(K::Tone)), ("icon", k(K::Icon)), ("open", flag())], C::Nodes),
    component("Divider", G::Layout, "hairline; label= puts text on it", &[], C::None),

    // Content
    component("Text", G::Content, "inline-markdown paragraph",
        &[("size", en(SIZE)), ("tone", k(K::Tone)), ("muted", flag())], C::Text),
    component("Heading", G::Content, "heading",
        &[("level", int(1.0, 3.0)), ("meta", t()), ("icon", k(K::Icon))], C::Text),
    component("Image", G::Content, "one image",
        &[("src", req(k(K::Url))), ("alt", t()), ("ratio", en(&["16:9", "4:3", "3:2", "1:1", "21:9"])), ("credit", t()), ("fit", en(&["cover", "contain"]))], C::None),
    needs(collection(component("Gallery", G::Content, "several images, +N tile",
        &[("of", k(K::Collection)), ("field", k(K::Field)), ("images", doc(k(K::Json), "URLs")), ("layout", en(&["bento", "grid", "strip"]))], C::None),
        CollectionUse::Optional), &[&["of", "images"]]),
    needs(component("Logo", G::Content, "brand logo → site icon → monogram",
        &[("site", t()), ("name", t()), ("size", en(SIZE))], C::None), &[&["site", "name"]]),
    component("Badge", G::Content, "short tag",
        &[("tone", k(K::Tone)), ("icon", k(K::Icon)), ("variant", en(&["soft", "solid", "outline"]))], C::Text),
    component("Rating", G::Content, "★ value (count)",
        &[("value", req(range(0.0, 5.0))), ("count", int(0.0, 1e9)), ("source", int(1.0, 100.0))], C::None),
    needs(component("Price", G::Content, "price level (₺₺) or an amount",
        &[("level", int(1.0, 4.0)), ("amount", t()), ("currency", t()), ("per", t())], C::None), &[&["level", "amount"]]),
    component("Status", G::Content, "colored dot + text",
        &[("state", req(en(&["open", "closing", "closed", "ok", "warn", "error", "info", "running", "idle"]))), ("until", t())], C::Text),
    component("Callout", G::Content, "highlighted note; action= adds its button",
        &[("kind", en(&["info", "tip", "warning", "danger", "success"])), ("title", t()), ("icon", k(K::Icon)), ("action", k(K::Action))], C::Text),
    component("Quote", G::Content, "quotation", &[("cite", t()), ("source", int(1.0, 100.0))], C::Text),
    component("Code", G::Content, "code block: raw text child, or value= from a template",
        &[("lang", t()), ("title", t()), ("value", t()), ("wrap", flag())], C::Raw),
    component("FileRef", G::Content, "file chip that opens in the side panel",
        &[("path", req(t())), ("line", int(1.0, 1e7))], C::None),
    component("Sources", G::Content, "numbered sources (default of=sources)",
        &[("of", k(K::Collection)), ("compact", flag())], C::None),

    // Data
    component("Stat", G::Data, "KPI tile; spark= draws a sparkline under it; delta is coloured only with good= (the direction that is good news)",
        &[("label", req(t())), ("value", req(t())), ("meta", t()), ("delta", t()), ("trend", en(&["up", "down", "flat"])), ("good", en(&["up", "down"])),
          ("tone", k(K::Tone)), ("icon", k(K::Icon)), ("spark", doc(k(K::Json), "number list")), ("source", int(1.0, 100.0))], C::None),
    needs(collection(component("KeyValue", G::Data, "label/value rows",
        &[("of", k(K::Collection)), ("items", doc(k(K::Json), "{\"Label\":\"value\"}")), ("key", ti()), ("value", ti()), ("cols", int(1.0, 2.0))], C::None),
        CollectionUse::Optional), &[&["of", "items"]]),
    collection(component("Table", G::Data, "sortable compare table; a row selects its entity in every lens",
        &[("of", req(k(K::Collection))), ("cols", req(k(K::Cols))), ("best", k(K::Best)), ("numbered", flag()), ("actions", k(K::Actions))], C::None),
        CollectionUse::Required),
    needs(collection(component("Chart", G::Data, "chart from rows (x field, y field(s)) or values",
        &[("type", req(en(&["bar", "line", "area", "donut", "sparkline"]))), ("of", k(K::Collection)), ("x", k(K::Field)), ("y", k(K::Fields)),
          ("values", doc(k(K::Json), "number list")), ("unit", t()), ("height", int(60.0, 400.0)), ("stacked", flag())], C::None),
        CollectionUse::Optional), &[&["of", "values"]]),
    collection(component("Meter", G::Data, "bar meter; with of= one per item and value= names the field",
        &[("value", req(k(K::Numfield))), ("max", num()), ("label", ti()), ("unit", t()), ("tone", k(K::Tone)), ("of", k(K::Collection))], C::None),
        CollectionUse::Optional),
    collection(component("Timeline", G::Data, "time-ordered stops or events",
        &[("of", req(k(K::Collection))), ("time", ti()), ("title", ti()), ("note", ti()), ("meta", ti()), ("leg", doc(ti(), "to next")), ("numbered", flag())], C::None),
        CollectionUse::Required),
    needs(collection(component("Steps", G::Data, "ordered steps; stepper shows one at a time with Back/Next",
        &[("of", k(K::Collection)), ("variant", en(&["list", "stepper"])), ("bind", k(K::State)), ("title", ti()), ("text", ti()), ("code", ti())], C::Nodes),
        CollectionUse::Optional), &[&["of", "children"]]),
    needs(component("Progress", G::Data, "progress bar",
        &[("value", num()), ("max", num()), ("expr", k(K::Expr)), ("label", t()), ("tone", k(K::Tone))], C::None), &[&["value", "expr"]]),
    component("Value", G::Data, "live computed number",
        &[("expr", req(k(K::Expr))), ("label", t()), ("format", en(FORMAT)), ("prefix", t()), ("suffix", t()), ("decimals", int(0.0, 6.0)),
          ("currency", t()), ("tone", k(K::Tone)), ("size", en(SIZE))], C::None),

    // Entities
    component("Card", G::Entities, "one entity",
        &[("of", req(k(K::Collection))), ("pick", req(k(K::Id))), ("variant", en(&["row", "compact", "hero"])), ("kind", brief(doc(en(ENTITY_TYPES), "entity type"))),
          ("meta", ti()), ("badge", ti()), ("actions", k(K::Actions))], C::None),
    component("Hero", G::Entities, "the top pick, large; children say why",
        &[("of", req(k(K::Collection))), ("pick", req(k(K::Id))), ("badge", ti()), ("meta", ti()), ("actions", k(K::Actions)), ("gallery", flag())], C::Text),
    collection(component("List", G::Entities, "a row per item; child elements repeat per item (a disclosure row's detail)",
        &[("of", req(k(K::Collection))), ("variant", en(&["row", "compact", "disclosure"])), ("title", ti()), ("meta", ti()), ("badge", ti()), ("tone", k(K::Tone)),
          ("numbered", flag()), ("actions", k(K::Actions))], C::Items),
        CollectionUse::Required),

    // Geo
    collection(component("Map", G::Geo, "pins from geo or address; route joins them in order; you = the user",
        &[("of", req(k(K::Collection))), ("pin", en(&["index", "dot", "logo"])), ("route", flag()), ("you", k(K::Geo)), ("height", int(160.0, 600.0)), ("zoom", range(1.0, 19.0))], C::None),
        CollectionUse::Required),

    // Inputs
    component("Filters", G::Inputs, "chips filtering a collection in every lens",
        &[("of", req(k(K::Collection))), ("chips", req(k(K::Chips))), ("on", doc(k(K::Labels), "initially on")), ("bind", k(K::State))], C::None),
    component("Segmented", G::Inputs, "one of 2–5 options",
        &[("bind", req(k(K::State))), ("options", req(k(K::Labels))), ("default", t())], C::None),
    component("Toggle", G::Inputs, "on/off", &[("bind", req(k(K::State))), ("label", t()), ("default", flag())], C::None),
    component("Slider", G::Inputs, "number in a range",
        &[("bind", req(k(K::State))), ("min", req(num())), ("max", req(num())), ("step", num()), ("default", num()), ("label", t()), ("prefix", t()), ("suffix", t()),
          ("format", brief(doc(en(FORMAT), "as Value")))], C::None),
    component("Stepper", G::Inputs, "− n +",
        &[("bind", req(k(K::State))), ("min", num()), ("max", num()), ("step", num()), ("default", num()), ("label", t()), ("unit", t())], C::None),
    component("Select", G::Inputs, "dropdown",
        &[("bind", req(k(K::State))), ("options", req(k(K::Labels))), ("default", t()), ("label", t())], C::None),
    component("Field", G::Inputs, "text input",
        &[("bind", req(k(K::State))), ("label", t()), ("placeholder", t()), ("type", en(&["text", "number", "date", "time", "multiline"])), ("default", t())], C::None),
    needs(collection(component("Checklist", G::Inputs, "tick list with a done count",
        &[("bind", req(k(K::State))), ("of", k(K::Collection)), ("items", k(K::Labels)), ("title", t()), ("text", ti())], C::None),
        CollectionUse::Optional), &[&["of", "items"]]),
    component("Choice", G::Inputs, "quiz or poll; answer= reveals right/wrong locally; children = the question",
        &[("bind", req(k(K::State))), ("options", req(k(K::Labels))), ("question", t()), ("answer", doc(t(), "index or label")), ("explain", t()), ("action", k(K::Action))], C::Text),
    component("Form", G::Inputs, "groups inputs; submit sends the action with their values",
        &[("action", req(k(K::Action))), ("submit", t())], C::Nodes),
    component("Actions", G::Inputs, "buttons for actions",
        &[("ids", req(k(K::Actions))), ("align", en(&["start", "end", "stretch"]))], C::None),
];

/// The definition of a component, by its exact name.
pub fn component_def(name: &str) -> Option<&'static ComponentDef> {
    COMPONENTS.iter().find(|c| c.name == name)
}

pub fn is_component_name(name: &str) -> bool {
    component_def(name).is_some()
}

pub fn component_names() -> impl Iterator<Item = &'static str> {
    COMPONENTS.iter().map(|c| c.name)
}

impl ComponentDef {
    /// Every attribute the component accepts: global, collection, then its own.
    /// One of its own that shares a global name takes that attribute's place.
    pub fn all_attrs(&self) -> Vec<(&'static str, &'static AttrDef)> {
        let mut out: Vec<(&'static str, &'static AttrDef)> =
            Vec::with_capacity(GLOBAL_ATTRS.len() + COLLECTION_ATTRS.len() + self.attrs.len());
        let inherited = GLOBAL_ATTRS.iter().chain(if self.collection.is_some() { COLLECTION_ATTRS } else { &[] });
        for (name, def) in inherited.chain(self.attrs) {
            match out.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = def,
                None => out.push((name, def)),
            }
        }
        out
    }
}
