// Codex app-server notifications → canonical AgentEvents. Pure and stateful per
// session (like SdkEventMapper): it tracks which items started streaming and the
// thread's cumulative token total, so each turn bills only its own tokens.
//
// Codex's work items take the Claude tool names the rest of Eos already renders
// and gates on — a shell command is Bash, a patched file Edit/Write (one call per
// file, with its diff as the structured patch), a plan TodoWrite, an MCP call
// mcp__<server>__<tool>.

import type { AgentEvent, ContentBlock, PatchHunk } from "../../../contracts/src/canonical.ts";

type Params = Record<string, unknown>;
type Item = Record<string, unknown> & { id: string; type: string };

interface TokenTotals { inputTokens: number; cachedInputTokens: number; outputTokens: number }
const ZERO: TokenTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Codex runs every command through the user's login shell (`/bin/zsh -lc '…'`).
// The inner command is what the user reads and what policy rules match on.
export function unwrapShellCommand(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command.trim());
  return m ? m[1].replaceAll("'\\''", "'") : command;
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// A unified diff's hunks with their absolute line numbers — the patch sidecar the
// UI diff view reads. Anything that doesn't parse yields no patch.
export function parseUnifiedDiff(diff: string): PatchHunk[] | undefined {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
    } else if (current && /^[ +-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")) {
      current.lines.push(line);
    }
  }
  return hunks.length ? hunks : undefined;
}

function fileChangeCalls(item: Item): Array<{ callId: string; name: string; path: string; diff: string }> {
  const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
  return changes.map((c, i) => {
    const kind = (c.kind as { type?: string } | undefined)?.type;
    return { callId: `${item.id}:${i}`, name: kind === "add" ? "Write" : "Edit", path: str(c.path), diff: str(c.diff) };
  });
}

