//! One tool: what the model is told about it, and the call path every tool
//! shares — check the input, run the handler, word the result.

use std::sync::Arc;

use eos_core::agent::{HostTool, Refused, ToolCaller, ToolDefinition, ToolReply};
use eos_core::{BoxFuture, Error};
use eos_runtime::http::ApiError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::schema::{Schema, issues_text};

/// A tool as the registry lists it.
pub(crate) struct Spec {
    /// The bare name (`read_page`); a session sees it behind its server's prefix.
    pub(crate) name: &'static str,
    /// The input, an object.
    pub(crate) input: Schema,
    /// Sent with every request even where tool search is on.
    pub(crate) always_load: bool,
    /// More words tool search finds the tool by.
    pub(crate) search_hint: Option<&'static str>,
    /// The built-in plugin it belongs to: left out of sessions started while
    /// that plugin is off.
    pub(crate) plugin: Option<&'static str>,
    pub(crate) handler: Arc<dyn Handler>,
}

impl Spec {
    pub(crate) fn new(name: &'static str, input: Schema, handler: impl Handler) -> Self {
        Self { name, input, always_load: false, search_hint: None, plugin: None, handler: Arc::new(handler) }
    }

    pub(crate) fn always_load(mut self) -> Self {
        self.always_load = true;
        self
    }

    pub(crate) fn search_hint(mut self, hint: &'static str) -> Self {
        self.search_hint = Some(hint);
        self
    }

    pub(crate) fn plugin(mut self, plugin: &'static str) -> Self {
        self.plugin = Some(plugin);
        self
    }
}

/// Who calls.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Call<'a> {
    /// The session's worker: the agent the tool acts for.
    pub(crate) self_id: &'a str,
}

/// What a handler hands back: text as it is, a value as indented JSON.
pub(crate) enum Output {
    Text(String),
    Json(Value),
}

impl Output {
    pub(crate) fn text(text: impl Into<String>) -> Self {
        Output::Text(text.into())
    }

    /// A value as the model reads it (`JSON.stringify(value, null, 2)`).
    pub(crate) fn json<T: Serialize>(value: &T) -> Self {
        Output::Json(serde_json::to_value(value).unwrap_or(Value::Null))
    }
}

/// A failed call: the text the model reads as the tool's error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure(pub(crate) String);

impl Failure {
    /// A refusal as agents have always read it: the status and the body of
    /// the route behind the tool.
    pub(crate) fn refused(status: u16, message: &str) -> Self {
        Failure(format!("daemon {status}: {}", json!({"error": message})))
    }
}

impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        let e = ApiError::from(e);
        Failure::refused(e.status(), &e.to_string())
    }
}

impl From<Refused> for Failure {
    fn from(e: Refused) -> Self {
        Failure::refused(e.status, &e.message)
    }
}

pub(crate) type Outcome = Result<Output, Failure>;

/// A tool's behaviour. `args` passed the tool's schema: defaults are filled
/// and unknown keys are gone.
pub(crate) trait Handler: Send + Sync + 'static {
    fn run<'a>(&'a self, call: Call<'a>, args: Value) -> BoxFuture<'a, Outcome>;
}

/// The checked input as the handler's own type.
pub(crate) fn args<T: DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|e| Failure(format!("invalid input: {e}")))
}

/// A registry entry bound to one server's name and its description: what a
/// session is handed.
pub(crate) struct Bound {
    definition: ToolDefinition,
    bare: &'static str,
    input: Schema,
    handler: Arc<dyn Handler>,
}

impl Bound {
    pub(crate) fn new(server: &str, spec: &Spec, description: String) -> Self {
        Self {
            definition: ToolDefinition {
                name: format!("mcp__{server}__{}", spec.name),
                description,
                input_schema: spec.input.input_schema(),
                deferred: !spec.always_load,
                search_hint: spec.search_hint.map(str::to_owned),
                // A subagent may not call Eos's tools (the permission gate
                // refuses each call), so it is not offered them.
                main_agent_only: true,
            },
            bare: spec.name,
            input: spec.input.clone(),
            handler: spec.handler.clone(),
        }
    }
}

impl HostTool for Bound {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn call<'a>(&'a self, caller: ToolCaller<'a>, input: Value) -> BoxFuture<'a, ToolReply> {
        Box::pin(async move {
            let args = match self.input.parse(&input) {
                Ok(args) => args,
                Err(issues) => {
                    return ToolReply::error(format!(
                        "MCP error -32602: Input validation error: Invalid arguments for tool {}: {}",
                        self.bare,
                        issues_text(&issues)
                    ));
                }
            };
            match self.handler.run(Call { self_id: caller.worker_id }, args).await {
                Ok(Output::Text(text)) => ToolReply::text(text),
                Ok(Output::Json(value)) => {
                    ToolReply::text(serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_owned()))
                }
                Err(Failure(text)) => ToolReply::error(text),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reads_as_the_route_behind_the_tool_answered() {
        assert_eq!(
            Failure::from(Error::not_found("page", "pg-1")).0,
            r#"daemon 404: {"error":"page not found: pg-1"}"#
        );
        assert_eq!(
            Failure::from(Refused::new(409, "worker is archived — restore first")).0,
            r#"daemon 409: {"error":"worker is archived — restore first"}"#
        );
    }
}
