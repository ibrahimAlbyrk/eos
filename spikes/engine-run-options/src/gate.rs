//! A permission gate that allows every call and keeps what it saw of each
//! Workflow call. Optionally it stands in for the run policy RT-23 falls back
//! to: a Workflow call whose `scriptPath` lies in a folder the gate trusts is
//! allowed with the script read by the gate, inline, and the same `args`
//! (`Permission::AllowWith`, which Eos's gate returns for a rewritten input).

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use eos_agent_core::{BoxFuture, Permission, PermissionGate, ToolCall};
use serde_json::value::RawValue;
use serde_json::{Value, json};

/// What the gate saw of one Workflow call.
#[derive(Debug, Clone)]
pub struct SeenCall {
    /// The input as the model wrote it.
    pub input: Value,
    /// The input the tool asks the gate to review (`Tool::review`).
    pub review: Option<Value>,
}

#[derive(Debug, Default)]
pub struct RecordingGate {
    /// Workflow scripts in this folder are read here and passed inline.
    pub inline_from: Option<PathBuf>,
    seen: Mutex<Vec<SeenCall>>,
}

impl RecordingGate {
    pub fn inlining_from(folder: PathBuf) -> Self {
        Self { inline_from: Some(folder), ..Self::default() }
    }

    pub fn workflow_calls(&self) -> Vec<SeenCall> {
        self.seen.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// `{script, args}` for a call whose `scriptPath` lies in `inline_from`.
    fn inline(&self, input: &Value) -> Option<Box<RawValue>> {
        let folder = self.inline_from.as_ref()?;
        let path = PathBuf::from(input["scriptPath"].as_str()?);
        if !path.starts_with(folder) {
            return None;
        }
        // RT-23's hash check of the kept version goes here.
        let script = std::fs::read_to_string(&path).ok()?;
        let mut swapped = json!({ "script": script });
        if let Some(args) = input.get("args") {
            swapped["args"] = args.clone();
        }
        RawValue::from_string(swapped.to_string()).ok()
    }
}

impl PermissionGate for RecordingGate {
    fn decide<'a>(&'a self, call: ToolCall<'a>) -> BoxFuture<'a, Permission> {
        Box::pin(async move {
            if call.name != "Workflow" {
                return Permission::Allow;
            }
            let input: Value = serde_json::from_str(call.input.get()).unwrap_or_default();
            let review = call.review.and_then(|r| serde_json::from_str(r.input.get()).ok());
            let swapped = self.inline(&input);
            self.seen.lock().unwrap_or_else(PoisonError::into_inner).push(SeenCall { input, review });
            match swapped {
                Some(inline) => Permission::AllowWith(inline.into()),
                None => Permission::Allow,
            }
        })
    }
}
