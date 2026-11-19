//! The decision for one tool call (`PolicyGatewayService.evaluate`).
//!
//! The rungs, first to answer wins:
//! 1. a built-in with no surface in Eos (`AskUserQuestion`, `Workflow`) is
//!    denied, unless the session is a focused one;
//! 2. a subagent may not call Eos's control tools, nor `call_capability`;
//! 3. the worker definition's tool scope may deny (deny list, allow list,
//!    `editRegex` on file edits) and never allows — Eos's control tools are
//!    outside it, except the browser verbs;
//! 4. a subagent in plan mode may only look: a call that would change
//!    something is denied;
//! 5. a `policy.yaml` rule that matches the call decides;
//! 6. the call's mode (the worker's, or a subagent's narrower one) allows by
//!    kind of tool (a file edit that writes outside the working directories
//!    is a kind of its own; a capability action goes by its class, and one
//!    that speaks for the user or cannot be taken back asks in every mode);
//! 7. the policy's default.
//!
//! Rungs 1–4 sit above the user's rules so neither a broad allow nor full
//! access can undo them. In dontAsk mode (a subagent's), what rungs 5–7
//! leave to the user is denied instead.

use eos_contracts::tool_scope::{
    CALL_CAPABILITY_TOOL, blocked_builtin_tool_message, is_artifact_tool, is_blocked_builtin_tool, is_browser_tool,
    is_eos_control_tool,
};
use eos_contracts::{ActionClass, AllowVariant, Decision, DenyVariant, ToolScope, UnknownRecord};
use eos_core::capability::ActionError;
use eos_core::policy::AgentMode;
use serde_json::Value;

use crate::glob::matches_any;
use crate::js::JsRegex;
use crate::mode::{ToolCategory, Verdict, classify_tool, edit_target, mode_verdict};
use crate::rule::{Policy, default_decision, evaluate_policy_from};

/// What a decision is made from, besides the policy.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    pub tool_name: &'a str,
    pub input: &'a UnknownRecord,
    /// The subagent making the call, if one is.
    pub agent_id: Option<&'a str>,
    /// A focused session.
    pub full_surface: bool,
    /// The mode the call is decided in: the worker's, or a subagent's
    /// narrower one.
    pub mode: AgentMode,
    /// The call only looks (decides it in plan mode); the engine says so.
    pub looks_only: bool,
    /// The tool scope the worker was started with.
    pub scope: Option<&'a ToolScope>,
    /// The plans folder (`~/.claude/plans`): edits inside it pass in every mode.
    pub plans_dir: Option<&'a str>,
    /// The call writes outside the agent's working directories.
    pub writes_outside: bool,
    /// For `call_capability`: the class of the action it calls; `None` when
    /// there is no such action.
    pub capability_class: Option<ActionClass>,
}

fn deny(message: String) -> Decision {
    Decision::Deny(DenyVariant { message })
}

/// The tool scope's verdict: a denial, or nothing.
fn scope_denial(call: &Call<'_>, scope: &ToolScope) -> Option<String> {
    let tool = call.tool_name;
    // A command-scoped pattern (`Bash(git push:*)`) matches against the command.
    let command = call.input.get("command").and_then(Value::as_str);
    if matches_any(tool, &scope.deny, command) {
        return Some(format!("{tool} is denied by this worker's definition"));
    }
    if !scope.allow.is_empty() && !matches_any(tool, &scope.allow, command) {
        return Some(format!("{tool} is not in this worker definition's allowed tools"));
    }
    // `editRegex` confines file edits to matching paths. A pattern that is not
    // a regex is ignored rather than refusing every edit over a typo.
    let edit_regex = scope.edit_regex.as_deref().filter(|pattern| !pattern.is_empty());
    if let Some(re) = edit_regex.and_then(|pattern| JsRegex::new(pattern).ok())
        && classify_tool(tool, Some(call.input), call.plans_dir) == ToolCategory::FileEdit
        && !edit_target(call.input).is_some_and(|target| re.test(target))
    {
        return Some("edit target is outside this worker definition's allowed paths".to_owned());
    }
    None
}

