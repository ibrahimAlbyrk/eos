// Gemini CLI ACP session updates → canonical AgentEvents. Pure and stateful per
// session, like CodexEventMapper. ACP streams text and thoughts as bare chunks
// with no ids, so a block runs until the channel changes (thought → text, or a
// tool call) and is then closed as one durable block. Gemini reports no token
// usage over ACP, so no usage events are emitted.
//
// Gemini's tools take the Claude tool names the rest of Eos already renders and
// gates on — a shell command is Bash, an edited file Edit/Write, an MCP call
// mcp__<server>__<tool>.

import type { AgentEvent, ContentBlock } from "../../../contracts/src/canonical.ts";

type Params = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Params => (v && typeof v === "object" && !Array.isArray(v) ? (v as Params) : {});
const list = (v: unknown): Params[] => (Array.isArray(v) ? v.map(record) : []);

// run_shell_command's title is "<command> [in <dir>]" or "<command> [current
// working directory <cwd>]", then an optional " (<description>)" and
// " [background]". The command is what the user reads and what policy matches.
const SHELL_TITLE_RE = /^([\s\S]*?) \[(?:in |current working directory )[^\]]*\](?: \(.*\))?(?: \[background\])?$/;

export function shellCommand(title: string): string {
  return SHELL_TITLE_RE.exec(title)?.[1] ?? title;
}

function parseArgs(title: string): Params {
  try {
    return record(JSON.parse(title));
  } catch {
    return {};
  }
}

export interface EosToolCall {
  name: string;
  input: Record<string, unknown>;
}

// ACP carries no raw tool name or arguments, so the Eos tool is read off what it
// does carry: the kind, the title (a command's text, an MCP call's JSON args),
// the diff and the touched paths. The call id is "<gemini tool>-<ms>", and an MCP
// tool is "mcp_<server>_<tool>" — split on the server names Eos passed in.
export function eosToolCall(toolCall: Params, mcpServers: readonly string[]): EosToolCall {
  const title = str(toolCall.title);
  const geminiName = /^(.+)-\d+$/.exec(str(toolCall.toolCallId))?.[1] ?? "";
  if (geminiName.startsWith("mcp_")) {
    const qualified = geminiName.slice("mcp_".length);
    const server = mcpServers.find((s) => qualified.startsWith(`${s}_`));
    return { name: server ? `mcp__${server}__${qualified.slice(server.length + 1)}` : geminiName, input: parseArgs(title) };
  }
  const path = str(list(toolCall.locations)[0]?.path);
  switch (str(toolCall.kind)) {
    case "execute":
      return { name: "Bash", input: { command: shellCommand(title) } };
    case "edit":
    case "delete":
    case "move": {
      const diff = list(toolCall.content).find((c) => c.type === "diff");
      const isNew = str(record(diff?._meta).kind) === "add";
      return { name: isNew ? "Write" : "Edit", input: { file_path: str(diff?.path) || path } };
    }
    case "read":
      return { name: "Read", input: { file_path: path || title } };
    case "search":
      return { name: "Grep", input: { pattern: title } };
    case "fetch":
      return { name: "WebFetch", input: { prompt: title } };
    default:
      return { name: geminiName || "Tool", input: { description: title } };
  }
}

function resultText(content: unknown): string {
  return list(content)
    .map((c) => (c.type === "diff" ? str(c.path) : str(record(c.content).text)))
    .filter(Boolean)
    .join("\n");
}

export interface GeminiEventMapper {
  /** A session/update notification's `update`. */
  update(update: Params): AgentEvent[];
  /** A call announced by a permission request — Gemini sends no tool_call for those. */
  announce(toolCall: Params): AgentEvent[];
  /** A declined call — Gemini reports nothing more for it. */
  declined(toolCallId: string): AgentEvent[];
  startTurn(): AgentEvent[];
  /** The session/prompt request settled with a stop reason, or failed. */
  endTurn(outcome: { stopReason: string } | { error: string }): AgentEvent[];
  setModel(model: string | null): void;
}

/** `idPrefix` keeps block ids unique across the worker's sessions (a resume or /clear starts a new mapper). */
export function createGeminiEventMapper(opts: { idPrefix: string; mcpServers: readonly string[] }): GeminiEventMapper {
  let model: string | null = null;
  let turnSeq = 0;
  let blockSeq = 0;
  let open: { channel: "text" | "reasoning"; blockId: string; text: string } | null = null;
  const announced = new Set<string>();

  const assistant = (blocks: ContentBlock[]): AgentEvent => ({ type: "message", role: "assistant", blocks, model });
  const tool = (blocks: ContentBlock[]): AgentEvent => ({ type: "message", role: "tool", blocks });

  const closeBlock = (): AgentEvent[] => {
    if (!open) return [];
    const { channel, blockId, text } = open;
    open = null;
    const block: ContentBlock = channel === "text" ? { type: "text", text, blockId } : { type: "reasoning", text, blockId };
    return [{ type: "delta", channel, phase: "stop", blockId, text: "" }, ...(text ? [assistant([block])] : [])];
  };

  const chunk = (channel: "text" | "reasoning", text: string): AgentEvent[] => {
    if (!text) return [];
    const events = open && open.channel !== channel ? closeBlock() : [];
    const phase = open ? "append" : "start";
    open ??= { channel, blockId: `${opts.idPrefix}:${turnSeq}:${++blockSeq}`, text: "" };
    open.text += text;
    events.push({ type: "delta", channel, phase, blockId: open.blockId, text });
    return events;
  };

  const announce = (toolCall: Params): AgentEvent[] => {
    const callId = str(toolCall.toolCallId);
    if (!callId || announced.has(callId)) return [];
    announced.add(callId);
    const { name, input } = eosToolCall(toolCall, opts.mcpServers);
    return [...closeBlock(), assistant([{ type: "tool_call", callId, name, input }])];
  };

  return {
    setModel(m) { model = m; },
    update(u) {
      switch (str(u.sessionUpdate)) {
        case "agent_message_chunk":
          return chunk("text", str(record(u.content).text));
        case "agent_thought_chunk":
          return chunk("reasoning", str(record(u.content).text));
        case "tool_call":
          return announce(u);
        case "tool_call_update": {
          const status = str(u.status);
          if (status !== "completed" && status !== "failed") return [];
          return [...closeBlock(), tool([{ type: "tool_result", callId: str(u.toolCallId), isError: status === "failed", content: resultText(u.content) }])];
        }
        default:
          return [];
      }
    },
    announce,
    declined(toolCallId) {
      return [tool([{ type: "tool_result", callId: toolCallId, isError: true, content: "Declined — not run." }])];
    },
    startTurn() {
      turnSeq++;
      announced.clear();
      return [{ type: "turn", phase: "started" }];
    },
    endTurn(outcome) {
      const events = closeBlock();
      if ("error" in outcome) events.push({ type: "turn", phase: "error", reason: outcome.error });
      else if (outcome.stopReason === "cancelled") events.push({ type: "turn", phase: "aborted", reason: "interrupted" });
      else if (outcome.stopReason === "refusal") events.push({ type: "turn", phase: "error", reason: "The model declined to continue." });
      else events.push({ type: "turn", phase: "ended" });
      return events;
    },
  };
}
