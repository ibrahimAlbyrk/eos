//! Every tool call of every agent is decided by Eos's policy.

use std::sync::Arc;

use eos_agent_core::{BoxFuture, Permission, PermissionGate, ToolCall as EngineCall};
use eos_contracts::{ExternalDecision, UnknownRecord};
use eos_core::policy::{PolicyDecider, ToolCall};
use serde_json::value::RawValue;

use crate::registry::Registry;

pub(crate) struct EosGate {
    pub(crate) policy: Arc<dyn PolicyDecider>,
    pub(crate) sessions: Arc<Registry>,
}

impl PermissionGate for EosGate {
    fn decide<'a>(&'a self, call: EngineCall<'a>) -> BoxFuture<'a, Permission> {
        Box::pin(async move {
            // The session is the tree's top-level agent; a subagent's call
            // names itself, so the policy can keep Eos's control tools from it.
            let worker_id = call.root_id().to_owned();
            let input: UnknownRecord = serde_json::from_str(call.input.get()).unwrap_or_default();
            let ask = ToolCall {
                full_surface: self.sessions.is_focused(&worker_id),
                worker_id,
                tool_name: call.name.to_owned(),
                input,
                tool_use_id: Some(call.id.to_owned()),
                agent_id: call.origin.map(|_| call.agent_id.to_owned()),
            };
            match self.policy.decide(ask).await {
                Ok(ExternalDecision::Allow(allow)) => {
                    match allow.updated_input.and_then(|i| serde_json::to_string(&i).ok()) {
                        // The input a rewrite rule or the user changed; the same input runs as it is.
                        Some(json) if json != call.input.get() => match RawValue::from_string(json) {
                            Ok(input) => Permission::AllowWith(Arc::from(input)),
                            Err(_) => Permission::Allow,
                        },
                        _ => Permission::Allow,
                    }
                }
                Ok(ExternalDecision::Deny(deny)) => Permission::Deny(deny.message),
                Err(e) => Permission::Deny(format!("the permission check failed: {e}")),
            }
        })
    }

    // Eos's policy is the only authority: a sandbox never lets a command past it.
    fn lets_sandboxed_commands_through(&self) -> bool {
        false
    }
}
