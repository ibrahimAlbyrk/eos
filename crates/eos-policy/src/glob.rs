//! Tool patterns of a worker definition's tool scope.
//!
//! - A name glob: `Bash` (exact), `mcp__github__*` (`*` is any run), `*` (all).
//!   Matched against the tool's name only.
//! - Command-scoped, `Bash(git push:*)`: the name glob before the first `(`
//!   and a spec for the call's command. `<prefix>:*` is the prefix alone or
//!   followed by a space (`git push:*` covers `git push origin`, not
//!   `git pushx`); a spec with `*` is a glob; anything else is exact.
//!
//! Not the matching of `policy.yaml` rules, which is exact names plus regexes.

use std::sync::LazyLock;

use crate::js::{self, JsRegex};

/// `"^" + glob.split("*").map(escape).join(".*") + "$"`, tested as JavaScript
/// tests it (`.` stops at a line break).
fn glob_matches(glob: &str, text: &str) -> bool {
    let mut pattern = String::with_capacity(glob.len() + 8);
    pattern.push('^');
    for (i, part) in glob.split('*').enumerate() {
        if i > 0 {
            pattern.push_str(".*");
        }
        for c in part.chars() {
            if ".*+?^${}()|[]\\".contains(c) {
                pattern.push('\\');
            }
            pattern.push(c);
        }
    }
    pattern.push('$');
    JsRegex::new(&pattern).is_ok_and(|re| re.test(text))
}

fn match_name(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return name == pattern;
    }
    glob_matches(pattern, name)
}

fn match_command(arg: &str, inner: &str) -> bool {
    if inner == "*" {
        return true;
    }
    if let Some(prefix) = inner.strip_suffix(":*") {
        return arg == prefix || arg.strip_prefix(prefix).is_some_and(|rest| rest.starts_with(' '));
    }
    if inner.contains('*') {
        return glob_matches(inner, arg);
    }
    arg == inner
}

/// `Name(inner)`: the first `(` splits the name from the spec.
static COMMAND_SCOPED: LazyLock<Option<JsRegex>> = LazyLock::new(|| JsRegex::new(r"^(.+?)\((.*)\)$").ok());

fn command_scoped(pattern: &str) -> Option<(String, String)> {
    let m = COMMAND_SCOPED.as_ref()?.exec(pattern)?;
    let group = |i: usize| m.groups.get(i).cloned().flatten().map(|units| String::from_utf16_lossy(&units));
    Some((group(0)?, group(1)?))
}

/// Whether `pattern` covers a call of the tool `name`. `argument` is the
/// call's command, when it has one: a command-scoped pattern never matches a
/// call without it.
pub fn matches_tool_pattern(name: &str, pattern: &str, argument: Option<&str>) -> bool {
    if pattern == "*" {
        return true;
    }
    match command_scoped(pattern) {
        Some((name_part, inner)) => {
            match_name(name, &name_part) && argument.is_some_and(|arg| match_command(js::trim(arg), &inner))
        }
        None => match_name(name, pattern),
    }
}

pub fn matches_any(name: &str, patterns: &[String], argument: Option<&str>) -> bool {
    patterns.iter().any(|pattern| matches_tool_pattern(name, pattern, argument))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_globs() {
        assert!(matches_tool_pattern("Bash", "Bash", None));
        assert!(!matches_tool_pattern("BashOutput", "Bash", None));
        assert!(matches_tool_pattern("mcp__github__create_pr", "mcp__*", None));
        assert!(matches_tool_pattern("mcp__github__create_pr", "mcp__*__create_*", None));
        assert!(!matches_tool_pattern("Read", "mcp__*", None));
        assert!(matches_tool_pattern("anything", "*", None));
        assert!(!matches_tool_pattern("a.b", "a?b*", None), "only * is special");
    }

    #[test]
    fn command_scoped_patterns() {
        let push = "Bash(git push:*)";
        assert!(matches_tool_pattern("Bash", push, Some("git push origin main")));
        assert!(matches_tool_pattern("Bash", push, Some("  git push  ")));
        assert!(!matches_tool_pattern("Bash", push, Some("git pushx")));
        assert!(!matches_tool_pattern("Bash", push, Some("git status")));
        assert!(!matches_tool_pattern("Bash", push, None), "no command, no match");
        assert!(!matches_tool_pattern("Read", push, Some("git push")));
        assert!(matches_tool_pattern("Bash", "Bash(npm run *)", Some("npm run build")));
        assert!(matches_tool_pattern("Bash", "Bash(ls)", Some("ls")));
        assert!(!matches_tool_pattern("Bash", "Bash(ls)", Some("ls -la")));
        assert!(matches_tool_pattern("Bash", "Bash(*)", Some("anything")));
        assert!(matches_tool_pattern("BashOutput", "Bash*(x)", Some("x")));
    }
}
