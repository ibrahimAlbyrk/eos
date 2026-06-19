// SlashCommand — a backend-agnostic, open/closed slash-command abstraction.
// A command typed in the composer ("/clear") is intercepted at the dispatch
// chokepoint and run as a control side effect instead of a chat turn. Adding a
// command is registering a module here — never editing dispatchMessage, the
// route, or the AgentBackend port. Mirrors the MCP tool registry / CLI command
// registry idioms.
//
// The registry is an ALLOWLIST of Eos-owned commands. Anything not registered
// (plain text, partial "/cle", claude-native "/compact", unknown "/foo") is NOT
// intercepted and flows on as a normal message — parseSlash returns null for it.

import type { AgentSession, AgentCapabilities } from "../ports/AgentBackend.ts";

// The narrow daemon-side seams a command may touch. Injected by the chokepoint
// from the container's existing services so commands stay decoupled from it.
export interface SlashSideEffects {
  /** Drop the worker's pending queued messages — a fresh context must not inherit
   *  the old queue. Returns the count cleared. */
  clearPendingQueue(workerId: string): number;
  /** Abandon the worker's outstanding peer consultations. */
  cancelPeerRequests(workerId: string): void;
  /** Append the conversation_cleared timeline marker (the web hides everything
   *  before it) and publish the change. */
  appendConversationCleared(workerId: string, payload: Record<string, unknown>): void;
}

export interface SlashCommandContext {
  readonly workerId: string;
  /** Text after the command name, trimmed. "" when the command takes no args. */
  readonly args: string;
  /** The worker's backend session, already attached by the chokepoint. */
  readonly session: AgentSession;
  readonly caps: AgentCapabilities;
  readonly services: SlashSideEffects;
}

export interface SlashCommandResult {
  readonly status: number;
  readonly body: unknown;
}

export interface SlashCommand {
  readonly name: string;          // matched WITHOUT the leading slash
  readonly description: string;   // discoverability (served to the web)
  readonly aliases?: readonly string[];
  /** True only when this command can complete for these args + capabilities.
   *  false → the chokepoint does NOT intercept; the text flows as a normal
   *  message (incapable backend, or args the command rejects). */
  accepts(args: string, caps: AgentCapabilities): boolean;
  execute(ctx: SlashCommandContext): Promise<SlashCommandResult>;
}

export interface SlashCommandRegistry {
  get(name: string): SlashCommand | undefined;   // exact name/alias match
  list(): SlashCommand[];                         // discoverability endpoint
}

export function createSlashCommandRegistry(commands: readonly SlashCommand[]): SlashCommandRegistry {
  const byName = new Map<string, SlashCommand>();
  for (const c of commands) {
    byName.set(c.name, c);
    for (const a of c.aliases ?? []) byName.set(a, c);
  }
  return {
    get: (name) => byName.get(name),
    list: () => [...commands],
  };
}

// Exact first-token match only. Returns null for plain text and for any
// partial/unknown command so it flows on as a normal message (the user can
// still literally send text starting with "/", and claude-native commands the
// CLI TUI owns still pass through). `accepts` is checked by the chokepoint, not
// here — a registered-but-not-accepted command also falls through.
export function parseSlash(
  text: string,
  registry: SlashCommandRegistry,
): { command: SlashCommand; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const sp = trimmed.indexOf(" ");
  const name = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp);
  const args = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
  if (name === "") return null;
  const command = registry.get(name);
  return command ? { command, args } : null;
}