/// Decides one call. `Ask` means the user must answer.
pub fn evaluate(policy: &Policy, call: &Call<'_>) -> Decision {
    let tool = call.tool_name;
    if !call.full_surface && is_blocked_builtin_tool(tool) {
        return deny(blocked_builtin_tool_message(tool));
    }
    if call.agent_id.is_some_and(|id| !id.is_empty()) && (is_eos_control_tool(tool) || tool == CALL_CAPABILITY_TOOL) {
        return deny(format!(
            "{tool} is main-agent only — subagents cannot use Eos control tools. Return your findings; the main agent acts on them."
        ));
    }
    if call.agent_id.is_some_and(|id| !id.is_empty()) && is_artifact_tool(tool) {
        return deny(format!(
            "{tool} is main-agent only — subagents cannot publish or change artifacts. Return the content; the main agent publishes it."
        ));
    }
    if let Some(scope) = call.scope
        && (!is_eos_control_tool(tool) || is_browser_tool(tool))
        && let Some(message) = scope_denial(call, scope)
    {
        return deny(message);
    }
    if call.mode == AgentMode::Plan && !call.looks_only {
        return deny(format!(
            "Permission denied: this agent runs in plan mode, so it may read and research but not change anything ({tool} was not run)."
        ));
    }
    let decision = decide(policy, call);
    if call.mode == AgentMode::DontAsk && matches!(decision, Decision::Ask) {
        return deny(format!(
            "Permission denied: this agent runs in dontAsk mode, so {tool} — which needs approval — was not run."
        ));
    }
    decision
}

/// Rungs 5–7.
fn decide(policy: &Policy, call: &Call<'_>) -> Decision {
    let tool = call.tool_name;
    // The rules are walked once: none before the first match decides anything.
    if let Some(first) = policy.first_rule_for(tool, call.input) {
        return evaluate_policy_from(policy, first, tool, call.input);
    }
    let category = match classify_tool(tool, Some(call.input), call.plans_dir) {
        ToolCategory::FileEdit if call.writes_outside => ToolCategory::FileEditOutside,
        _ if tool == CALL_CAPABILITY_TOOL => match call.capability_class {
            Some(class) => ToolCategory::Capability(class),
            // Nothing to call: the tool would answer the same.
            None => return deny(ActionError::NotFound.to_string()),
        },
        category => category,
    };
    match mode_verdict(call.mode, category) {
        Verdict::Allow => Decision::Allow(AllowVariant { updated_input: Some(call.input.clone()), message: None }),
        // No rule matches: the default decides.
        Verdict::Ask => default_decision(policy, call.input),
        // The policy's default is no rule: the user answers.
        Verdict::Confirm => Decision::Ask,
    }
}

#[cfg(test)]
mod walked_once {
    use eos_contracts::PolicyBehavior;
    use serde_json::json;

    use super::*;
    use crate::rule::{compile_rule, evaluate_policy};

