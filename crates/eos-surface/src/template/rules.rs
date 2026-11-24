//! What a page template may be made of. The tables also write the designer's
//! catalog, so what it is told and what is checked never drift apart.

/// The HTML elements a page may use.
pub const ELEMENTS: &[&str] = &[
    "div",
    "section",
    "article",
    "aside",
    "header",
    "footer",
    "main",
    "figure",
    "figcaption",
    "h1",
    "h2",
    "h3",
    "h4",
    "p",
    "span",
    "strong",
    "em",
    "small",
    "b",
    "i",
    "u",
    "s",
    "blockquote",
    "ul",
    "ol",
    "li",
    "hr",
    "br",
    "img",
    "a",
    "time",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
];

/// Elements that hold nothing, written `<br/>`.
pub(crate) const VOID: &[&str] = &["hr", "br", "img"];

/// Elements that must carry a `part` name: pointing at a page picks one.
pub(crate) const SECTIONING: &[&str] = &["section", "article", "aside", "header", "footer", "main"];

/// Attributes any element may carry.
pub(crate) const ATTRIBUTES: &[&str] =
    &["class", "style", "part", "each", "as", "if", "unless", "lang", "dir", "aria-label"];

/// Attributes only some elements may carry.
pub(crate) const ELEMENT_ATTRIBUTES: &[(&str, &[&str])] = &[
    ("img", &["src", "alt"]),
    ("a", &["href"]),
    ("time", &["datetime"]),
    ("th", &["colspan", "rowspan"]),
    ("td", &["colspan", "rowspan"]),
];

/// Where a link may go besides a `url` field.
pub const EOS_TARGETS: &[&str] = &["eos:needs-you", "eos:run", "eos:issue"];

/// The parts that react, with the attributes each takes besides `part`,
/// `if` and `unless`, and which of those it needs.
#[derive(Debug)]
pub struct Component {
    pub name: &'static str,
    pub attrs: &'static [&'static str],
    pub required: &'static [&'static str],
    /// Whether it holds children of its own.
    pub children: bool,
    pub about: &'static str,
}

pub const COMPONENTS: &[Component] = &[
    Component {
        name: "Filters",
        attrs: &["of", "by"],
        required: &["of", "by"],
        children: false,
        about: "chips that narrow a repeat: of= the repeated list, by= a text or enum field of its items",
    },
    Component {
        name: "Disclosure",
        attrs: &["title"],
        required: &["title"],
        children: true,
        about: "a part the reader opens: title= its line, its children inside",
    },
    Component {
        name: "Button",
        attrs: &["action", "args", "label"],
        required: &["action", "label"],
        children: false,
        about: "runs a direct action named in uses: action= its id, args={{…}} slot texts, label= its words",
    },
    Component {
        name: "Ask",
        attrs: &["label"],
        required: &["label"],
        children: false,
        about: "hands the item it sits in to the routine's agent: label= its words",
    },
    Component {
        name: "Live",
        attrs: &["query", "args"],
        required: &["query"],
        children: true,
        about: "a part fed by a named query in queries: query= its id, args={{…}}, children read {query.…}",
    },
];

pub(crate) fn component(name: &str) -> Option<&'static Component> {
    COMPONENTS.iter().find(|c| c.name == name)
}

pub(crate) fn element_attributes(name: &str) -> &'static [&'static str] {
    ELEMENT_ATTRIBUTES.iter().find(|(el, _)| *el == name).map_or(&[], |(_, attrs)| attrs)
}

/// The names `issue.*` holds: the issue's number, its date and the reader's
/// first name.
pub const ISSUE_FIELDS: &[&str] = &["seq", "date", "reader"];

/// The deepest a template's elements may nest.
pub(crate) const MAX_NESTING: usize = 24;
/// Repeats inside repeats.
pub(crate) const MAX_REPEATS: usize = 2;
