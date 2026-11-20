//! Cues: what in a situation can bring a note back. A tool call gives its
//! tool, its command and its paths; an error gives its key; a message gives
//! the paths and commands it names and words to search by. Keys are user
//! data: stored, never logged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::note::HookKind;

/// A path cue also brings back notes about this many folders above it.
const PATH_ANCESTORS: usize = 4;
/// A message's words searched by, at most.
const QUERY_CHARS: usize = 300;
/// Shells whose input is a command line.
const SHELL_TOOLS: &[&str] = &["Bash", "bash", "shell", "Shell", "exec_command"];
/// Input fields that name a file or folder.
const PATH_FIELDS: &[&str] = &["file_path", "path", "notebook_path", "filePath"];

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Cue {
    pub kind: HookKind,
    pub key: String,
}

impl Cue {
    fn new(kind: HookKind, key: impl Into<String>) -> Self {
        Self { kind, key: key.into() }
    }
}

/// The tool runs a command line.
pub fn is_shell(tool: &str) -> bool {
    SHELL_TOOLS.contains(&tool)
}

/// The command line a shell tool's input carries.
pub fn command_of(input: &Value) -> Option<&str> {
    input.get("command").and_then(Value::as_str).or_else(|| input.get("cmd").and_then(Value::as_str))
}

/// The part of a command line that does the work: the last `&&`, `||` or
/// `;` step, its first pipe stage, without leading `VAR=value` settings.
pub fn last_step(command: &str) -> &str {
    let step = command.rsplit(['&', ';']).find(|s| !s.trim().is_empty()).unwrap_or(command);
    let step = step.rsplit("||").next().unwrap_or(step);
    let stage = step.split('|').next().unwrap_or(step).trim();
    let mut rest = stage;
    while let Some((word, after)) = rest.split_once(char::is_whitespace) {
        if word.contains('=') && !word.starts_with('-') {
            rest = after.trim_start();
        } else {
            break;
        }
    }
    rest
}

/// The words a command is known by: its program and, for programs that take
/// a subcommand (`cargo test`, `npm run lint`, `git push`), the subcommand.
pub fn command_key(command: &str) -> String {
    let mut words = last_step(command).split_whitespace().filter(|w| !w.starts_with('-'));
    let Some(head) = words.next() else { return String::new() };
    let head = head.rsplit('/').next().unwrap_or(head);
    let mut key = head.to_owned();
    let takes_sub = ["cargo", "npm", "pnpm", "yarn", "git", "go", "gh", "docker", "make", "xcodebuild", "bun", "npx"];
    if takes_sub.contains(&head)
        && let Some(sub) = words.next()
    {
        key.push(' ');
        key.push_str(sub);
        if matches!(sub, "run" | "exec")
            && let Some(script) = words.next()
        {
            key.push(' ');
            key.push_str(script);
        }
    }
    key
}

/// `path` relative to `root` when inside it, as written otherwise.
fn relative<'a>(path: &'a str, root: Option<&str>) -> &'a str {
    match root.map(|r| r.trim_end_matches('/')) {
        Some(root) if !root.is_empty() => {
            path.strip_prefix(root).and_then(|rest| rest.strip_prefix('/')).filter(|r| !r.is_empty()).unwrap_or(path)
        }
        _ => path,
    }
}

/// The path and up to four folders above it, each a path cue.
pub fn path_cues(path: &str, root: Option<&str>) -> Vec<Cue> {
    let path = relative(path.trim(), root).trim_end_matches('/');
    let mut cues = vec![Cue::new(HookKind::Path, path)];
    let mut rest = path;
    while cues.len() <= PATH_ANCESTORS {
        match rest.rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => {
                cues.push(Cue::new(HookKind::Path, parent));
                rest = parent;
            }
            _ => break,
        }
    }
    cues
}

/// The cues of one tool call: the tool, its command, its paths (relative to
/// the project's `root` when inside it).
pub fn from_tool(name: &str, input: &Value, root: Option<&str>) -> Vec<Cue> {
    let mut cues = vec![Cue::new(HookKind::Tool, name)];
    if is_shell(name)
        && let Some(command) = command_of(input)
    {
        let key = command_key(command);
        if !key.is_empty() {
            cues.push(Cue::new(HookKind::Command, key));
        }
    }
    for field in PATH_FIELDS {
        if let Some(path) = input.get(*field).and_then(Value::as_str).filter(|p| !p.trim().is_empty()) {
            cues.extend(path_cues(path, root));
        }
    }
    cues
}

/// An error's key: its first line that says something, with numbers, hex,
/// paths and quoted parts taken out, so the same error meets itself again.
pub fn error_key(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut out = String::new();
    let mut quoted: Option<char> = None;
    for word in line.split_whitespace() {
        let mut kept = String::new();
        for c in word.chars() {
            match quoted {
                Some(q) if c == q => quoted = None,
                Some(_) => {}
                None if matches!(c, '"' | '\'' | '`') => quoted = Some(c),
                None => kept.push(c),
            }
        }
        let path_like = kept.contains('/') || kept.contains('\\');
        let hex = kept.strip_prefix("0x").unwrap_or(&kept);
        let numeric = hex.chars().any(|c| c.is_ascii_digit())
            && hex.chars().all(|c| c.is_ascii_hexdigit() || !c.is_alphanumeric());
        let word: String = kept.chars().filter(|c| !c.is_ascii_digit()).collect();
        let word = word.trim_matches(|c: char| !c.is_alphanumeric());
        if path_like || numeric || word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word.to_lowercase());
    }
    out.chars().take(120).collect()
}

