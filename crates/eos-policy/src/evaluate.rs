//! The decision for one tool call (`PolicyGatewayService.evaluate`).
//!
//! The rungs, first to answer wins:
//! 1. a built-in with no surface in Eos (`AskUserQuestion`, `Workflow`) is
//!    denied, unless the session is a focused one;
//! 2. a subagent may not call Eos's control tools;
//! 3. the worker definition's tool scope may deny (deny list, allow list,
//!    `editRegex` on file edits) and never allows — Eos's control tools are
//!    outside it, except the browser verbs;
//! 4. a `policy.yaml` rule that matches the call decides;
//! 5. the worker's permission mode allows by kind of tool (a file edit that
//!    writes outside the working directories is a kind of its own);
//! 6. the policy's default.
//!
//! Rungs 1–3 sit above the user's rules so neither a broad allow nor full
//! access can undo them.

use eos_contracts::tool_scope::{
    blocked_builtin_tool_message, is_blocked_builtin_tool, is_browser_tool, is_eos_control_tool,
};
use eos_contracts::{AllowVariant, Decision, DenyVariant, PermissionMode, ToolScope, UnknownRecord};
use serde_json::Value;

use crate::glob::matches_any;
use crate::js::JsRegex;
use crate::mode::{ToolCategory, Verdict, classify_tool, edit_target, mode_verdict};
use crate::rule::{Policy, evaluate_policy};

/// What a decision is made from, besides the policy.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    pub tool_name: &'a str,
    pub input: &'a UnknownRecord,
    /// The subagent making the call, if one is.
    pub agent_id: Option<&'a str>,
    /// A focused session.
    pub full_surface: bool,
    /// The mode in force for the worker.
    pub mode: PermissionMode,
    /// The tool scope the worker was started with.
    pub scope: Option<&'a ToolScope>,
    /// The plans folder (`~/.claude/plans`): edits inside it pass in every mode.
    pub plans_dir: Option<&'a str>,
    /// The call writes outside the agent's working directories.
    pub writes_outside: bool,
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
    if call.agent_id.is_some_and(|id| !id.is_empty()) && is_eos_control_tool(tool) {
        return deny(format!(
            "{tool} is main-agent only — subagents cannot use Eos control tools. Return your findings; the main agent acts on them."
        ));
    }
    if let Some(scope) = call.scope
        && (!is_eos_control_tool(tool) || is_browser_tool(tool))
        && let Some(message) = scope_denial(call, scope)
    {
        return deny(message);
    }
    if policy.has_rule_for(tool, call.input) {
        return evaluate_policy(policy, tool, call.input);
    }
    let category = match classify_tool(tool, Some(call.input), call.plans_dir) {
        ToolCategory::FileEdit if call.writes_outside => ToolCategory::FileEditOutside,
        category => category,
    };
    match mode_verdict(call.mode, category) {
        Verdict::Allow => Decision::Allow(AllowVariant { updated_input: Some(call.input.clone()), message: None }),
        Verdict::Ask => evaluate_policy(policy, tool, call.input),
    }
}

#[cfg(test)]
mod tests {
    use eos_core::policy::PolicyDocument;
    use serde_json::{Value, json};

    use super::*;
    use crate::load::load_policy;

    fn policy(document: Value) -> Policy {
        load_policy(PolicyDocument::Parsed { source: "test".into(), value: document }, 0)
    }

    fn decide(policy: &Policy, mode: PermissionMode, tool: &str, path: &str, writes_outside: bool) -> &'static str {
        let input: UnknownRecord = serde_json::from_value(json!({ "file_path": path })).expect("an object");
        let call = Call {
            tool_name: tool,
            input: &input,
            agent_id: None,
            full_surface: false,
            mode,
            scope: None,
            plans_dir: Some("/home/u/.claude/plans"),
            writes_outside,
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
}
