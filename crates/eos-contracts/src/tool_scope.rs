//! Which tools are Eos's control plane and which built-ins have no surface in
//! Eos.

use crate::builtin_tools::{ARTIFACT_BUILTIN_TOOLS, names};

/// Eos's own tools besides the `browser_*` verbs. They change orchestration
/// state: only the main agent loop may call them, never a subagent.
pub const EOS_CONTROL_TOOLS: &[&str] = &[
    "spawn_worker",
    "list_active_workers",
    "get_worker",
    "kill_worker",
    "message_worker",
    "list_pending_permissions",
    "notify_user",
    "ask_user",
    "list_available_workers",
    "create_worker",
    "integrate_workers",
    "current_datetime",
    "get_worker_messages",
    "send_message_to_parent",
    "list_peers",
    "ask_peer",
    "respond_to_peer",
    "list_pages",
    "read_page",
    "create_page",
    "append_to_page",
    "edit_page",
    "set_page_task",
    "search_memory",
    "suggest_memory",
    "plugin_status",
    "plugin_preview",
    "present",
    "present_app",
    "find_places",
    "current_location",
    "send_to_machine",
    "react",
    "no_reply",
    "list_capabilities",
    "report_progress",
    "submit_result",
    "report_failure",
];

/// Calls one action of a capability. Not a control tool: the permission gate
/// decides each call by the class of the action it calls.
pub const CALL_CAPABILITY_TOOL: &str = "call_capability";

pub fn is_eos_control_tool(tool_name: &str) -> bool {
    is_browser_tool(tool_name) || EOS_CONTROL_TOOLS.contains(&tool_name)
}

/// The `browser_*` verbs are Eos's own tools too but drive a real browser,
/// so a worker definition's tool scope can fence them off.
pub fn is_browser_tool(tool_name: &str) -> bool {
    tool_name.starts_with("browser_")
}

/// The tools that put a visual answer in the chat.
pub fn is_view_tool(tool_name: &str) -> bool {
    matches!(tool_name, "present" | "present_app")
}

pub const BLOCKED_BUILTIN_TOOLS: &[&str] = &["AskUserQuestion", "Workflow"];

pub fn blocked_builtin_tool_message(tool_name: &str) -> String {
    match tool_name {
        "AskUserQuestion" => "AskUserQuestion is disabled in Eos — its native menu has no answer surface here. \
             Orchestrator: ask the operator via ask_user. \
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

/// Removed for workers only: what they make goes to their parent, and the
/// orchestrator (or a focused chat) publishes for the user.
pub const WORKER_DISALLOWED_BUILTIN_TOOLS: &[&str] = ARTIFACT_BUILTIN_TOOLS;

/// The built-ins an orchestrator or a worker is started without.
pub fn disallowed_builtin_tools_for(is_orchestrator: bool) -> Vec<&'static str> {
    let mut out = BLOCKED_BUILTIN_TOOLS.to_vec();
    out.extend_from_slice(if is_orchestrator {
        ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS
    } else {
        WORKER_DISALLOWED_BUILTIN_TOOLS
    });
    out
}

/// The Artifact tools publish as the session's user: only the main agent
/// loop calls them, never a subagent.
pub fn is_artifact_tool(tool_name: &str) -> bool {
    ARTIFACT_BUILTIN_TOOLS.contains(&tool_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_and_browser_tools() {
        assert!(is_eos_control_tool("spawn_worker"));
        assert!(is_eos_control_tool("browser_click"));
        assert!(!is_eos_control_tool("mcp__github__spawn_worker"));
        assert!(!is_eos_control_tool("Bash"));
        assert!(is_browser_tool("browser_click"));
        assert!(!is_browser_tool("mcp__github__browser_click"));
        assert!(is_view_tool("present_app"));
        assert!(!is_view_tool("mcp__slides__present"));
    }

    #[test]
    fn disallowed_sets_by_role() {
        assert_eq!(
            disallowed_builtin_tools_for(false),
            ["AskUserQuestion", "Workflow", "Artifact", "ArtifactComments", "ArtifactData"]
        );
        assert!(is_artifact_tool("ArtifactData") && !is_artifact_tool("mcp__x__Artifact"));
        assert_eq!(disallowed_builtin_tools_for(true), ["AskUserQuestion", "Workflow", "Task"]);
        assert_eq!(blocked_builtin_tool_message("Foo"), "Foo is disabled in Eos.");
    }
}
