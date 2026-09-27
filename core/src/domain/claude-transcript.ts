// The claude session JSONL (~/.claude/projects/…/<session>.jsonl), read as a
// transcript. Pure: callers pass the already-read text. After rewinds the file
// is a parentUuid DAG with abandoned branches left in place, so everything here
// works on the ACTIVE branch only — the chain walked back from the newest
// non-sidechain user/assistant entry.

import type { TranscriptEntry } from "./transcript.ts";

export interface ClaudeJsonlEntry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Entries on the active branch, oldest first (file order). */
export function activeBranchEntries(jsonl: string): ClaudeJsonlEntry[] {
  const entries: ClaudeJsonlEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as ClaudeJsonlEntry); } catch { /* torn line */ }
  }

  const byUuid = new Map<string, ClaudeJsonlEntry>();
  let tip: ClaudeJsonlEntry | null = null;
  for (const e of entries) {
    if (typeof e.uuid !== "string") continue;
    byUuid.set(e.uuid, e);
    if ((e.type === "user" || e.type === "assistant") && e.isSidechain !== true) tip = e;
  }
  if (!tip) return [];

  const onPath = new Set<string>();
  let cur: ClaudeJsonlEntry | null = tip;
  while (cur && typeof cur.uuid === "string" && !onPath.has(cur.uuid)) {
    onPath.add(cur.uuid);
    cur = typeof cur.parentUuid === "string" ? byUuid.get(cur.parentUuid) ?? null : null;
  }
  return entries.filter((e) => typeof e.uuid === "string" && onPath.has(e.uuid));
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; content?: unknown; is_error?: unknown };

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input); } catch { return String(input); }
}

// Harness noise that is not conversation: interrupt markers and local slash-command echoes.
function isNoise(text: string): boolean {
  return text.startsWith("[Request interrupted") || text.startsWith("<local-command-stdout");
}

/** The active branch as lane-neutral transcript entries (thinking dropped). */
export function parseClaudeTranscript(jsonl: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const e of activeBranchEntries(jsonl)) {
    const m = e.message;
    if (!m || e.isMeta === true) continue;
    if (e.type === "user" && m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content.trim() && !isNoise(m.content)) out.push({ kind: "user", text: m.content });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Block[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !isNoise(b.text)) {
          out.push({ kind: "user", text: b.text });
        } else if (b.type === "tool_result") {
          out.push({ kind: "tool_result", text: resultText(b.content), isError: b.is_error === true });
        }
      }
    } else if (e.type === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content as Block[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({ kind: "assistant", text: b.text });
        } else if (b.type === "tool_use") {
          out.push({ kind: "tool_call", name: typeof b.name === "string" ? b.name : "tool", input: inputText(b.input) });
        }
      }
    }
  }
  return out;
}
