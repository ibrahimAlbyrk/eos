//! Permission modes: what each lets through by kind of tool, and how a worker's
//! mode is found.

use eos_contracts::builtin_tools::{
    FILE_EDIT_BUILTIN_TOOLS, NETWORK_BUILTIN_TOOLS, READ_BUILTIN_TOOLS, SHELL_BUILTIN_TOOLS,
};
use eos_contracts::tool_scope::is_browser_tool;
use eos_contracts::{PermissionMode, UnknownRecord};
use eos_core::Error;
use eos_core::store::WorkerRepo;
use serde_json::Value;

/// The kinds of tool a mode tells apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCategory {
    /// Edit, Write, MultiEdit, NotebookEdit.
    FileEdit,
    /// A file edit inside the plans folder: writing the plan is the planning.
    PlanFile,
    Shell,
    Read,
    /// A browser verb that only looks at a page.
    BrowserRead,
    /// A browser verb that drives a real browser.
    BrowserWrite,
    /// Any `mcp__*` tool.
    Mcp,
    Network,
    Other,
}

/// What a mode says about a kind of tool. `Ask` leaves it to the policy's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Ask,
}

/// Browser verbs that only read. Any other verb drives the page, so a verb
/// added later is a write until it is listed here.
const BROWSER_READ_VERBS: &[&str] = &["snapshot", "find", "get", "screenshot", "tabs", "show"];

/// A path's segments with `.` and `..` resolved, so `plans/../../etc` cannot
/// pass a prefix check. `None` for a relative path. Links are not followed.
/// A Windows path keeps its drive as the first segment and compares without
/// case.
fn resolve_segments(path: &str) -> Option<Vec<String>> {
    let bytes = path.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    if !drive && !path.starts_with('/') {
        return None;
    }
    let mut out: Vec<String> = if drive { vec![path[..2].to_owned()] } else { Vec::new() };
    let root = out.len();
    let rest = if drive { &path[2..] } else { path };
    for segment in rest.split(|c| c == '/' || (drive && c == '\\')) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.len() > root {
                    out.pop();
                }
            }
            other => out.push(other.to_owned()),
        }
    }
    if drive {
        // JavaScript's toLowerCase, which maps beyond ASCII.
        out = out.into_iter().map(|s| s.to_lowercase()).collect();
    }
    Some(out)
}

/// Whether `child` is strictly inside `parent`. Both must be absolute.
pub fn is_path_inside(child: &str, parent: &str) -> bool {
    match (resolve_segments(child), resolve_segments(parent)) {
        (Some(c), Some(p)) => c.len() > p.len() && p.iter().zip(&c).all(|(a, b)| a == b),
        _ => false,
    }
}

/// The path a file-edit tool writes: `file_path ?? notebook_path`, when it is text.
pub(crate) fn edit_target(input: &UnknownRecord) -> Option<&str> {
    let target = input.get("file_path").filter(|v| !v.is_null()).or_else(|| input.get("notebook_path"));
    target.and_then(Value::as_str)
}

/// The kind of tool a call is. Browser verbs are checked ahead of the `mcp__`
/// rule: they ride the control servers but drive a real browser.
pub fn classify_tool(tool_name: &str, input: Option<&UnknownRecord>, plans_dir: Option<&str>) -> ToolCategory {
    if is_browser_tool(tool_name) {
        let verb = tool_name.find("browser_").map_or("", |at| &tool_name[at + "browser_".len()..]);
        return if BROWSER_READ_VERBS.contains(&verb) { ToolCategory::BrowserRead } else { ToolCategory::BrowserWrite };
    }
    if tool_name.starts_with("mcp__") {
        return ToolCategory::Mcp;
    }
    if FILE_EDIT_BUILTIN_TOOLS.contains(&tool_name) {
        // An empty plans folder is "not set", as in JavaScript.
        let in_plans = plans_dir
            .filter(|dir| !dir.is_empty())
            .zip(input)
            .is_some_and(|(dir, input)| edit_target(input).is_some_and(|target| is_path_inside(target, dir)));
        return if in_plans { ToolCategory::PlanFile } else { ToolCategory::FileEdit };
    }
    if SHELL_BUILTIN_TOOLS.contains(&tool_name) {
        ToolCategory::Shell
    } else if READ_BUILTIN_TOOLS.contains(&tool_name) {
        ToolCategory::Read
    } else if NETWORK_BUILTIN_TOOLS.contains(&tool_name) {
        ToolCategory::Network
    } else {
        ToolCategory::Other
    }
}

/// A mode's verdict. Reads, MCP tools and the plan file pass in every mode.
/// `acceptEdits` also lets file edits and browser reads through and leaves
/// the shell, the network, browser actions and everything else to the
/// policy's default; `bypassPermissions` ("Full access") lets everything through.
pub fn mode_verdict(mode: PermissionMode, category: ToolCategory) -> Verdict {
    use ToolCategory::{BrowserRead, FileEdit, Mcp, PlanFile, Read};
    match mode {
        PermissionMode::BypassPermissions => Verdict::Allow,
        PermissionMode::AcceptEdits => match category {
            Mcp | Read | PlanFile | BrowserRead | FileEdit => Verdict::Allow,
            _ => Verdict::Ask,
        },
    }
}