function mcpResultText(item: Item): string {
  const error = item.error as { message?: string } | null | undefined;
  if (error?.message) return error.message;
  const content = (item.result as { content?: unknown[] } | null | undefined)?.content ?? [];
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

const TODO_STATUS: Record<string, string> = { pending: "pending", inProgress: "in_progress", completed: "completed" };

export interface CodexEventMapper {
  map(method: string, params: Params): AgentEvent[];
  setModel(model: string | null): void;
}

export function createCodexEventMapper(): CodexEventMapper {
  let model: string | null = null;
  let turnId: string | null = null;
  let planSeq = 0;
  let total: TokenTotals = ZERO;
  let turnStartTotal: TokenTotals = ZERO;
  const streaming = new Set<string>(); // blockIds with an open delta buffer
  const announced = new Set<string>(); // tool items whose call was already emitted

  const assistant = (blocks: ContentBlock[]): AgentEvent => ({ type: "message", role: "assistant", blocks, model });
  const tool = (blocks: ContentBlock[]): AgentEvent => ({ type: "message", role: "tool", blocks });

  const delta = (channel: "text" | "reasoning", blockId: string, text: string): AgentEvent => {
    const phase = streaming.has(blockId) ? "append" : "start";
    streaming.add(blockId);
    return { type: "delta", channel, phase, blockId, text };
  };
  const closeDelta = (channel: "text" | "reasoning", blockId: string): AgentEvent[] => {
    if (!streaming.delete(blockId)) return [];
    return [{ type: "delta", channel, phase: "stop", blockId, text: "" }];
  };

  // The call half of a tool item — emitted once, on start or (if Codex skipped
  // the start) just before its result.
  const callsFor = (item: Item): AgentEvent[] => {
    if (announced.has(item.id)) return [];
    let blocks: ContentBlock[] = [];
    if (item.type === "commandExecution") {
      blocks = [{ type: "tool_call", callId: item.id, name: "Bash", input: { command: unwrapShellCommand(str(item.command)) } }];
    } else if (item.type === "fileChange") {
      blocks = fileChangeCalls(item).map((c) => ({ type: "tool_call", callId: c.callId, name: c.name, input: { file_path: c.path } }));
    } else if (item.type === "mcpToolCall") {
      const input = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
      blocks = [{ type: "tool_call", callId: item.id, name: `mcp__${str(item.server)}__${str(item.tool)}`, input }];
    } else if (item.type === "webSearch") {
      blocks = [{ type: "tool_call", callId: item.id, name: "WebSearch", input: { query: str(item.query) } }];
    }
    if (!blocks.length) return [];
    announced.add(item.id);
    return [assistant(blocks)];
  };

  const completed = (item: Item): AgentEvent[] => {
    switch (item.type) {
      case "agentMessage": {
        const text = str(item.text);
        return [...closeDelta("text", item.id), ...(text ? [assistant([{ type: "text", text, blockId: item.id }])] : [])];
      }
      case "reasoning": {
        const blockId = `${item.id}:reasoning`;
        const text = (Array.isArray(item.summary) ? (item.summary as unknown[]) : []).map(str).filter(Boolean).join("\n\n");
        return [...closeDelta("reasoning", blockId), ...(text ? [assistant([{ type: "reasoning", text, blockId }])] : [])];
      }
      case "commandExecution": {
        const status = str(item.status);
        const output = str(item.aggregatedOutput);
        const failed = status !== "completed" || num(item.exitCode) !== 0;
        const content = output || (status === "declined" ? "Declined — not run." : "");
        return [...callsFor(item), tool([{ type: "tool_result", callId: item.id, isError: failed, content }])];
      }
      case "fileChange": {
        const failed = str(item.status) !== "completed";
        const results: ContentBlock[] = fileChangeCalls(item).map((c) => {
          const patch = parseUnifiedDiff(c.diff);
          return { type: "tool_result", callId: c.callId, isError: failed, content: failed ? "Not applied." : c.diff, ...(patch && !failed ? { patch } : {}) };
        });
        return results.length ? [...callsFor(item), tool(results)] : [];
      }
      case "mcpToolCall":
        return [...callsFor(item), tool([{ type: "tool_result", callId: item.id, isError: str(item.status) === "failed" || Boolean(item.error), content: mcpResultText(item) }])];
      case "webSearch":
        return [...callsFor(item), tool([{ type: "tool_result", callId: item.id, isError: false, content: "" }])];
      default:
        return [];
    }
  };

  return {
    setModel(m) { model = m; },
    map(method, params) {
      switch (method) {
        case "turn/started":
          turnId = str((params.turn as Params | undefined)?.id) || null;
          turnStartTotal = total;
          return [{ type: "turn", phase: "started" }];
        case "item/started": {
          const item = params.item as Item | undefined;
          return item ? callsFor(item) : [];
        }
        case "item/completed": {
          const item = params.item as Item | undefined;
          return item ? completed(item) : [];
        }
        case "item/agentMessage/delta":
          return [delta("text", str(params.itemId), str(params.delta))];
        case "item/reasoning/summaryTextDelta":
          return [delta("reasoning", `${str(params.itemId)}:reasoning`, str(params.delta))];
        case "turn/plan/updated": {
          const plan = Array.isArray(params.plan) ? (params.plan as Array<Record<string, unknown>>) : [];
          if (!plan.length) return [];
          const callId = `plan:${turnId ?? "turn"}:${++planSeq}`;
          const todos = plan.map((p) => ({ content: str(p.step), activeForm: str(p.step), status: TODO_STATUS[str(p.status)] ?? "pending" }));
          return [
            assistant([{ type: "tool_call", callId, name: "TodoWrite", input: { todos } }]),
            tool([{ type: "tool_result", callId, isError: false, content: "Plan updated." }]),
          ];
        }
        case "thread/tokenUsage/updated": {
          const usage = params.tokenUsage as { total?: Params; last?: Params } | undefined;
          if (usage?.total) {
            total = { inputTokens: num(usage.total.inputTokens), cachedInputTokens: num(usage.total.cachedInputTokens), outputTokens: num(usage.total.outputTokens) };
          }
          const last = usage?.last;
          return last ? [{ type: "context", tokens: num(last.inputTokens) + num(last.outputTokens) }] : [];
        }
        case "turn/completed": {
          const turn = (params.turn ?? {}) as Params;
          const input = total.inputTokens - turnStartTotal.inputTokens;
          const cached = total.cachedInputTokens - turnStartTotal.cachedInputTokens;
          const output = total.outputTokens - turnStartTotal.outputTokens;
          turnStartTotal = total;
          turnId = null;
          // OpenAI's input count includes the cached share — bill the rest as fresh input.
          const events: AgentEvent[] = input > 0 || output > 0
            ? [{ type: "usage", usage: { inputTokens: Math.max(0, input - cached), outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: {}, model } }]
            : [];
          const status = str(turn.status);
          if (status === "interrupted") events.push({ type: "turn", phase: "aborted", reason: "interrupted" });
          else if (status === "failed") events.push({ type: "turn", phase: "error", reason: str((turn.error as Params | null | undefined)?.message) || "failed" });
          else events.push({ type: "turn", phase: "ended" });
          return events;
        }
        default:
          return [];
      }
    },
  };
}
