// Pure JSONL transcript parser — extracted from worker.ts so the event-emission
// logic can be exercised without the chokidar/PTY scaffolding.
//
// Claude Code transcripts wrap content blocks inside message objects:
//   { message: { role: "assistant", content: [{type:"text"|"tool_use"|"thinking", ...}], usage }}
//   { message: { role: "user",      content: [{type:"tool_result", ...}] }}
// Plus legacy and built-in-tool variants handled below.

export interface UsagePayload {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreate: number;
  model: string;
}

export interface JsonlPayload {
  kind: "assistant_text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
}

export type EmitFn =
  | ((type: "usage", payload: UsagePayload) => void)
  | ((type: "jsonl", payload: JsonlPayload) => void);

/**
 * Parses a single JSONL transcript line and invokes `emit(type, payload)`
 * for each event it can extract. A single line can produce multiple events
 * (e.g. an assistant message with both `text` and `tool_use` blocks).
 *
 * Silently ignores malformed JSON — transcripts can be torn at chunk
 * boundaries when the tail reader catches a partial write.
 *
 * @param line          One JSONL line (no trailing newline).
 * @param emit          Callback receiving (eventType, payload) tuples.
 * @param defaultModel  Fallback model name when the assistant message itself
 *                      doesn't carry one (used for the `usage` event).
 */
export function parseJsonlLine(
  line: string,
  emit: (type: string, payload: unknown) => void,
  defaultModel = "opus",
): void {
  let e: Record<string, unknown>;
  try { e = JSON.parse(line); } catch { return; }

  const msg = e.message as Record<string, unknown> | undefined;

  if (msg?.role === "assistant") {
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage && (usage.input_tokens || usage.output_tokens || usage.cache_read_input_tokens || usage.cache_creation_input_tokens)) {
      emit("usage", {
        in: (usage.input_tokens as number) ?? 0,
        out: (usage.output_tokens as number) ?? 0,
        cacheRead: (usage.cache_read_input_tokens as number) ?? 0,
        cacheCreate: (usage.cache_creation_input_tokens as number) ?? 0,
        model: (msg.model as string) ?? defaultModel,
      });
    }
    for (const block of (msg.content as Array<Record<string, unknown>>) ?? []) {
      if (block.type === "text") {
        emit("jsonl", { kind: "assistant_text", text: String(block.text) });
      } else if (block.type === "tool_use") {
        emit("jsonl", {
          kind: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === "thinking") {
        emit("jsonl", { kind: "thinking", text: String(block.thinking ?? block.text ?? "") });
      }
    }
    return;
  }

  if (msg?.role === "user") {
    for (const block of (msg.content as Array<Record<string, unknown>>) ?? []) {
      if (block.type === "tool_result") {
        const raw = block.content;
        const text =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.map((c: { text?: string }) => c?.text ?? "").join("")
              : "";
        emit("jsonl", {
          kind: "tool_result",
          toolUseId: block.tool_use_id as string,
          isError: !!block.is_error,
          text,
        });
      }
    }
    return;
  }

  // Built-in tools (ToolSearch, etc.) deliver results as a top-level
  // "attachment" with type "hook_success" — synthesize a tool_result so the
  // UI can still pair by id.
  if (e.type === "attachment") {
    const a = e.attachment as Record<string, unknown> | undefined;
    if (a?.type === "hook_success") {
      const text = String(a.content ?? a.stdout ?? "").trim();
      const exitCode = typeof a.exitCode === "number" ? a.exitCode : 0;
      emit("jsonl", {
        kind: "tool_result",
        toolUseId: a.toolUseID as string,
        isError: exitCode >= 400,
        text,
      });
    }
    return;
  }

  // Legacy top-level event shapes (older Claude Code transcript formats).
  if (e.type === "tool_use") {
    emit("jsonl", { kind: "tool_use", name: e.name as string, input: (e.input as Record<string, unknown>) ?? {} });
  } else if (e.type === "tool_result") {
    const c = e.content as Array<{ text?: string }> | undefined;
    emit("jsonl", { kind: "tool_result", isError: !!e.isError, text: String(c?.[0]?.text ?? "") });
  }
}
