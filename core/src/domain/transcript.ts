// Lane-neutral conversation transcript — what a context summarizer reads. A
// backend that supports compaction translates its own store (the claude JSONL,
// an in-process message buffer, …) into these entries; everything downstream
// (rendering, budgeting, turn counting) stays backend-agnostic.

export type TranscriptEntry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool_call"; readonly name: string; readonly input: string }
  | { readonly kind: "tool_result"; readonly text: string; readonly isError: boolean };

export interface SessionTranscript {
  readonly entries: readonly TranscriptEntry[];
  /** Where the full pre-compaction transcript stays readable on disk, if anywhere —
   *  the continuation message points the agent at it for exact details. */
  readonly path: string | null;
}

export interface RenderedTranscript {
  readonly text: string;
  /** User turns in the rendered conversation (tool results excluded). */
  readonly turns: number;
  /** Oldest entries dropped to fit the budget (0 when everything fit). */
  readonly omitted: number;
}

export interface RenderOptions {
  readonly maxChars: number;
  readonly toolInputChars?: number;
  readonly toolResultChars?: number;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [${s.length - n} more chars]`;
}

function block(e: TranscriptEntry, toolInputChars: number, toolResultChars: number): string {
  switch (e.kind) {
    case "user": return `[user]\n${e.text}`;
    case "assistant": return `[assistant]\n${e.text}`;
    case "tool_call": return `[tool call: ${e.name}]\n${clip(e.input, toolInputChars)}`;
    case "tool_result": return `[tool result${e.isError ? " (error)" : ""}]\n${clip(e.text, toolResultChars)}`;
  }
}

/**
 * Plain-text rendering for the summarizer. Tool I/O is clipped (it dominates
 * raw size and matters least verbatim); when the whole thing still exceeds
 * `maxChars`, the OLDEST entries go first — the recent work is what the agent
 * must continue — but the first user message is always kept, since it usually
 * states the task.
 */
export function renderTranscript(entries: readonly TranscriptEntry[], opts: RenderOptions): RenderedTranscript {
  const toolInputChars = opts.toolInputChars ?? 2000;
  const toolResultChars = opts.toolResultChars ?? 3000;
  const blocks = entries.map((e) => block(e, toolInputChars, toolResultChars));
  const turns = entries.filter((e) => e.kind === "user").length;
  const sep = "\n\n";
  let total = blocks.reduce((n, b) => n + b.length + sep.length, 0);
  if (total <= opts.maxChars) return { text: blocks.join(sep), turns, omitted: 0 };

  const firstUser = entries.findIndex((e) => e.kind === "user");
  const head = firstUser >= 0 ? [blocks[firstUser]] : [];
  const tail = blocks.slice(firstUser + 1);
  total = head.reduce((n, b) => n + b.length + sep.length, 0) + tail.reduce((n, b) => n + b.length + sep.length, 0);
  let dropped = Math.max(0, firstUser); // anything before the first user message
  while (tail.length > 1 && total > opts.maxChars) {
    total -= (tail.shift() as string).length + sep.length;
    dropped++;
  }
  const marker = `[… ${dropped} earlier entries omitted to fit the summarizer's window …]`;
  return { text: [...head, marker, ...tail].join(sep), turns, omitted: dropped };
}
