//! One request to a model outside any conversation: a summary, a title, a
//! verdict. No tools, nothing recorded.

use std::time::Duration;

use serde_json::Value;

use crate::BoxFuture;

/// What to ask. Only the prompt is required.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OneShotRequest {
    /// A model id or alias; the adapter's default when `None`.
    pub model: Option<String>,
    pub system: Option<String>,
    pub prompt: String,
    /// JSON Schema of the answer: the model then answers with data that
    /// matches it ([`OneShotAnswer::structured`]) instead of text.
    pub schema: Option<Value>,
    pub effort: Option<String>,
    /// The request fails with [`OneShotError::TimedOut`] after this long.
    pub timeout: Option<Duration>,
}

impl OneShotRequest {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self { prompt: prompt.into(), ..Self::default() }
    }

    pub fn model(mut self, model: Option<&str>) -> Self {
        self.model = model.filter(|m| !m.is_empty()).map(str::to_owned);
        self
    }

    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn schema(mut self, schema: Value) -> Self {
        self.schema = Some(schema);
        self
    }

    pub fn effort(mut self, effort: Option<&str>) -> Self {
        self.effort = effort.filter(|e| !e.is_empty()).map(str::to_owned);
        self
    }

    pub fn timeout_ms(mut self, ms: i64) -> Self {
        self.timeout = u64::try_from(ms).ok().filter(|ms| *ms > 0).map(Duration::from_millis);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OneShotAnswer {
    /// The answer's text (empty for a structured answer).
    pub text: String,
    /// With a schema: the data the model answered with.
    pub structured: Option<Value>,
}

/// Why no answer came back.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OneShotError {
    /// Nothing to run the request on: no sign-in, no key.
    #[error("no Claude credential")]
    NoCredential,
    #[error("timed out after {}s", .0.as_secs_f64().round())]
    TimedOut(Duration),
    /// The request was made and failed; the text is the provider's.
    #[error("{0}")]
    Failed(String),
}

/// The model, asked once. Dropping the future cancels the request.
pub trait OneShot: Send + Sync + 'static {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>>;
}
