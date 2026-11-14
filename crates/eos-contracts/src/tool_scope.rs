//! Which tools are Eos's control plane and which built-ins have no surface in
//! Eos.

use crate::builtin_tools::names;

/// MCP servers whose tools change orchestration state: only the main agent
/// loop may call them, never a subagent.
pub const EOS_BUILTIN_MCP_SERVERS: &[&str] = &["orchestrator", "worker", "gateway"];

pub fn is_eos_control_tool(tool_name: &str) -> bool {
    EOS_BUILTIN_MCP_SERVERS.iter().any(|server| {
        tool_name.strip_prefix("mcp__").and_then(|r| r.strip_prefix(server)).is_some_and(|r| r.starts_with("__"))
    })
}

/// The `browser_*` verbs sit on the control servers but drive a real browser,
/// so a worker definition's tool scope can fence them off.
pub fn is_browser_tool(tool_name: &str) -> bool {
    ["mcp__worker__browser_", "mcp__orchestrator__browser_"].iter().any(|p| tool_name.starts_with(p))
}

pub const BLOCKED_BUILTIN_TOOLS: &[&str] = &["AskUserQuestion", "Workflow"];

pub fn blocked_builtin_tool_message(tool_name: &str) -> String {
    match tool_name {
        "AskUserQuestion" => "AskUserQuestion is disabled in Eos — its native menu has no answer surface here. \
             Orchestrator: ask the operator via mcp__orchestrator__ask_user. \
             Worker: proceed on your best judgment or report `needs input: <ask>` to your parent."
            .to_owned(),
        "Workflow" => "The built-in Workflow tool is disabled in Eos.".to_owned(),
        other => format!("{other} is disabled in Eos."),
    }
}

pub fn is_blocked_builtin_tool(tool_name: &str) -> bool {
    BLOCKED_BUILTIN_TOOLS.contains(&tool_name)
}

/// Removed for orchestrators only: they spawn real workers, never Task
/// subagents. Workers keep Task, so this stays apart from the blocked set.
pub const ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS: &[&str] = &[names::TASK];

pub fn disallowed_builtin_tools_for(is_orchestrator: bool) -> Vec<&'static str> {
    let mut out = BLOCKED_BUILTIN_TOOLS.to_vec();
    if is_orchestrator {
        out.extend_from_slice(ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_and_browser_tools() {
        assert!(is_eos_control_tool("mcp__orchestrator__spawn_worker"));
        assert!(is_eos_control_tool("mcp__gateway__x"));
        assert!(!is_eos_control_tool("mcp__orchestratorx__spawn"));
        assert!(!is_eos_control_tool("Bash"));
        assert!(is_browser_tool("mcp__worker__browser_click"));
        assert!(!is_browser_tool("mcp__gateway__browser_click"));
    }

    #[test]
    fn disallowed_sets_by_role() {
        assert_eq!(disallowed_builtin_tools_for(false), ["AskUserQuestion", "Workflow"]);
        assert_eq!(disallowed_builtin_tools_for(true), ["AskUserQuestion", "Workflow", "Task"]);
        assert_eq!(blocked_builtin_tool_message("Foo"), "Foo is disabled in Eos.");
    }
}
