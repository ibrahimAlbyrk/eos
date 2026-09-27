// Live Claude Code conversation id for a Code-view pane. The daemon launches
// Claude Code with an inline `--settings` SessionStart hook (no file anywhere,
// no effect on other sessions) that prints the current session id to the pane's
// own terminal as a private, invisible OSC sequence; TerminalView parses it back
// out. The hook fires on startup/resume/clear/compact, so /clear and /resume
// keep the pane's resumable id current. Launch side:
// manager/services/pty/claudeLaunch.ts.

export const CLAUDE_SESSION_OSC = 7777;
const PREFIX = "eos-claude-session=";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// OSC payload → session id, or null when it isn't ours / is malformed.
export function parseClaudeSessionOsc(data) {
  if (!data.startsWith(PREFIX)) return null;
  const id = data.slice(PREFIX.length);
  return UUID.test(id) ? id : null;
}
