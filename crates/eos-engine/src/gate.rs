//! Every tool call of every agent is decided by Eos's policy.
//!
//! A subagent's call is decided in the mode its chain declares (each link's
//! definition `permissionMode` and the Agent call's `mode`), resolved by the
//! engine's rule ([`resolve_chain`]) from the worker's mode and mapped onto
//! Eos's, never wider than the worker's:
//!
//! | resolved by the engine | Eos decides it in                         |
//! |------------------------|-------------------------------------------|
//! | `plan`                 | plan: looks only, changes are denied      |
//! | `dontAsk`              | dontAsk: what would be asked is denied    |
//! | `default`              | default: reads pass, file edits are asked |
//! | `acceptEdits`          | accept edits                              |
//! | `auto`                 | accept edits (Eos has no classifier)      |
//! | `bypassPermissions`    | full access                               |
//! | `bubble`               | default (the rule never returns it)       |
//!
//! The worker's accept edits is the engine's `acceptEdits` and full access
//! its `bypassPermissions`; only under full access may a chain reach
//! `bypassPermissions`. Both are fixed modes in the engine's rule, so right
//! under a worker a subagent's definition never counts, only an Agent call's
//! `mode` that narrows (`plan`, `default`, `dontAsk`; `acceptEdits` under
//! full access). A definition counts one link further down, under a
//! subagent that runs in `default` or `dontAsk`.

use std::sync::Arc;

use eos_agent_core::{
    BoxFuture, DeclaredMode, Permission, PermissionGate, PermissionMode as EngineMode, ToolCall as EngineCall,
    resolve_chain,
};
use eos_agent_sdk::ReadOnly;
use eos_contracts::{ExternalDecision, UnknownRecord};
use eos_core::policy::{AgentMode, PolicyDecider, SubagentModes, ToolCall};
use eos_platform::DataPaths;
use serde_json::value::RawValue;

use crate::database_guard;
use crate::registry::Registry;

pub(crate) struct EosGate {
    pub(crate) policy: Arc<dyn PolicyDecider>,
    pub(crate) sessions: Arc<Registry>,
    /// The data folder whose database files no tool opens.
    pub(crate) data: Option<DataPaths>,
}

/// An engine mode as Eos decides calls in it (the table above).
fn eos_mode(mode: EngineMode) -> AgentMode {
    match mode {
        EngineMode::Plan => AgentMode::Plan,
        EngineMode::DontAsk => AgentMode::DontAsk,
        EngineMode::Default | EngineMode::Bubble => AgentMode::Default,
        EngineMode::AcceptEdits | EngineMode::Auto => AgentMode::AcceptEdits,
        EngineMode::BypassPermissions => AgentMode::FullAccess,
    }
}

/// The modes a chain resolves to under a worker in accept edits and in full
/// access; `None` when it declares nothing (the worker's mode).
fn chain_modes(chain: &[DeclaredMode], looks_only: bool) -> Option<SubagentModes> {
    if chain.iter().all(DeclaredMode::is_empty) {
        return None;
    }
    let accept_edits = eos_mode(resolve_chain(EngineMode::AcceptEdits, chain, false));
    let full_access = eos_mode(resolve_chain(EngineMode::BypassPermissions, chain, true));
    Some(SubagentModes { accept_edits, full_access, looks_only })
}