    #[test]
    fn the_rules_walked_once_decide_as_the_rules_walked_twice() {
        let rules = json!([
            {"tool": "Bash", "command": "^git ", "action": "permit"},
            {"tool": "Bash", "command": "rm", "action": "deny", "reason": "no"},
            {"tool": "Bash", "command": "^git push", "action": "ask"},
            {"tool": ["Bash", "Read"], "command": "^ls", "action": "rewrite", "rewriteFrom": "^ls", "rewriteTo": "ls -a"},
            {"tool": "Write", "action": "allow"},
        ]);
        let calls: Vec<(&str, UnknownRecord)> = [
            ("Bash", json!({"command": "git status"})),
            ("Bash", json!({"command": "git push origin"})),
            ("Bash", json!({"command": "rm -rf x"})),
            ("Bash", json!({"command": "ls"})),
            ("Bash", json!({"command": "echo"})),
            ("Read", json!({"file_path": "/x", "command": "ls"})),
            ("Read", json!({"file_path": "/x"})),
            ("Write", json!({"file_path": "/x"})),
            ("WebFetch", json!({})),
        ]
        .into_iter()
        .map(|(tool, input)| (tool, serde_json::from_value(input).expect("an object")))
        .collect();
        let compiled: Vec<_> = rules
            .as_array()
            .expect("a list")
            .iter()
            .enumerate()
            .filter_map(|(i, rule)| compile_rule(rule, i, "<test>", &mut |_| {}))
            .collect();
        for default in [PolicyBehavior::Allow, PolicyBehavior::Deny, PolicyBehavior::Ask] {
            for rules in [Vec::new(), compiled.clone()] {
                let policy = Policy { default, ttl_ms: 0, rules };
                let modes = [
                    AgentMode::Plan,
                    AgentMode::DontAsk,
                    AgentMode::Default,
                    AgentMode::AcceptEdits,
                    AgentMode::FullAccess,
                ];
                for (mode, writes_outside) in modes.into_iter().flat_map(|m| [(m, false), (m, true)]) {
                    for (tool, input) in &calls {
                        let call = Call {
                            tool_name: tool,
                            input,
                            agent_id: None,
                            full_surface: false,
                            mode,
                            looks_only: false,
                            scope: None,
                            plans_dir: None,
                            writes_outside,
                            capability_class: None,
                        };
                        let twice = if policy.has_rule_for(tool, input) {
                            evaluate_policy(&policy, tool, input)
                        } else {
                            let category = match classify_tool(tool, Some(input), None) {
                                ToolCategory::FileEdit if writes_outside => ToolCategory::FileEditOutside,
                                category => category,
                            };
                            match mode_verdict(mode, category) {
                                Verdict::Allow => {
                                    Decision::Allow(AllowVariant { updated_input: Some(input.clone()), message: None })
                                }
                                Verdict::Ask => evaluate_policy(&policy, tool, input),
                                Verdict::Confirm => Decision::Ask,
                            }
                        };
                        assert_eq!(decide(&policy, &call), twice, "{tool} {input:?} {mode:?} {default:?}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use eos_core::policy::PolicyDocument;
    use serde_json::{Value, json};

    use super::*;
    use crate::load::load_policy;
    use eos_contracts::PermissionMode;

    fn policy(document: Value) -> Policy {
        load_policy(PolicyDocument::Parsed { source: "test".into(), value: document }, 0)
    }

    fn decide(
        policy: &Policy,
        mode: impl Into<AgentMode>,
        tool: &str,
        path: &str,
        writes_outside: bool,
    ) -> &'static str {
        let input: UnknownRecord = serde_json::from_value(json!({ "file_path": path })).expect("an object");
        let call = Call {
            tool_name: tool,
            input: &input,
            agent_id: None,
            full_surface: false,
            mode: mode.into(),
            looks_only: false,
            scope: None,
            plans_dir: Some("/home/u/.claude/plans"),
            writes_outside,
            capability_class: None,
        };
        match evaluate(policy, &call) {
            Decision::Allow(_) => "allow",
            Decision::Deny(_) => "deny",
            Decision::Ask => "ask",
        }
    }

    #[test]
    fn accept_edits_leaves_a_write_outside_the_working_directories_to_the_policy() {
        use PermissionMode::{AcceptEdits, BypassPermissions};
        let asks = policy(json!({"default": "ask", "rules": []}));
        let denies = policy(json!({"default": "deny", "rules": []}));
        for tool in ["Edit", "Write", "NotebookEdit"] {
            assert_eq!(decide(&asks, AcceptEdits, tool, "/work/a.txt", false), "allow", "{tool} inside");
            assert_eq!(decide(&asks, AcceptEdits, tool, "/elsewhere/a.txt", true), "ask", "{tool} outside");
            assert_eq!(decide(&denies, AcceptEdits, tool, "/elsewhere/a.txt", true), "deny", "{tool} outside");
            assert_eq!(decide(&asks, BypassPermissions, tool, "/elsewhere/a.txt", true), "allow", "{tool} outside");
            assert_eq!(decide(&denies, BypassPermissions, tool, "/elsewhere/a.txt", true), "allow");
        }
        // The plan file passes in every mode, wherever the plans folder is.
        assert_eq!(decide(&asks, AcceptEdits, "Write", "/home/u/.claude/plans/p.md", true), "allow");
    }

    #[test]
    fn a_rule_decides_a_write_outside_by_its_absolute_path() {
        let rules = policy(json!({"default": "ask", "rules": [
            {"tool": "Write", "file_path": "^/elsewhere/ok/", "action": "allow"},
            {"tool": "Edit", "file_path": "/secret/", "action": "deny", "reason": "no"},
            {"tool": "Edit", "action": "allow"},
        ]}));
        let mode = PermissionMode::AcceptEdits;
        assert_eq!(decide(&rules, mode, "Write", "/elsewhere/ok/a.txt", true), "allow");
        assert_eq!(decide(&rules, mode, "Write", "/elsewhere/other/a.txt", true), "ask");
        // An "always allow" rule for the tool allows its writes anywhere.
        assert_eq!(decide(&rules, mode, "Edit", "/elsewhere/a.txt", true), "allow");
        assert_eq!(decide(&rules, PermissionMode::BypassPermissions, "Edit", "/work/secret/a.txt", false), "deny");
    }

    fn subagent(policy: &Policy, mode: AgentMode, looks_only: bool, tool: &str) -> &'static str {
        let input: UnknownRecord =
            serde_json::from_value(json!({ "file_path": "/work/a.txt", "command": "ls" })).expect("an object");
        let call = Call {
            tool_name: tool,
            input: &input,
            agent_id: Some("a1"),
            full_surface: false,
            mode,
            looks_only,
            scope: None,
            plans_dir: Some("/home/u/.claude/plans"),
            writes_outside: false,
            capability_class: None,
        };
        match evaluate(policy, &call) {
            Decision::Allow(_) => "allow",
            Decision::Deny(_) => "deny",
            Decision::Ask => "ask",
        }
    }

    #[test]
    fn plan_denies_what_changes_above_the_users_rules() {
        let allows = policy(json!({"default": "allow", "rules": [{"tool": "Write", "action": "allow"}]}));
        assert_eq!(subagent(&allows, AgentMode::Plan, false, "Write"), "deny");
        assert_eq!(subagent(&allows, AgentMode::Plan, false, "Bash"), "deny");
        assert_eq!(subagent(&allows, AgentMode::Plan, true, "Read"), "allow");
        // A read-only command still goes by the policy, as in default mode.
        let asks = policy(json!({"default": "ask", "rules": []}));
        assert_eq!(subagent(&asks, AgentMode::Plan, true, "Bash"), "ask");
    }

    #[test]
    fn dont_ask_denies_what_would_be_asked() {
        let asks = policy(json!({"default": "ask", "rules": [
            {"tool": "Bash", "action": "allow"},
            {"tool": "WebFetch", "action": "ask"},
        ]}));
        assert_eq!(subagent(&asks, AgentMode::DontAsk, false, "Edit"), "deny");
        assert_eq!(subagent(&asks, AgentMode::DontAsk, false, "WebFetch"), "deny");
        assert_eq!(subagent(&asks, AgentMode::DontAsk, false, "Bash"), "allow", "a pre-approved tool runs");
        assert_eq!(subagent(&asks, AgentMode::DontAsk, true, "Read"), "allow");
    }

    fn capability_call(
        policy: &Policy,
        mode: AgentMode,
        agent_id: Option<&str>,
        class: Option<ActionClass>,
    ) -> &'static str {
        let input: UnknownRecord =
            serde_json::from_value(json!({"capability": "github", "action": "post_review", "input": {}}))
                .expect("an object");
        let call = Call {
            tool_name: CALL_CAPABILITY_TOOL,
            input: &input,
            agent_id,
            full_surface: false,
            mode,
            looks_only: false,
            scope: None,
            plans_dir: None,
            writes_outside: false,
            capability_class: class,
        };
        match evaluate(policy, &call) {
            Decision::Allow(_) => "allow",
            Decision::Deny(_) => "deny",
            Decision::Ask => "ask",
        }
    }

    /// The bundled policy's shape: everything allowed by default, rules for
    /// Claude's own tools, none naming `call_capability`.
    fn bundled() -> Policy {
        policy(json!({"default": "allow", "ttlMs": 30000, "rules": [
            {"tool": "Bash", "command": "^\\s*rm\\s+-[rRf]+\\s+/(\\s|$)", "action": "deny", "reason": "rm -rf / blocked"},
            {"tool": "Bash", "action": "allow"},
            {"tool": "Read", "action": "allow"},
            {"tool": "Write", "action": "allow"},
            {"tool": "Edit", "action": "allow"},
        ]}))
    }

    #[test]
    fn a_capability_action_goes_by_its_class_in_each_mode() {
        use ActionClass::{Irreversible, Read, Speak, TellUser, WriteLocal};
        let asks = policy(json!({"default": "ask", "rules": []}));
        let cases = [
            (AgentMode::FullAccess, ["allow", "allow", "allow", "ask", "ask"]),
            (AgentMode::AcceptEdits, ["allow", "allow", "ask", "ask", "ask"]),
        ];
        for (mode, expected) in cases {
            for (class, want) in [Read, WriteLocal, TellUser, Speak, Irreversible].into_iter().zip(expected) {
                assert_eq!(capability_call(&asks, mode, None, Some(class)), want, "{class:?} in {mode:?}");
            }
        }
        // The default stands in only for what the mode leaves to it.
        let allows = policy(json!({"default": "allow", "rules": []}));
        assert_eq!(capability_call(&allows, AgentMode::AcceptEdits, None, Some(TellUser)), "allow");
        let denies = policy(json!({"default": "deny", "rules": []}));
        assert_eq!(capability_call(&denies, AgentMode::AcceptEdits, None, Some(TellUser)), "deny");
        assert_eq!(capability_call(&denies, AgentMode::AcceptEdits, None, Some(Speak)), "ask");
    }

    #[test]
    fn a_subagent_never_calls_a_capability() {
        let allows = policy(json!({"default": "allow", "rules": [{"tool": "call_capability", "action": "allow"}]}));
        for mode in
            [AgentMode::Plan, AgentMode::DontAsk, AgentMode::Default, AgentMode::AcceptEdits, AgentMode::FullAccess]
        {
            for class in [ActionClass::Read, ActionClass::Irreversible] {
                assert_eq!(capability_call(&allows, mode, Some("a1"), Some(class)), "deny", "{class:?} in {mode:?}");
            }
        }
    }

    #[test]
    fn a_rule_on_call_capability_decides_before_the_class() {
        let allow = policy(json!({"default": "ask", "rules": [{"tool": "call_capability", "action": "allow"}]}));
        let deny = policy(
            json!({"default": "allow", "rules": [{"tool": "call_capability", "action": "deny", "reason": "no"}]}),
        );
        for mode in [AgentMode::AcceptEdits, AgentMode::FullAccess] {
            for class in [ActionClass::Speak, ActionClass::Irreversible] {
                assert_eq!(capability_call(&allow, mode, None, Some(class)), "allow", "{class:?} in {mode:?}");
            }
            assert_eq!(capability_call(&deny, mode, None, Some(ActionClass::Read)), "deny");
        }
    }

    #[test]
    fn the_bundled_policy_still_asks_before_speaking_or_what_cannot_be_undone() {
        let bundled = bundled();
        for mode in [AgentMode::AcceptEdits, AgentMode::FullAccess] {
            assert_eq!(capability_call(&bundled, mode, None, Some(ActionClass::Speak)), "ask", "{mode:?}");
            assert_eq!(capability_call(&bundled, mode, None, Some(ActionClass::Irreversible)), "ask", "{mode:?}");
            assert_eq!(capability_call(&bundled, mode, None, Some(ActionClass::TellUser)), "allow", "{mode:?}");
        }
    }

    #[test]
    fn a_call_of_no_such_action_is_refused_in_the_tools_words() {
        let allows = policy(json!({"default": "allow", "rules": []}));
        let input: UnknownRecord = serde_json::from_value(json!({"capability": "nope"})).expect("an object");
        let call = Call {
            tool_name: CALL_CAPABILITY_TOOL,
            input: &input,
            agent_id: None,
            full_surface: false,
            mode: AgentMode::FullAccess,
            looks_only: false,
            scope: None,
            plans_dir: None,
            writes_outside: false,
            capability_class: None,
        };
        assert_eq!(evaluate(&allows, &call), deny(ActionError::NotFound.to_string()));
    }

    #[test]
    fn default_asks_for_file_edits() {
        let asks = policy(json!({"default": "ask", "rules": []}));
        assert_eq!(subagent(&asks, AgentMode::Default, false, "Edit"), "ask");
        assert_eq!(subagent(&asks, AgentMode::Default, true, "Read"), "allow");
        assert_eq!(subagent(&asks, AgentMode::AcceptEdits, false, "Edit"), "allow");
        assert_eq!(subagent(&asks, AgentMode::FullAccess, false, "Bash"), "allow");
    }
}
