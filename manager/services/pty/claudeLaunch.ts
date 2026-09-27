import { randomUUID } from "node:crypto";
import { CLAUDE_COMMAND, type PtyPending } from "../../../contracts/src/http.ts";

// How a claude PTY is launched and how its pane reports back. Claude Code runs
// with inline `--settings` hooks (no file anywhere, no effect on other sessions)
// that print to the pane's own terminal as private OSC sequences:
//   - SessionStart: the live session id. It fires on startup/resume/clear/
//     compact, so /clear and /resume keep the pane's id current. The desktop's
//     TerminalView parses this one too (app/ui/src/lib/claudeSessionOsc.js).
//   - PreToolUse on the dialog tools: the call about to wait on the user. Claude
//     can write that call to its transcript only once it is answered, so the
//     transcript alone can't tell a remote client a question is open.
// Hooks run detached from the controlling terminal, so the launch exports the
// PTY device as EOS_TTY.

const CLAUDE_SESSION_OSC = 7777;
const SESSION_PREFIX = "eos-claude-session=";
const TOOL_PREFIX = "eos-claude-tool=";
const DIALOG_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `|| true`: a missing EOS_TTY must never surface as a hook error in Claude.
const HOOK_COMMAND =
  `sid=$(sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p'); ` +
  `[ -w "$EOS_TTY" ] && printf '\\033]${CLAUDE_SESSION_OSC};${SESSION_PREFIX}%s\\007' "$sid" > "$EOS_TTY" || true`;

// The hook's stdin (tool name, input, id) rides along base64-encoded.
const TOOL_HOOK_COMMAND =
  `p=$(base64 | tr -d '\\n'); ` +
  `[ -w "$EOS_TTY" ] && printf '\\033]${CLAUDE_SESSION_OSC};${TOOL_PREFIX}%s\\007' "$p" > "$EOS_TTY" || true`;

const HOOK_SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }],
    PreToolUse: [{ matcher: DIALOG_TOOLS.join("|"), hooks: [{ type: "command", command: TOOL_HOOK_COMMAND }] }],
  },
});

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const withHooks = (claudeCmd: string): string =>
  `EOS_TTY=$(tty) ${claudeCmd} --settings ${shellQuote(HOOK_SETTINGS)}`;

// The conversation id is pinned up front so the pane can be resumed after its
// PTY dies. A conversation that never got a message has no transcript to resume
// — then it starts fresh under the same id.
export function claudeLaunch(resume?: string): { command: string; claudeSessionId: string } {
  const id = resume ?? randomUUID();
  const fresh = withHooks(`${CLAUDE_COMMAND} --session-id ${id}`);
  const command = resume ? `${withHooks(`${CLAUDE_COMMAND} --resume ${id}`)} || ${fresh}` : fresh;
  return { command, claudeSessionId: id };
}

export type OscEvent =
  | { kind: "title"; title: string | null }
  | { kind: "claudeSession"; id: string }
  | { kind: "dialogTool"; call: PtyPending };

// Longest OSC body worth waiting for across chunk boundaries — a dialog tool
// report carries a whole plan.
const MAX_OSC = 1024 * 1024;

// Pulls terminal-title (OSC 0/2) and session-hook (OSC 7777) reports out of a
// pane's output stream. A sequence split across chunks is carried to the next.
export function createOscScanner(): (data: string) => OscEvent[] {
  let carry = "";
  return (data) => {
    const s = carry + data;
    carry = "";
    const out: OscEvent[] = [];
    let i = s.indexOf("\x1b]");
    while (i !== -1) {
      const bel = s.indexOf("\x07", i + 2);
      const st = s.indexOf("\x1b\\", i + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        if (s.length - i <= MAX_OSC) carry = s.slice(i);
        return out;
      }
      const ev = parseOsc(s.slice(i + 2, end));
      if (ev) out.push(ev);
      i = s.indexOf("\x1b]", end + 1);
    }
    if (s.endsWith("\x1b")) carry = "\x1b";
    return out;
  };
}

function parseOsc(body: string): OscEvent | null {
  const semi = body.indexOf(";");
  if (semi === -1) return null;
  const code = body.slice(0, semi);
  const arg = body.slice(semi + 1);
  if (code === "0" || code === "2") {
    // Leading status glyphs (Claude's spinner) are not part of the title.
    return { kind: "title", title: arg.replace(/^[^\p{L}\p{N}]+/u, "").trim() || null };
  }
  if (code !== String(CLAUDE_SESSION_OSC)) return null;
  if (arg.startsWith(SESSION_PREFIX)) {
    const id = arg.slice(SESSION_PREFIX.length);
    return UUID.test(id) ? { kind: "claudeSession", id } : null;
  }
  if (arg.startsWith(TOOL_PREFIX)) {
    const call = parseToolReport(arg.slice(TOOL_PREFIX.length));
    return call ? { kind: "dialogTool", call } : null;
  }
  return null;
}

function parseToolReport(b64: string): PtyPending | null {
  let hook: { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown };
  try { hook = JSON.parse(Buffer.from(b64, "base64").toString("utf8")); } catch { return null; }
  const name = DIALOG_TOOLS.find((t) => t === hook.tool_name);
  if (!name || typeof hook.tool_use_id !== "string" || !hook.tool_input || typeof hook.tool_input !== "object") return null;
  return { toolUseId: hook.tool_use_id, name, input: hook.tool_input as Record<string, unknown> };
}
