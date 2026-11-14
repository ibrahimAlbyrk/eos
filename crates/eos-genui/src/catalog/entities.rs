//! Entity, row, source and action shapes. Messages that start with "is " follow
//! the offending value: "6.2 is outside 0–5".

use std::sync::LazyLock;

use super::limits::{ACTION_KINDS, GENUI_ICONS, GENUI_LIMITS, SITE_RE, URL_RE};
use super::schema::{NumCheck, Schema, Segment, StrCheck};
use crate::value::Value;

fn short_text(max: usize) -> Schema {
    Schema::Str(vec![StrCheck::Max(max, Some(format!("is longer than {max} characters")))])
}

fn url() -> Schema {
    Schema::Str(vec![StrCheck::Max(2048, None), StrCheck::Matches(&URL_RE, "must be an http(s) URL")])
}

fn site() -> Schema {
    Schema::Str(vec![StrCheck::Max(253, None), StrCheck::Matches(&SITE_RE, "must be a domain like example.com")])
}

fn number() -> Schema {
    Schema::Num(Vec::new())
}

fn one_of(options: Vec<Schema>, message: &'static str) -> Schema {
    Schema::OneOf { options, message }
}

fn list(item: Schema, max: usize) -> Schema {
    Schema::Array { item: Box::new(item), max: Some(max) }
}

fn geo() -> Schema {
    const LAT: Option<&str> = Some("is not a latitude (−90–90)");
    const LON: Option<&str> = Some("is not a longitude (−180–180)");
    Schema::Tuple {
        items: vec![
            Schema::Num(vec![NumCheck::Min(-90.0, LAT), NumCheck::Max(90.0, LAT)]),
            Schema::Num(vec![NumCheck::Min(-180.0, LON), NumCheck::Max(180.0, LON)]),
        ],
        message: "must be [lat, lon] — two numbers",
    }
}

fn rating() -> Schema {
    Schema::Num(vec![NumCheck::Min(0.0, Some("is outside 0–5")), NumCheck::Max(5.0, Some("is outside 0–5"))])
}

fn source_number() -> Schema {
    Schema::Num(vec![
        NumCheck::Int(Some("is not a source number")),
        NumCheck::Min(1.0, Some("is not a source number (1 = data.sources[0])")),
    ])
}

fn source_ref() -> Schema {
    one_of(
        vec![source_number(), list(source_number(), 10)],
        "must be a source number ≥ 1 (1 = data.sources[0]) or a list of them",
    )
}

fn id() -> Schema {
    one_of(
        vec![Schema::Str(vec![StrCheck::Min(1, None), StrCheck::Max(100, None)]), number()],
        "must be a string or number",
    )
}

fn hours() -> Schema {
    let detail = Schema::Object(vec![
        ("from", short_text(20).optional()),
        ("until", short_text(20).optional()),
        ("closed", Schema::Bool.optional()),
        ("text", short_text(80).optional()),
    ]);
    one_of(vec![short_text(80), detail], "must be {from, until, closed, text} or short text")
}

fn amount() -> Schema {
    one_of(vec![number(), short_text(40)], "must be a number or short text")
}

fn whole(checks: Vec<NumCheck>) -> Schema {
    let mut all = vec![NumCheck::Int(None)];
    all.extend(checks);
    Schema::Num(all)
}

// The fields every entity shares, then its type tag and its own fields.
fn entity(tag: &'static str, own: Vec<(&'static str, Schema)>) -> (&'static str, Schema) {
    let mut fields = vec![
        ("id", id()),
        ("name", short_text(200).optional()),
        ("title", short_text(200).optional()),
        ("image", url().optional()),
        ("images", list(url(), 12).optional()),
        ("site", site().optional()),
        ("url", url().optional()),
        ("source", source_ref().optional()),
        ("tags", list(short_text(60), 30).optional()),
        ("rating", rating().optional()),
        ("reviews", whole(vec![NumCheck::Min(0.0, Some("is not a review count"))]).optional()),
        ("geo", geo().optional()),
        ("address", short_text(300).optional()),
        ("status", short_text(60).optional()),
        ("meta", short_text(200).optional()),
        ("note", short_text(600).optional()),
        ("type", Schema::Literal(tag)),
    ];
    fields.extend(own);
    (tag, Schema::Object(fields))
}

