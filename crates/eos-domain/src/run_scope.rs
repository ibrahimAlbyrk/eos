//! The tool scope Eos sets on every run worker at spawn. Its allow list is
//! explicit, so an MCP tool, an Artifact tool, a browser verb or a tool Eos
//! does not know is never allowed in a run; its deny list holds what an
//! allowed tool may still not do. The policy applies the scope above
//! `policy.yaml` and the mode, and it only ever denies.
//!
//! Which built-ins a run gets follows the class each one counts as: the read
//! tools are class `read`, the file edits class `write_local`, held to the
//! run's folder by `editRegex`. The shell and the web have no class of their
//! own and every run keeps them, by the user's choice: a run that reads
//! outside text can run a pull request's tests, and every run may search and
//! fetch the web. Capability actions reach a run through the capability
//! tools, whose grant holds them to `read` and `write_local`.

use eos_contracts::ToolScope;
use eos_contracts::builtin_tools::{
    FILE_EDIT_BUILTIN_TOOLS, NETWORK_BUILTIN_TOOLS, READ_BUILTIN_TOOLS, SHELL_BUILTIN_TOOLS,
};

/// Pushing is a delivery and `gh` acts on GitHub as the user: both go
/// through the gate, never through a run's shell.
pub const SHELL_DENIED: [&str; 2] = ["Bash(git push:*)", "Bash(gh:*)"];

/// The role of a run's session: one of a routine run's (the architect is not
/// a run session), or one of the Forge's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunRole {
    Solo,
    Lead,
    Script,
    Specialist,
    Checker,
    ForgeResearcher,
    ForgeBuilder,
    ForgeReviewer,
}

/// Whether a run reads outside text: a pull request, a mail, a web page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Trust {
    Trusted,
    Untrusted,
}

impl Trust {
    pub const ALL: [Trust; 2] = [Trust::Trusted, Trust::Untrusted];

    pub fn as_str(self) -> &'static str {
        match self {
            Trust::Trusted => "trusted",
            Trust::Untrusted => "untrusted",
        }
    }

    /// A stored trust; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<Trust> {
        Trust::ALL.into_iter().find(|trust| trust.as_str() == text)
    }
}

/// The shell and the web a run's agents keep. The two columns are the same
/// by the user's choice; a tighter setting changes the untrusted one.
fn shell_and_web(trust: Trust) -> [&'static [&'static str]; 2] {
    match trust {
        Trust::Trusted => [SHELL_BUILTIN_TOOLS, NETWORK_BUILTIN_TOOLS],
        Trust::Untrusted => [SHELL_BUILTIN_TOOLS, NETWORK_BUILTIN_TOOLS],
    }
}

/// The scope of a run worker. `capability_tools` are the tools that reach
/// capability actions, which only a routine run's own roles get.
/// `def_scope` is the agent's own definition: its denials join, and of the
/// tools the run allows only those its allow list covers stay, so it narrows
/// the scope and never widens it; its `editRegex` is not read, as the run's
/// folder bounds every edit. `edit_folder` is the folder file edits stay in:
/// the run's worktree, or the Forge builder's scratch folder.
pub fn scope_for(
    role: RunRole,
    trust: Trust,
    capability_tools: &[&str],
    def_scope: Option<&ToolScope>,
    edit_folder: &str,
) -> ToolScope {
    let [shell, web] = shell_and_web(trust);
    let groups: &[&[&str]] = match role {
        RunRole::Solo | RunRole::Lead | RunRole::Script | RunRole::Specialist | RunRole::Checker => {
            &[READ_BUILTIN_TOOLS, FILE_EDIT_BUILTIN_TOOLS, shell, web, capability_tools]
        }
        // The Forge's researcher reads the web to find options and runs nothing.
        RunRole::ForgeResearcher => &[READ_BUILTIN_TOOLS, NETWORK_BUILTIN_TOOLS],
        // The Forge's builder works in its own folder, its shell under the engine's sandbox.
        RunRole::ForgeBuilder => &[READ_BUILTIN_TOOLS, FILE_EDIT_BUILTIN_TOOLS, SHELL_BUILTIN_TOOLS],
        RunRole::ForgeReviewer => &[READ_BUILTIN_TOOLS],
    };
    let mut allow: Vec<String> = groups.iter().flat_map(|group| group.iter()).map(|tool| (*tool).to_owned()).collect();
    let mut deny: Vec<String> = SHELL_DENIED.iter().map(|pattern| (*pattern).to_owned()).collect();
    if let Some(def) = def_scope {
        if !def.allow.is_empty() {
            allow.retain(|tool| def.allow.iter().any(|pattern| covers(pattern, tool)));
        }
        for pattern in &def.deny {
            if !deny.contains(pattern) {
                deny.push(pattern.clone());
            }
        }
    }
    if allow.is_empty() {
        // An empty allow list restricts nothing.
        deny.push("*".to_owned());
    }
    ToolScope { allow, deny, edit_regex: Some(format!("^{}/", regex_escaped(edit_folder.trim_end_matches('/')))) }
}

/// Whether an allow pattern covers the tool `name` by its name alone, as the
/// policy's tool patterns match a call that carries no command (that matcher
/// sits in `eos-policy`, above this crate): `*` is any run of characters, and
/// a pattern scoped to a command (`Bash(npm test:*)`) covers no name.
fn covers(pattern: &str, name: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern.ends_with(')') && pattern.find('(').is_some_and(|at| at > 0) {
        return false;
    }
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = name.strip_prefix(first) else { return false };
    let mut middle: Vec<&str> = parts.collect();
    let Some(last) = middle.pop() else { return rest.is_empty() };
    for part in middle {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// `text` as a JavaScript regex that matches it literally.
fn regex_escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests;