/// The cue of an error text.
pub fn from_error(text: &str) -> Option<Cue> {
    let key = error_key(text);
    (!key.is_empty()).then(|| Cue::new(HookKind::Error, key))
}

/// What a message offers recall: the paths and commands it names as cues,
/// and its words for search by words and meaning.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MessageCues {
    pub cues: Vec<Cue>,
    pub query: String,
}

/// A word that looks like a path: it has a `/` between names, or ends in a
/// file extension.
fn path_like(word: &str) -> bool {
    let word = word.trim_matches(|c: char| matches!(c, ',' | '.' | ':' | ';' | '(' | ')' | '"' | '\''));
    if word.contains("://") || word.len() < 3 {
        return false;
    }
    let slashed = word.contains('/') && word.split('/').filter(|p| !p.is_empty()).count() >= 2;
    let extension = word.rsplit_once('.').is_some_and(|(name, ext)| {
        !name.is_empty()
            && (1..=5).contains(&ext.len())
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
            && ext.chars().any(|c| c.is_ascii_alphabetic())
    });
    // `e.g.`, `i.e.`: abbreviations, not file names.
    let abbreviation = word.split('.').all(|piece| piece.chars().count() <= 1);
    (slashed || extension) && !abbreviation
}

/// The cues of a user's message.
pub fn from_message(text: &str, root: Option<&str>) -> MessageCues {
    let mut cues = Vec::new();
    for word in text.split_whitespace() {
        if path_like(word) {
            let word = word.trim_matches(|c: char| matches!(c, ',' | '.' | ':' | ';' | '(' | ')' | '"' | '\'' | '`'));
            cues.extend(path_cues(word, root));
        }
    }
    let mut code = text.split('`');
    code.next();
    while let Some(inside) = code.next() {
        let key = command_key(inside);
        if !key.is_empty() && !inside.contains('\n') && inside.contains(' ') {
            cues.push(Cue::new(HookKind::Command, key));
        }
        code.next();
    }
    let mut seen = std::collections::HashSet::new();
    cues.retain(|c| seen.insert(c.clone()));
    let query: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(QUERY_CHARS).collect();
    MessageCues { cues, query }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_command_is_known_by_its_program_and_subcommand() {
        assert_eq!(command_key("cargo test -p eos-domain"), "cargo test");
        assert_eq!(command_key("npm run lint -- --fix"), "npm run lint");
        assert_eq!(command_key("cd game && RUST_LOG=1 git push origin main"), "git push");
        assert_eq!(command_key("/usr/bin/python3 x.py | head"), "python3");
        assert_eq!(command_key("make || echo failed"), "echo");
        assert_eq!(command_key("  "), "");
    }

    #[test]
    fn a_tool_call_gives_its_tool_command_and_paths() {
        let cues = from_tool("Bash", &json!({"command": "pnpm test --filter ui"}), None);
        assert_eq!(cues, vec![Cue::new(HookKind::Tool, "Bash"), Cue::new(HookKind::Command, "pnpm test")]);
        let cues = from_tool("Edit", &json!({"file_path": "/r/game/Assets/Gen/a/b.cs"}), Some("/r/game/"));
        let keys: Vec<_> = cues.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["Edit", "Assets/Gen/a/b.cs", "Assets/Gen/a", "Assets/Gen", "Assets"]);
        let deep = from_tool("Read", &json!({"path": "a/b/c/d/e/f.rs"}), None);
        assert_eq!(deep.len(), 1 + 5, "the file and four folders above it");
    }

    #[test]
    fn the_same_error_has_the_same_key() {
        let a = error_key("error[E0425]: cannot find value `x` in this scope at src/a.rs:12:5");
        let b = error_key("error[E0425]: cannot find value `user_id` in this scope at src/b.rs:99:1");
        assert_eq!(a, b);
        assert_eq!(a, "error[e cannot find value in this scope at");
        assert_eq!(
            error_key("\n\nfatal: 'origin' does not appear to be a git repository\nmore"),
            "fatal does not appear to be a git repository"
        );
        assert_eq!(error_key("Killed 0x7ffe12 1234"), "killed");
        assert_eq!(from_error("   "), None);
    }

    #[test]
    fn a_message_names_paths_and_commands_and_keeps_its_words() {
        let m = from_message("Don't touch Assets/Generated/x.cs, run `npm run lint` before pushing.", None);
        assert!(m.cues.contains(&Cue::new(HookKind::Path, "Assets/Generated/x.cs")));
        assert!(m.cues.contains(&Cue::new(HookKind::Path, "Assets/Generated")));
        assert!(m.cues.contains(&Cue::new(HookKind::Command, "npm run lint")));
        assert!(m.query.starts_with("Don't touch"));
        let plain = from_message("Make it shorter please. e.g. no", None);
        assert_eq!(plain.cues, vec![]);
        let link = from_message("see https://example.com/a/b", None);
        assert_eq!(link.cues, vec![]);
    }
}
