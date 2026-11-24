//! Drawing a page issue from its design version, its data and its images.
//! Rendering is deterministic: the same version, data and images always give
//! the same document, so an issue stores no HTML. Nothing here reads a clock
//! or fetches anything; a value always goes in as escaped text.

mod comfort;
pub(crate) mod format;
mod frame;
mod html;

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::design::PageDesign;

pub use frame::{BASE_CSS, RUNTIME_JS, frame_csp, frame_document, runtime_hash};
pub use html::render_body;

/// Where a page is drawn: each mode keeps what works there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The dashboard's frame, with the page runtime.
    Frame,
    /// The phone's web view: no script, buttons as `eos-action:` links.
    Phone,
    /// A file to share: no script, buttons left out.
    Share,
    /// A mail body: one column, buttons as "Open in Eos" links.
    Mail,
}

/// What became of one image of an issue's data, by its `src`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageState {
    Ready {
        hash: String,
    },
    Failed {
        reason: String,
    },
    /// Still being fetched: drawn as its alt text until it settles.
    Preparing,
}

/// What Eos fills itself under `issue.*`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueFacts {
    pub id: String,
    /// None for a trial issue.
    pub seq: Option<i64>,
    /// `YYYY-MM-DD`, the issue's day where the reader is.
    pub date: String,
    /// The reader's first name.
    pub reader: String,
}

impl IssueFacts {
    fn as_value(&self) -> Value {
        json!({"seq": self.seq.unwrap_or(0), "date": self.date, "reader": self.reader})
    }
}

/// How the reader asked pages to read (05 Q11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Comfort {
    /// 100, 115 or 130.
    pub text_scale: u16,
    pub more_contrast: bool,
}

pub struct RenderInput<'a> {
    pub design: &'a PageDesign,
    pub data: &'a Value,
    pub issue: &'a IssueFacts,
    pub images: &'a HashMap<String, ImageState>,
    /// Where a stored image is read from in this mode: a raw-origin URL, a
    /// `data:` URI or a `cid:`; None draws its alt text.
    pub image_src: &'a dyn Fn(&str) -> Option<String>,
    /// A Live part's query answer, by part name.
    pub live: &'a HashMap<String, Value>,
    /// Whether a text looks like a secret; it is then masked.
    pub is_secret: &'a dyn Fn(&str) -> bool,
    /// The reader's offset from UTC in minutes.
    pub offset: i32,
    pub lang: &'a str,
    /// The surface's title, which labels the page.
    pub title: &'a str,
    pub comfort: Comfort,
}

impl std::fmt::Debug for RenderInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenderInput").field("issue", &self.issue.id).finish_non_exhaustive()
    }
}

/// The value at a dotted path of `data`.
pub fn lookup<'v>(data: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').try_fold(data, |value, name| value.get(name)).filter(|v| !v.is_null())
}

/// A value present and not empty, as `if=` reads it.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::Object(_)) => true,
    }
}
