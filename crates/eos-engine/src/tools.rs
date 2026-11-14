//! Eos's own tools as the engine's: one adapter per tool, shared by every
//! session, so sessions with equal tool sets share one serialized tool list.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, PoisonError};

use eos_agent_core::{BoxFuture, Tool, ToolContext, ToolOutput, ToolSpec};
use eos_agent_sdk::HostTool as EngineTool;
use eos_agent_types::ContentBlock;
use eos_core::agent::{HostTool, ToolCaller, ToolReply};
use futures_util::FutureExt;
use serde_json::Value;
use serde_json::value::RawValue;

/// The session an agent belongs to, in the extensions of the session's
/// agent and of every subagent below it.
pub(crate) struct EosSession {
    pub(crate) worker_id: Arc<str>,
}

struct Adapter {
    tool: Arc<dyn HostTool>,
    spec: ToolSpec,
}

fn output(reply: ToolReply) -> ToolOutput {
    if reply.images.is_empty() {
        return if reply.is_error { ToolOutput::error(reply.text) } else { ToolOutput::text(reply.text) };
    }
    let mut blocks = Vec::with_capacity(reply.images.len() + 1);
    if !reply.text.is_empty() {
        blocks.push(ContentBlock::Text { text: reply.text, citations: None });
    }
    for image in reply.images {
        let block = serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": image.media_type, "data": image.data},
        });
        if let Ok(raw) = RawValue::from_string(block.to_string()) {
            blocks.push(ContentBlock::Unknown(raw));
        }
    }
    let mut out = ToolOutput::blocks(blocks);
    out.is_error = reply.is_error;
    out
}

impl Tool for Adapter {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn call<'a>(&'a self, input: &'a RawValue, ctx: ToolContext<'a>) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let session = ctx.extensions.get::<EosSession>();
            let worker_id = session.as_ref().map_or(ctx.agent_id, |s| &s.worker_id);
            let caller = ToolCaller {
                worker_id,
                call_id: ctx.tool_use_id,
                subagent_id: (ctx.agent_id != worker_id).then_some(ctx.agent_id),
            };
            let input: Value = serde_json::from_str(input.get()).unwrap_or(Value::Null);
            // A tool that panics fails its call, never the agent.
            let call = AssertUnwindSafe(self.tool.call(caller, input)).catch_unwind();
            tokio::select! {
                reply = call => match reply {
                    Ok(reply) => output(reply),
                    Err(_) => {
                        tracing::error!(tool = self.spec.name(), worker_id, "a tool panicked");
                        ToolOutput::error("The tool failed unexpectedly.")
                    }
                },
                () = ctx.cancel.cancelled() => ToolOutput::error("Interrupted by user"),
            }
        })
    }
}

/// The adapters made so far, by the tool they wrap.
#[derive(Default)]
pub(crate) struct Adapters(Mutex<HashMap<usize, EngineTool>>);

impl Adapters {
    /// The engine's form of `tools`; the same `Arc` always gets the same adapter.
    pub(crate) fn engine_tools(&self, tools: Vec<Arc<dyn HostTool>>) -> Vec<EngineTool> {
        let mut made = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        tools
            .into_iter()
            .map(|tool| {
                // The adapter keeps its tool alive, so the address stays its own.
                let key = Arc::as_ptr(&tool).cast::<()>() as usize;
                made.entry(key).or_insert_with(|| adapt(tool)).clone()
            })
            .collect()
    }
}

fn adapt(tool: Arc<dyn HostTool>) -> EngineTool {
    let def = tool.definition();
    let mut spec = ToolSpec::new(&def.name, &def.description, def.input_schema.clone());
    if def.deferred {
        spec = spec.deferred();
    }
    if let Some(hint) = &def.search_hint {
        spec = spec.with_search_hint(hint);
    }
    let main_agent_only = def.main_agent_only;
    let adapted = EngineTool::new(Arc::new(Adapter { tool, spec }));
    if main_agent_only { adapted.main_agent_only() } else { adapted }
}
