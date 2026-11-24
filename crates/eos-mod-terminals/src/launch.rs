//! How a Code-view Claude is launched and how its pane reports back.
//!
//! Claude Code runs with inline `--settings` hooks (no file anywhere, no
//! effect on other sessions) that print to the pane's own terminal as private
//! OSC sequences:
//! - SessionStart: the live session id. It fires on startup, resume, clear
//!   and compact, so `/clear` and `/resume` keep the pane's id current.
//! - PreToolUse on the dialog tools: the call about to wait on the user.
//!   Claude writes that call to its transcript only once it is answered, so
//!   the transcript alone cannot tell a remote client a question is open.
//!
//! - With memory's hooks on (04 G34): the session's start, each prompt, a
//!   Bash, Edit, Write or Read about to run and a tool that failed run the
//!   app's `eos memory hook`, which answers within 300 ms with what Eos
//!   remembers, or with nothing.
//!
//! Hooks run detached from the controlling terminal, so the launch exports
//! the PTY device as `EOS_TTY`.

use eos_contracts::CLAUDE_COMMAND;
use eos_core::terminal::Terminals;
use serde_json::json;

// `|| true`: a missing EOS_TTY must never surface as a hook error in Claude.
const SESSION_HOOK: &str = concat!(
    r#"sid=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p'); "#,
    r#"[ -w "$EOS_TTY" ] && printf '\033]7777;eos-claude-session=%s\007' "$sid" > "$EOS_TTY" || true"#,
);
// The hook's stdin (tool name, input, id) rides along base64-encoded.
const TOOL_HOOK: &str = concat!(
    r"p=$(base64 | tr -d '\n'); ",
    r#"[ -w "$EOS_TTY" ] && printf '\033]7777;eos-claude-tool=%s\007' "$p" > "$EOS_TTY" || true"#,
);

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The tools memory is asked about before they run.
const MEMORY_TOOLS: &str = "Bash|Edit|Write|Read";

fn hook_settings(memory: Option<&str>) -> String {
    let mut settings = json!({
        "hooks": {
            "SessionStart": [{ "hooks": [{ "type": "command", "command": SESSION_HOOK }] }],
            "PreToolUse": [{ "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [{ "type": "command", "command": TOOL_HOOK }] }],
        }
    });
    if let Some(memory) = memory {
        // `|| true`: memory missing or slow is never a hook error in Claude.
        let ask = |event: &str| json!({ "hooks": [{ "type": "command", "command": format!("{memory} --event {event} || true") }] });
        let hooks = &mut settings["hooks"];
        for event in ["SessionStart", "UserPromptSubmit", "PostToolUseFailure"] {
            match hooks[event].as_array_mut() {
                Some(list) => list.push(ask(event)),
                None => hooks[event] = json!([ask(event)]),
            }
        }
        let mut before = ask("PreToolUse");
        before["matcher"] = json!(MEMORY_TOOLS);
        if let Some(list) = hooks["PreToolUse"].as_array_mut() {
            list.push(before);
        }
    }
    settings.to_string()
}

/// The command line that starts Claude in a pane, for conversation `id`.
///
/// The id is pinned up front so the pane can be resumed after its PTY dies. A
/// conversation that never got a message has no transcript to resume: it then
/// starts fresh under the same id. Where the pane's shell cannot hand hooks
/// its terminal device, the pane runs without them: the pinned id stands (a
/// `/clear` inside is not followed) and open dialogs are not reported.
///
/// `claude` is the word the shell runs it by (`eos_core::terminal::ClaudeProgram`);
/// `memory`, the command memory's hooks run, when they are on
/// (`eos_core::terminal::PaneHooks`).
pub(crate) fn claude_command(
    terminals: &dyn Terminals,
    claude: &str,
    id: &str,
    resume: bool,
    memory: Option<&str>,
) -> String {
    // The contract's command names the program plainly; the user's own is run.
    let program = if claude == "claude" { claude.to_owned() } else { shell_quote(claude) };
    let base = CLAUDE_COMMAND.strip_prefix("claude").map_or_else(|| CLAUDE_COMMAND.to_owned(), |rest| program + rest);
    let hooked = |command: String| {
        if terminals.tty_hooks() {
            format!("EOS_TTY=$(tty) {command} --settings {}", shell_quote(&hook_settings(memory)))
        } else {
            command
        }
    };
    let fresh = hooked(format!("{base} --session-id {id}"));
    if resume { terminals.or_else(&hooked(format!("{base} --resume {id}")), &fresh) } else { fresh }
}
