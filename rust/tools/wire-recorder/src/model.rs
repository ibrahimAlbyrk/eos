//! The recording file format.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request, or opening / closing an event stream. Strings may hold `{var}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub name: String,
    /// `"METHOD /path"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    /// Opens `GET /stream` under this name; later steps record the frames it carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
    /// Closes the named stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close: Option<String>,
    /// Records the answer of an earlier step that was sent with `detach`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
    /// Send the request and go on without its answer: it stays open until a
    /// later step makes the target answer. A `join` step records the answer.
    #[serde(default, skip_serializing_if = "is_false")]
    pub detach: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub query: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Auth::is_default")]
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Via::is_default")]
    pub via: Via,
    /// JSON body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    /// JSON body as text, for what TOML cannot write (`null`, a top-level array).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<String>,
    /// Raw body, sent with `content_type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Raw body as base64, for bytes that are not text (an image).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// The status the recording's author expected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// `var = "/pointer"` into the raw response, for later steps.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capture: BTreeMap<String, String>,
    /// Stream reasons that must arrive before the step is done.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wait: Vec<String>,
    /// The data may not have what this step needs (a list was empty): skip it
    /// then.
    #[serde(default, skip_serializing_if = "is_false")]
    pub optional: bool,
    /// Wait before the request (a terminal needs time to print).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_ms: Option<u64>,
}

/// Whose request it is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    /// The user's dashboard: carries the ui-token.
    #[default]
    Ui,
    /// Any local process: no token.
    None,
}

impl Auth {
    fn is_default(&self) -> bool {
        *self == Self::Ui
    }
}

/// Which door the request takes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    /// The API listener (CORS and Host rules apply).
    #[default]
    Api,
    /// The raw-content listener.
    Raw,
    /// The local control socket.
    Socket,
}

impl Via {
    fn is_default(&self) -> bool {
        *self == Self::Api
    }
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// What `replay` reads (`recordings/<name>.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Recording {
    pub scenario: String,
    pub about: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub record_headers: Vec<String>,
    pub exchanges: Vec<Exchange>,
}

/// A step and the normalized answer it got.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Exchange {
    pub step: Step,
    /// The registered route that answered, when a route table was given (`METHOD pattern`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    /// `null` when the step was skipped because a variable it needs was never captured.
    pub response: Value,
}

impl Step {
    /// True for a step that cannot change anything: a GET or HEAD request, or a stream.
    /// Every route that messages, spawns, resumes or compacts an agent is another method.
    pub fn only_reads(&self) -> bool {
        match self.method_and_path() {
            Ok((method, _)) => matches!(method, "GET" | "HEAD"),
            Err(_) => self.request.is_none(),
        }
    }

    /// Splits `request` into its method and path template.
    pub fn method_and_path(&self) -> anyhow::Result<(&str, &str)> {
        let request = self.request.as_deref().context("not a request step")?;
        let (method, path) = request.split_once(' ').context("expected \"METHOD /path\"")?;
        if !path.starts_with('/') || method.is_empty() || method.chars().any(|c| !c.is_ascii_uppercase()) {
            bail!("expected \"METHOD /path\"");
        }
        Ok((method, path))
    }
}

impl Recording {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_round_trips_through_a_recording() {
        let step = Step {
            name: "s".into(),
            request: Some("GET /x".into()),
            status: Some(200),
            auth: Auth::None,
            ..Step::default()
        };
        let text = serde_json::to_string(&step).expect("serializes");
        assert_eq!(text, r#"{"name":"s","request":"GET /x","auth":"none","status":200}"#);
        assert_eq!(serde_json::from_str::<Step>(&text).expect("parses"), step);
    }
}
