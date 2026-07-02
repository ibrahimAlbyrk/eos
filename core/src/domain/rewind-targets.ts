// Pure transcript analysis for the rewind panel — the JSONL parse shared by both
// backend lanes (claude-cli reads the PTY session file, claude-sdk the SDK's
// transcript store). Zero Node imports: the caller supplies the already-read
// JSONL text; all fs/path reading stays in spawner and the manager backend.

export interface RewindTarget {
  uuid: string;
  text: string;
  display: string;
  ts: string;
  upCount: number;
}

// ---- transcript walk -------------------------------------------------------

interface TranscriptEntry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function promptText(e: TranscriptEntry): string | null {
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
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as TranscriptEntry); } catch { /* torn line */ }
  }

  const byUuid = new Map<string, TranscriptEntry>();
  let tip: TranscriptEntry | null = null;
  for (const e of entries) {
    if (typeof e.uuid !== "string") continue;
    byUuid.set(e.uuid, e);
    if ((e.type === "user" || e.type === "assistant") && e.isSidechain !== true) tip = e;
  }
  if (!tip) return [];

  const onPath = new Set<string>();
  let cur: TranscriptEntry | null = tip;
  while (cur && typeof cur.uuid === "string" && !onPath.has(cur.uuid)) {
    onPath.add(cur.uuid);
    cur = typeof cur.parentUuid === "string" ? byUuid.get(cur.parentUuid) ?? null : null;
  }

  const prompts: ActivePrompt[] = [];
  for (const e of entries) {
    if (e.type !== "user" || typeof e.uuid !== "string" || !onPath.has(e.uuid)) continue;
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