impl PermissionGate for EosGate {
    fn decide<'a>(&'a self, call: EngineCall<'a>) -> BoxFuture<'a, Permission> {
        Box::pin(async move {
            if let Some(refusal) = self.data.as_ref().and_then(|data| database_guard::refusal(data, &call)) {
                return Permission::Deny(refusal);
            }
            // The session is the tree's top-level agent; a subagent's call
            // names itself, so the policy can keep Eos's control tools from it.
            let worker_id = call.root_id().to_owned();
            let input: UnknownRecord = serde_json::from_str(call.input.get()).unwrap_or_default();
            let subagent = match call.origin {
                Some(origin) if !origin.modes.iter().all(DeclaredMode::is_empty) => {
                    // What a plan-mode agent may still do is the engine's read-only rule.
                    let looks_only = matches!(ReadOnly.decide(call.clone()).await, Permission::Allow);
                    chain_modes(&origin.modes, looks_only)
                }
                _ => None,
            };
            let ask = ToolCall {
                full_surface: self.sessions.is_focused(&worker_id),
                worker_id,
                tool_name: call.name.to_owned(),
                input,
                tool_use_id: Some(call.id.to_owned()),
                agent_id: call.origin.map(|_| call.agent_id.to_owned()),
                writes_outside: call.writes_outside(),
                subagent,
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

    // Subagents' declared modes are resolved here, against the worker's.
    fn applies_agent_modes(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::PermissionMode::{AcceptEdits as Edits, BypassPermissions as Full};

    use super::*;
    use AgentMode::{AcceptEdits, Default, DontAsk, FullAccess, Plan};

    const MODES: [&str; 7] = ["plan", "default", "dontAsk", "acceptEdits", "auto", "bypassPermissions", "bubble"];

    fn link(definition: Option<&str>, spawn: Option<&str>) -> DeclaredMode {
        DeclaredMode {
            agent_type: Arc::from("t"),
            definition: definition.and_then(EngineMode::parse),
            spawn: spawn.and_then(EngineMode::parse),
        }
    }

    /// The mode under a worker in accept edits and in full access.
    fn under(chain: &[DeclaredMode]) -> (AgentMode, AgentMode) {
        match chain_modes(chain, false) {
            Some(modes) => (modes.under(Edits), modes.under(Full)),
            None => (AcceptEdits, FullAccess),
        }
    }

    #[test]
    fn an_agent_calls_mode_only_narrows() {
        let rows = [
            ("plan", (Plan, Plan)),
            ("default", (Default, Default)),
            ("dontAsk", (DontAsk, DontAsk)),
            ("acceptEdits", (AcceptEdits, AcceptEdits)),
            ("auto", (AcceptEdits, AcceptEdits)),
            ("bypassPermissions", (AcceptEdits, FullAccess)),
            ("bubble", (AcceptEdits, FullAccess)),
        ];
        for (mode, expected) in rows {
            assert_eq!(under(&[link(None, Some(mode))]), expected, "call mode {mode}");
        }
    }

    #[test]
    fn a_definitions_mode_does_not_count_right_under_the_worker() {
        for mode in MODES {
            assert_eq!(under(&[link(Some(mode), None)]), (AcceptEdits, FullAccess), "definition {mode}");
        }
        assert_eq!(under(&[link(None, None)]), (AcceptEdits, FullAccess));
    }

    #[test]
    fn a_definition_counts_under_a_subagent_in_default() {
        let rows = [
            ("plan", (Plan, Plan)),
            ("default", (Default, Default)),
            ("dontAsk", (DontAsk, DontAsk)),
            ("acceptEdits", (AcceptEdits, AcceptEdits)),
            ("auto", (AcceptEdits, AcceptEdits)),
            // Full access only under a worker in full access.
            ("bypassPermissions", (Default, FullAccess)),
            ("bubble", (Default, Default)),
        ];
        for (mode, expected) in rows {
            let chain = [link(None, Some("default")), link(Some(mode), None)];
            assert_eq!(under(&chain), expected, "definition {mode} under default");
        }
    }

    #[test]
    fn a_subagent_never_runs_wider_than_its_worker() {
        for a in MODES {
            for b in MODES {
                for c in MODES {
                    let chain = [link(Some(a), Some(b)), link(Some(c), Some(a)), link(Some(b), Some(c))];
                    let (edits, _) = under(&chain);
                    assert!(edits <= AcceptEdits, "{a} {b} {c}");
                }
            }
        }
    }

    #[test]
    fn plan_holds_for_every_agent_below_it() {
        let chain = [link(None, Some("plan")), link(Some("bypassPermissions"), Some("acceptEdits"))];
        assert_eq!(under(&chain), (Plan, Plan));
    }
}
