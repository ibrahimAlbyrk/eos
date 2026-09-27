import { activeBranchOf, parseJsonlEntries, type ClaudeJsonlEntry } from "../../../core/src/domain/claude-transcript.ts";
import { parseStructuredPatch, type AgentEvent } from "../../../contracts/src/canonical.ts";
import type { PtyConversationRow, PtyPending } from "../../../contracts/src/http.ts";
import { blockText, durableBlocks, type RawBlock } from "../../backends/sdk/SdkEventMapper.ts";

// A claude pane's transcript (~/.claude/projects/…/<id>.jsonl) as event rows in
// the worker-events shape, so clients render it with their worker conversation
// view: assistant and tool content as `agent_event` messages (the same blocks
// the SDK lane records), typed prompts as `user_message`, an interrupt as an
// aborted turn. Only the active branch shows. A row's id is its entry's position
// in the file, so ids stay put while Claude appends.

type Entry = ClaudeJsonlEntry & {
  subtype?: unknown;
  toolUseResult?: unknown;
  isCompactSummary?: unknown;
  isApiErrorMessage?: unknown;
  message?: { role?: unknown; content?: unknown; stop_reason?: unknown };
};

export interface TranscriptView {
  rows: PtyConversationRow[];
  running: boolean;
  // The latest dialog tool call with no result yet.
  pending: PtyPending | null;
}

// Tool calls that stop and wait for the user in the terminal.
const isDialogTool = (name: string): name is PtyPending["name"] => name === "AskUserQuestion" || name === "ExitPlanMode";

type Prompt = { kind: "text"; text: string } | { kind: "interrupt" } | null;

// A pasted prompt (how a remote message is delivered) is recorded wrapped in
// <pasted_content id="…"> tags — show just what was pasted.
const PASTE_TAG = /\n?<\/?pasted_content id="[^"]*">\n?/g;

// A typed prompt, an interrupt marker, or harness chatter that is not conversation.
function classifyPrompt(raw: string): Prompt {
  const text = raw.replace(PASTE_TAG, "\n").trim();
  if (!text) return null;
  if (text.startsWith("[Request interrupted")) return { kind: "interrupt" };
  // A slash command is echoed as tags — show what the user typed.
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return { kind: "text", text: [cmd[1].trim(), args].filter(Boolean).join(" ") };
  }
  if (/^<(local-command-|bash-stdout|bash-stderr|task-notification)/.test(text)) return null;
  return { kind: "text", text };
}

function promptOf(content: unknown): Prompt {
  if (typeof content === "string") return classifyPrompt(content);
  if (!Array.isArray(content)) return null;
  const text = (content as RawBlock[])
    .map((b) => (b.type === "text" ? b.text ?? "" : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
  return classifyPrompt(text);
}

export function transcriptView(jsonl: string): TranscriptView {
  const entries = parseJsonlEntries(jsonl) as Entry[];
  const onPath = new Set<ClaudeJsonlEntry>(activeBranchOf(entries));
  const rows: PtyConversationRow[] = [];
  const waiting = new Map<string, PtyPending>();
  let running = false;

  entries.forEach((e, i) => {
    // Claude closes every turn with this marker (it hangs off the branch tip, so
    // it is never on the walked path itself).
    if (e.type === "system" && e.subtype === "turn_duration" && e.isSidechain !== true) { running = false; return; }
    if (!onPath.has(e) || e.isMeta === true || e.isCompactSummary === true || !e.message) return;
    const id = i + 1;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) || 0 : 0;
    const push = (type: string, payload: unknown): void => { rows.push({ id, ts, type, payload }); };
    const content = e.message.content;

    if (e.type === "assistant" && Array.isArray(content)) {
      const blocks = durableBlocks(String(e.uuid), content as RawBlock[], 0);
      for (const b of blocks) {
        if (b.type === "tool_call" && isDialogTool(b.name)) waiting.set(b.callId, { toolUseId: b.callId, name: b.name, input: b.input });
      }
      // Blocks are written as each completes, before the message's stop reason
      // is known (null) — only a final reason other than tool_use ends the turn.
      const stop = e.message.stop_reason;
      running = e.isApiErrorMessage !== true && (stop === "tool_use" || stop == null);
      if (blocks.length) push("agent_event", { type: "message", role: "assistant", blocks } satisfies AgentEvent);
      return;
    }
    if (e.type !== "user") return;

    const results = Array.isArray(content) ? (content as RawBlock[]).filter((b) => b.type === "tool_result") : [];
    if (results.length) {
      const patch = parseStructuredPatch((e.toolUseResult as { structuredPatch?: unknown } | undefined)?.structuredPatch);
      for (const r of results) waiting.delete(r.tool_use_id ?? "");
      running = true;
      push("agent_event", {
        type: "message",
        role: "tool",
        blocks: results.map((r) => ({
          type: "tool_result" as const,
          callId: r.tool_use_id ?? "",
          isError: r.is_error === true,
          content: blockText(r.content),
          ...(patch ? { patch } : {}),
        })),
      } satisfies AgentEvent);
      return;
    }

    const prompt = promptOf(content);
    if (!prompt) return;
    // A new prompt or an interrupt means any open dialog is gone.
    waiting.clear();
    if (prompt.kind === "interrupt") {
      running = false;
      push("agent_event", { type: "turn", phase: "aborted" } satisfies AgentEvent);
      return;
    }
    running = true;
    push("user_message", { text: prompt.text });
  });

  return { rows, running, pending: [...waiting.values()].pop() ?? null };
}
