// Pure transcript analysis for the rewind panel — the JSONL parse shared by both
// backend lanes (claude-cli reads the PTY session file, claude the SDK's
// transcript store). Zero Node imports: the caller supplies the already-read
// JSONL text; all fs/path reading stays in spawner and the manager backend.

import { activeBranchEntries, type ClaudeJsonlEntry } from "./claude-transcript.ts";

export interface RewindTarget {
  uuid: string;
  text: string;
  display: string;
  ts: string;
  upCount: number;
}

// ---- transcript walk -------------------------------------------------------

function promptText(e: ClaudeJsonlEntry): string | null {
  const m = e.message;
  if (!m || m.role !== "user" || e.isMeta === true) return null;
  let text: string;
  if (typeof m.content === "string") {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    const blocks = m.content as Array<{ type?: unknown; text?: unknown }>;
    const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
    // tool_result-only and image-only entries are not prompts in the TUI list.
    if (!texts.some((t) => t.trim() !== "")) return null;
    text = texts.join("\n");
  } else {
    return null;
  }
  if (text.trim() === "") return null;
  if (text.startsWith("[Request interrupted")) return null;
  if (text.startsWith("<local-command-stdout")) return null;
  return text;
}

function displayFor(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return text;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

interface ActivePrompt { uuid: string; parentUuid: string | null; text: string; ts: string; }

/**
 * User prompts on the transcript's ACTIVE branch, oldest first, each carrying its
 * parentUuid (the entry immediately before it on the branch). The JSONL is a
 * parentUuid DAG after rewinds — abandoned branches stay in the file — so we walk
 * back from the newest non-sidechain user/assistant entry and keep only user
 * entries on that chain. Must mirror what the TUI panel lists, or upCount
 * navigation drifts (the row needle verification catches drift).
 */
function activeBranchPrompts(jsonl: string): ActivePrompt[] {
  const prompts: ActivePrompt[] = [];
  for (const e of activeBranchEntries(jsonl)) {
    if (e.type !== "user" || typeof e.uuid !== "string") continue;
    const text = promptText(e);
    if (text === null) continue;
    prompts.push({
      uuid: e.uuid,
      parentUuid: typeof e.parentUuid === "string" ? e.parentUuid : null,
      text,
      ts: typeof e.timestamp === "string" ? e.timestamp : "",
    });
  }
  return prompts;
}

export function computeRewindTargets(jsonl: string): RewindTarget[] {
  const prompts = activeBranchPrompts(jsonl);
  return prompts.map((p, i) => ({
    uuid: p.uuid,
    text: p.text,
    display: displayFor(p.text),
    ts: p.ts,
    upCount: prompts.length - i,
  }));
}

/**
 * The fork slice point for rewinding to the user prompt `uuid`: the entry
 * immediately BEFORE it on the active branch (its parentUuid, typically the
 * preceding assistant message). Both lanes restore to the point BEFORE the
 * selected prompt — the CLI submenu confirms "restore to the point before you
 * sent this message" — and the SDK's forkSession slices up to and INCLUDING this
 * uuid, so slicing to the parent (not the prompt itself) drops the prompt and
 * everything after it. null when the prompt is the first on the branch (nothing
 * precedes it → fork empty / relaunch fresh) or unknown.
 */
export function rewindSliceAnchor(jsonl: string, uuid: string): string | null {
  const target = activeBranchPrompts(jsonl).find((p) => p.uuid === uuid);
  return target ? target.parentUuid : null;
}