/// A stored mode name; `None` for anything else, the retired `default` and
/// `plan` included.
pub fn parse_mode(name: &str) -> Option<PermissionMode> {
    match name {
        "acceptEdits" => Some(PermissionMode::AcceptEdits),
        "bypassPermissions" => Some(PermissionMode::BypassPermissions),
        _ => None,
    }
}

/// The mode in force for a worker and the tool scope it was started with.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerPermissions {
    pub mode: PermissionMode,
    pub scope: Option<eos_contracts::ToolScope>,
}

/// A stored tool scope; `None` (no restriction) when it is not a scope object.
fn parse_scope(raw: &str) -> Option<eos_contracts::ToolScope> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value.is_object().then(|| serde_json::from_value(value).ok()).flatten()
}

/// Reads a worker's permissions now. The mode is its own, else the nearest
/// ancestor's, else full access (also for a worker that is not stored); the
/// scope is its own only, and one that does not parse restricts nothing.
pub fn worker_permissions(workers: &dyn WorkerRepo, worker_id: &str) -> Result<WorkerPermissions, Error> {
    let mut permissions = WorkerPermissions { mode: PermissionMode::BypassPermissions, scope: None };
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = Some(worker_id.to_owned());
    while let Some(id) = cursor.take() {
        if seen.contains(&id) {
            break;
        }
        let Some(worker) = workers.find(&id)? else { break };
        if seen.is_empty() {
            permissions.scope = worker.tool_scope.as_deref().and_then(parse_scope);
        }
        if let Some(mode) = worker.permission_mode.as_deref().and_then(parse_mode) {
            permissions.mode = mode;
            break;
        }
        seen.push(id);
        cursor = worker.parent_id.filter(|parent| !parent.is_empty());
    }
    Ok(permissions)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn record(value: serde_json::Value) -> UnknownRecord {
        serde_json::from_value(value).expect("an object")
    }

    #[test]
    fn tools_by_kind() {
        assert_eq!(classify_tool("Edit", None, None), ToolCategory::FileEdit);
        assert_eq!(classify_tool("KillShell", None, None), ToolCategory::Shell);
        assert_eq!(classify_tool("LS", None, None), ToolCategory::Read);
        assert_eq!(classify_tool("WebSearch", None, None), ToolCategory::Network);
        assert_eq!(classify_tool("Task", None, None), ToolCategory::Other);
        assert_eq!(classify_tool("mcp__github__x", None, None), ToolCategory::Mcp);
        assert_eq!(classify_tool("mcp__worker__browser_snapshot", None, None), ToolCategory::BrowserRead);
        assert_eq!(classify_tool("mcp__orchestrator__browser_navigate", None, None), ToolCategory::BrowserWrite);
        assert_eq!(classify_tool("mcp__gateway__browser_snapshot", None, None), ToolCategory::Mcp);
    }

    #[test]
    fn an_edit_inside_the_plans_folder_is_the_plan_file() {
        let plans = Some("/home/u/.claude/plans");
        let inside = record(json!({"file_path": "/home/u/.claude/plans/a.md"}));
        let escaped = record(json!({"file_path": "/home/u/.claude/plans/../../x"}));
        let notebook = record(json!({"notebook_path": "/home/u/.claude/plans/n.ipynb"}));
        assert_eq!(classify_tool("Write", Some(&inside), plans), ToolCategory::PlanFile);
        assert_eq!(classify_tool("Write", Some(&escaped), plans), ToolCategory::FileEdit);
        assert_eq!(classify_tool("NotebookEdit", Some(&notebook), plans), ToolCategory::PlanFile);
        assert_eq!(classify_tool("Write", Some(&inside), None), ToolCategory::FileEdit);
        assert_eq!(classify_tool("Read", Some(&inside), plans), ToolCategory::Read);
    }

    #[test]
    fn inside_means_strictly_below_with_dots_resolved() {
        assert!(is_path_inside("/a/b/c", "/a/b"));
        assert!(!is_path_inside("/a/b", "/a/b"));
        assert!(!is_path_inside("/a/bc", "/a/b"));
        assert!(is_path_inside("/a/./b//c", "/a/b/"));
        assert!(!is_path_inside("a/b/c", "/a/b"));
        assert!(is_path_inside("C:\\Users\\Me\\plans\\x.md", "c:/users/me/plans"));
        assert!(!is_path_inside("C:\\Users\\Me\\plans\\..\\x.md", "c:/users/me/plans"));
        assert!(!is_path_inside("/../../a", "/a"));
    }

    #[test]
    fn what_each_mode_lets_through() {
        use PermissionMode::{AcceptEdits, BypassPermissions};
        use ToolCategory::{BrowserRead, BrowserWrite, FileEdit, Mcp, Network, Other, PlanFile, Read, Shell};
        for category in [Mcp, Read, PlanFile, BrowserRead, FileEdit] {
            assert_eq!(mode_verdict(AcceptEdits, category), Verdict::Allow);
        }
        for category in [Shell, Network, BrowserWrite, Other] {
            assert_eq!(mode_verdict(AcceptEdits, category), Verdict::Ask);
            assert_eq!(mode_verdict(BypassPermissions, category), Verdict::Allow);
        }
    }
}
