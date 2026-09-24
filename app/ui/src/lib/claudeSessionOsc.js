// Live Claude Code conversation id for a Code-view pane. Claude Code is launched
// with an inline `--settings` SessionStart hook (no file anywhere, no effect on
// other sessions) that prints the current session id to the pane's own terminal
// as a private, invisible OSC sequence; TerminalView parses it back out. The
// hook fires on startup/resume/clear/compact, so /clear and /resume keep the
// pane's resumable id current.
//
// Hooks run detached from the controlling terminal (/dev/tty is unavailable),
// so the launch exports the PTY's device path as EOS_TTY for the hook to write
// to.

export const CLAUDE_SESSION_OSC = 7777;
const PREFIX = "eos-claude-session=";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `|| true`: a missing EOS_TTY must never surface as a hook error in Claude.
const HOOK_COMMAND =
  `sid=$(sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p'); ` +
  `[ -w "$EOS_TTY" ] && printf '\\033]${CLAUDE_SESSION_OSC};${PREFIX}%s\\007' "$sid" > "$EOS_TTY" || true`;

const HOOK_SETTINGS = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
});

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Wraps a `claude …` command line so its session id is reported to the pane.
export const withSessionHook = (claudeCmd) =>
  `EOS_TTY=$(tty) ${claudeCmd} --settings ${shellQuote(HOOK_SETTINGS)}`;

// OSC payload → session id, or null when it isn't ours / is malformed.
export function parseClaudeSessionOsc(data) {
  if (!data.startsWith(PREFIX)) return null;
  const id = data.slice(PREFIX.length);
  return UUID.test(id) ? id : null;
}
