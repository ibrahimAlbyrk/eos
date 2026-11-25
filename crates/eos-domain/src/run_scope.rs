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
    /// Reads an App a run built and gives its verdict (05 Q7).
    AppReviewer,
}

/// The worker definitions the Forge's sessions start as, by role. Only a
/// built-in routine's agent may name one.
pub const FORGE_DEFINITIONS: [(&str, RunRole); 3] = [
    ("forge-researcher", RunRole::ForgeResearcher),
    ("forge-builder", RunRole::ForgeBuilder),
    ("forge-reviewer", RunRole::ForgeReviewer),
];

impl RunRole {
    /// The Forge role a session of the worker definition `name` has.
    pub fn of_forge_definition(name: &str) -> Option<(&'static str, RunRole)> {
        FORGE_DEFINITIONS.into_iter().find(|(definition, _)| *definition == name)
    }

    /// The role a `routine_sessions` row stores; `None` for any other word,
    /// the architect's included (it is no run session).
    pub fn of_routine_session(word: &str) -> Option<RunRole> {
        match word {
            "solo" => Some(RunRole::Solo),
            "lead" => Some(RunRole::Lead),
            "script" => Some(RunRole::Script),
            "specialist" => Some(RunRole::Specialist),
            "checker" => Some(RunRole::Checker),
            "app_reviewer" => Some(RunRole::AppReviewer),
            _ => None,
        }
    }
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
/// `def_scope` is the agent's own definition, as it is baked onto a worker:
/// it narrows the scope and never widens it. Its denials join; of the tools
/// the run allows, only those its allow list covers stay, a tool it names
/// with a command only for that command; and an edit must
/// match its `editRegex` as well as stay in the folder. `edit_folder` is the
/// folder file edits stay in: the run's worktree, or the Forge builder's
/// scratch folder.
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
        // Both reviewers only read what they judge.
        RunRole::ForgeReviewer | RunRole::AppReviewer => &[READ_BUILTIN_TOOLS],
    };
    let mut allow: Vec<String> = groups.iter().flat_map(|group| group.iter()).map(|tool| (*tool).to_owned()).collect();
    let mut deny: Vec<String> = SHELL_DENIED.iter().map(|pattern| (*pattern).to_owned()).collect();
    let folder = format!("{}/", regex_escaped(edit_folder.trim_end_matches('/')));
    let mut edit_regex = match role {
        // The folder's sandbox settings hold the builder's shell: its own
        // edits never reach them.
        RunRole::ForgeBuilder => format!(r"^{folder}(?!\.claude/)"),
        _ => format!("^{folder}"),
    };
    if let Some(def) = def_scope {
        if !def.allow.is_empty() {
            allow = allow.iter().flat_map(|tool| kept(&def.allow, tool)).collect();
        }
        for pattern in &def.deny {
            if !deny.contains(pattern) {
                deny.push(pattern.clone());
            }
        }
        if let Some(both) = def.edit_regex.as_deref().and_then(|pattern| in_folder(&folder, pattern)) {
            edit_regex = both;
        }
    }
    if allow.is_empty() {
        // An empty allow list restricts nothing.
        deny.push("*".to_owned());
    }
    ToolScope { allow, deny, edit_regex: Some(edit_regex) }
}

/// A regex for the paths in `folder` (escaped, with its closing `/`) that
/// also match a definition's `pattern`, searched for anywhere in the path as
/// the policy searches it. The folder is a lookahead, so it adds no group and
/// the pattern's backreferences keep their numbers. `None` for an empty
/// pattern and for one that is not a regex, which the policy ignores: the
/// folder alone then bounds edits, where an ignored whole would bound none.
/// For that, a pattern with a character beyond the BMP is left out too: the
/// policy reads it as JavaScript does, two code units, and may then find it
/// is not a regex (`(?<a𝑥>a)`) where this check finds one.
fn in_folder(folder: &str, pattern: &str) -> Option<String> {
    if pattern.is_empty() || pattern.chars().any(|c| u32::from(c) > 0xFFFF) {
        return None;
    }
    let both = format!(r"^(?={folder})[\s\S]*?(?:{pattern})");
    regress::Regex::new(&both).is_ok().then_some(both)
}

/// What of the run's `tool` a definition's allow list keeps: the tool, when a
/// pattern covers its name; else the tool for the commands of each pattern
/// scoped to a command whose name part covers it (`Bash(npm test:*)`),
/// written with the tool's own name so it reaches no tool the run leaves out;
/// else nothing.
fn kept(patterns: &[String], tool: &str) -> Vec<String> {
    if patterns.iter().any(|pattern| covers(pattern, tool)) {
        return vec![tool.to_owned()];
    }
    patterns
        .iter()
        .filter_map(|pattern| command_scoped(pattern))
        .filter(|(name, _)| covers(name, tool))
        .map(|(_, command)| format!("{tool}({command})"))
        .collect()
}

/// `Name(command)`: the first `(` splits the name from the command's spec.
fn command_scoped(pattern: &str) -> Option<(&str, &str)> {
    let open = pattern.find('(').filter(|at| *at > 0)?;
    Some((&pattern[..open], pattern[open + 1..].strip_suffix(')')?))
}

/// Whether an allow pattern covers the tool `name` by its name alone, as the
/// policy's tool patterns match a call that carries no command (that matcher
/// sits in `eos-policy`, above this crate): `*` is any run of characters, and
/// a pattern scoped to a command (`Bash(npm test:*)`) covers no name.
fn covers(pattern: &str, name: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if command_scoped(pattern).is_some() {
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