pub(crate) static ENTITY: LazyLock<Schema> = LazyLock::new(|| {
    const PRICE_LEVEL: Option<&str> = Some("is outside 1–4 (price level)");
    let price_level = Schema::Num(vec![
        NumCheck::Int(Some("is not a price level (1–4)")),
        NumCheck::Min(1.0, PRICE_LEVEL),
        NumCheck::Max(4.0, PRICE_LEVEL),
    ]);
    let spec = one_of(vec![Schema::Str(Vec::new()), number(), Schema::Bool], "must be text, a number or true/false");
    let options = vec![
        entity(
            "Place",
            vec![
                ("price", price_level.optional()),
                ("hours", hours().optional()),
                ("area", short_text(100).optional()),
                ("cuisine", short_text(100).optional()),
                ("distance", amount().optional()),
            ],
        ),
        entity(
            "Product",
            vec![
                ("price", amount().optional()),
                ("currency", short_text(10).optional()),
                ("brand", short_text(100).optional()),
                ("inStock", Schema::Bool.optional()),
                ("specs", Schema::Record(Box::new(spec)).optional()),
            ],
        ),
        entity(
            "Event",
            vec![
                ("start", short_text(60).optional()),
                ("end", short_text(60).optional()),
                ("venue", short_text(200).optional()),
                ("price", amount().optional()),
            ],
        ),
        entity("Person", vec![("role", short_text(120).optional()), ("org", short_text(120).optional())]),
        entity(
            "Article",
            vec![
                ("author", short_text(120).optional()),
                ("date", short_text(60).optional()),
                ("excerpt", short_text(600).optional()),
            ],
        ),
        entity(
            "Media",
            vec![
                ("kind", Schema::Enum(&["video", "audio", "image", "podcast"]).optional()),
                ("duration", short_text(20).optional()),
                ("date", short_text(60).optional()),
                ("author", short_text(120).optional()),
            ],
        ),
        entity(
            "File",
            vec![
                ("path", Schema::Str(vec![StrCheck::Min(1, None), StrCheck::Max(1024, None)])),
                ("line", whole(vec![NumCheck::Min(1.0, Some("is not a line number"))]).optional()),
                ("added", whole(vec![NumCheck::Min(0.0, None)]).optional()),
                ("removed", whole(vec![NumCheck::Min(0.0, None)]).optional()),
                ("lang", short_text(40).optional()),
            ],
        ),
        entity("Generic", Vec::new()),
    ];
    Schema::Discriminated { key: "type", options }
});

/// An untyped row in a collection (chart points, steps, table rows): free-form,
/// but the fields every lens reads are still checked.
/// The top-level fields of an entity that break its schema, in the order the
/// issues are raised (a field can appear twice); empty when the entity is
/// accepted. A caller that builds entities from outside data drops these
/// fields and keeps the rest.
pub fn entity_issue_fields(entity: &Value) -> Vec<String> {
    ENTITY
        .check(Some(entity))
        .into_iter()
        .map(|issue| match issue.path.first() {
            Some(Segment::Key(key)) => key.clone(),
            Some(Segment::Index(index)) => index.to_string(),
            None => "undefined".to_owned(),
        })
        .collect()
}

pub(crate) static ROW: LazyLock<Schema> = LazyLock::new(|| {
    Schema::Object(vec![
        ("id", id().optional()),
        ("rating", rating().optional()),
        ("geo", geo().optional()),
        ("image", url().optional()),
        ("source", source_ref().optional()),
    ])
});

pub(crate) static SOURCE: LazyLock<Schema> = LazyLock::new(|| {
    let shape = Schema::Object(vec![
        ("title", short_text(200).optional()),
        ("name", short_text(200).optional()),
        ("url", url().optional()),
        ("site", site().optional()),
        ("at", short_text(40).optional()),
        ("note", short_text(200).optional()),
    ]);
    // Reached only when every listed field has the right type, so "set" means a non-empty string.
    let named = |s: &Value| {
        ["title", "name", "url", "site"].iter().any(|k| s.get(k).and_then(Value::as_str).is_some_and(|v| !v.is_empty()))
    };
    Schema::Refine { inner: Box::new(shape), check: named, message: "needs a title, url or site" }
});

/// The fields of an action; anything else in one is ignored with a warning.
pub(crate) const ACTION_FIELDS: &[&str] = &["label", "kind", "primary", "text", "href", "set", "icon"];

pub(crate) static ACTION: LazyLock<Schema> = LazyLock::new(|| {
    let max = GENUI_LIMITS.action_label_chars;
    Schema::Object(vec![
        (
            "label",
            Schema::Str(vec![
                StrCheck::Min(1, Some("is empty")),
                StrCheck::Max(max, Some(format!("is longer than {max} characters"))),
            ]),
        ),
        ("kind", Schema::Enum(ACTION_KINDS)),
        ("primary", Schema::Bool.optional()),
        // send: the turn text (templated: "{name}", "{state.party}"; default: the label).
        // prefill/copy: the text.
        ("text", Schema::Str(vec![StrCheck::Max(4000, None)]).optional()),
        // open: an http(s) URL, a file path, or maps:{geo}.
        ("href", Schema::Str(vec![StrCheck::Max(2048, None)]).optional()),
        // set: state keys to set locally.
        ("set", Schema::Record(Box::new(Schema::Unknown)).optional()),
        ("icon", Schema::Enum(GENUI_ICONS).optional()),
    ])
});
