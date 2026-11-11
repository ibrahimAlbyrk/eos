//! The scenario and recording file formats.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One route group: an ordered list of steps (`scenarios/<name>.toml`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub about: String,
    /// Safe on a real data folder: only reads (enforced: GET and HEAD requests,
    /// nothing else) and finds its ids by capture.
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// Response headers kept for this group on top of the normalizer's list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub record_headers: Vec<String>,
    #[serde(rename = "step")]
    pub steps: Vec<Step>,
}

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
    /// The status the author expects; recording stops when the target answers another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// `var = "/pointer"` into the raw response, for later steps.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capture: BTreeMap<String, String>,
    /// Stream reasons that must arrive before the step is done.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wait: Vec<String>,
    /// The data may not have what this step needs (a list was empty): skip it
    /// then, instead of stopping the recording.
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

/// What `record` writes and `replay` reads (`recordings/<name>.json`).
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

impl Scenario {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let scenario: Self = toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        scenario.check().with_context(|| format!("in {}", path.display()))?;
        Ok(scenario)
    }

    fn check(&self) -> anyhow::Result<()> {
        let mut names = std::collections::BTreeSet::new();
        for step in &self.steps {
            if !names.insert(step.name.as_str()) {
                bail!("step name used twice: {}", step.name);
            }
            step.check().with_context(|| format!("step {}", step.name))?;
            if self.read_only && !step.only_reads() {
                bail!("step {}: a read_only scenario holds only GET and HEAD requests", step.name);
            }
        }
        Ok(())
    }
}

impl Step {
    fn check(&self) -> anyhow::Result<()> {
        let kinds = [self.request.is_some(), self.open.is_some(), self.close.is_some(), self.join.is_some()];
        if kinds.iter().filter(|k| **k).count() != 1 {
            bail!("needs exactly one of request, open, close, join");
        }
        if let Some(request) = &self.request {
            self.method_and_path().with_context(|| format!("request {request:?}"))?;
        }
        // The status sits where the answer is recorded.
        if (self.request.is_some() && !self.detach || self.join.is_some()) && self.status.is_none() {
            bail!("a request states the status it expects");
        }
        if self.detach && (self.request.is_none() || self.status.is_some()) {
            bail!("detach goes on a request, and the join step states the status");
        }
        let bodies = [self.body.is_some(), self.json.is_some(), self.text.is_some(), self.base64.is_some()];
        if bodies.iter().filter(|b| **b).count() > 1 {
            bail!("at most one of body, json, text, base64");
        }
        if let Some(encoded) = &self.base64 {
            crate::vars::base64_decode(encoded).context("base64")?;
        }
        Ok(())
    }

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

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_scenario() {
        let scenario: Scenario = toml::from_str(
            r#"
            about = "pages"
            [[step]]
            name = "open"
            open = "main"
            query = { topics = "pages:*" }
            [[step]]
            name = "create"
            request = "POST /api/pages"
            body = { title = "Notes", tags = ["a"] }
            status = 200
            capture = { page = "/json/page/id" }
            wait = ["pages:change"]
            "#,
        )
        .expect("parses");
        scenario.check().expect("valid");
        assert_eq!(scenario.steps[1].method_and_path().expect("request"), ("POST", "/api/pages"));
        assert_eq!(scenario.steps[1].body, Some(serde_json::json!({"title": "Notes", "tags": ["a"]})));
    }

    #[test]
    fn rejects_a_request_without_status_and_duplicate_names() {
        let no_status: Scenario =
            toml::from_str("about = \"x\"\n[[step]]\nname = \"a\"\nrequest = \"GET /health\"\n").expect("parses");
        assert!(no_status.check().is_err());
        let twice: Scenario = toml::from_str(
            "about = \"x\"\n[[step]]\nname = \"a\"\nclose = \"s\"\n[[step]]\nname = \"a\"\nclose = \"s\"\n",
        )
        .expect("parses");
        assert!(twice.check().is_err());
    }

    #[test]
    fn a_read_only_scenario_holds_only_reads() {
        let text = |method: &str| {
            format!(
                "about = \"x\"\nread_only = true\n[[step]]\nname = \"s\"\nopen = \"main\"\n[[step]]\nname = \"a\"\nrequest = \"{method} /workers/w/message\"\nstatus = 200\n"
            )
        };
        let reads: Scenario = toml::from_str(&text("GET")).expect("parses");
        assert!(reads.check().is_ok());
        for method in ["POST", "PUT", "DELETE", "PATCH"] {
            let writes: Scenario = toml::from_str(&text(method)).expect("parses");
            assert!(writes.check().is_err(), "{method}");
        }
    }

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
