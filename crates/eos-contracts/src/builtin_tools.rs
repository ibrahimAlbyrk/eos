//! The names of the built-in tools and their permission categories.
//!
//! A built-in's name is the join key of the whole policy stack (classification,
//! permission-mode categories, worker-definition allow/deny, `editRegex`), so a
//! misspelt one is a silent capability escape. Every layer takes the name from
//! here.

pub mod names {
    pub const READ: &str = "Read";
    pub const WRITE: &str = "Write";
    pub const EDIT: &str = "Edit";
    pub const MULTI_EDIT: &str = "MultiEdit";
    pub const NOTEBOOK_EDIT: &str = "NotebookEdit";
    pub const BASH: &str = "Bash";
    pub const BASH_OUTPUT: &str = "BashOutput";
    // The binary has shipped both spellings; both are shell tools.
    pub const KILL_SHELL: &str = "KillShell";
    pub const KILL_BASH: &str = "KillBash";
    pub const GLOB: &str = "Glob";
    pub const GREP: &str = "Grep";
    pub const LS: &str = "LS";
    pub const WEB_FETCH: &str = "WebFetch";
    pub const WEB_SEARCH: &str = "WebSearch";
    pub const TODO_WRITE: &str = "TodoWrite";
    pub const TASK: &str = "Task";
    pub const EXIT_PLAN_MODE: &str = "ExitPlanMode";
    pub const SKILL: &str = "Skill";
}

pub const FILE_EDIT_BUILTIN_TOOLS: &[&str] = &[names::EDIT, names::WRITE, names::MULTI_EDIT, names::NOTEBOOK_EDIT];
pub const SHELL_BUILTIN_TOOLS: &[&str] = &[names::BASH, names::BASH_OUTPUT, names::KILL_BASH, names::KILL_SHELL];
pub const READ_BUILTIN_TOOLS: &[&str] = &[names::READ, names::GLOB, names::GREP, names::LS];
pub const NETWORK_BUILTIN_TOOLS: &[&str] = &[names::WEB_FETCH, names::WEB_SEARCH];
