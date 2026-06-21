// auto-name MicroTask — names a freshly-spawned ORCHESTRATOR once, from its
// first request + first assistant output, via the one-shot Haiku path. Fires on
// the orchestrator's first WORKING transition (the runner's seen-guard keeps it
// to once); gated to is_orchestrator rows whose name is still the random default
// (name_source='default'); CAS-writes so it can NEVER clobber a human ('user')
// name — invariant I1. Fail-closed: any empty/garbage model output aborts and
// the default name stays.

import type { MicroTask, MicroTaskContext } from "../../../core/src/ports/MicroTask.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { EventRepo } from "../../../core/src/ports/EventRepo.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

export interface AutoNameDeps {
  workers: Pick<WorkerRepo, "findById" | "updateNameIfSource">;
  events: Pick<EventRepo, "list">;
  bus: Pick<EventBus, "publish">;
  // Live per-task config (config.microTasks.tasks["auto-name"]); only charLimit
  // is read here — delay/model/enabled are the runner's concern.
  cfg(): { charLimit: number };
}

const SUFFIX = "Orchestrator";
const MAX_TOPIC_CHARS = 48;
// First-turn events are few; cap the scan so a long-lived orchestrator's history
// is never fully loaded just to read its opening request + output.
const EVENT_SCAN_LIMIT = 500;

export function makeAutoNameTask(deps: AutoNameDeps): MicroTask {
  return {
    id: "auto-name",
    promptId: "micro-tasks/auto-name",
    trigger: {
      topic: "worker:change",
      match(payload) {
        const p = payload as { workerId?: unknown; from?: unknown; state?: unknown };
        // Only the entry INTO WORKING from a non-busy state — the orchestrator's
        // first output, whether it was born with a prompt (SPAWNING→WORKING) or
        // messaged later (IDLE→WORKING). The seen-guard limits it to the first.
        if (p?.state !== "WORKING") return null;
        if (p.from !== "SPAWNING" && p.from !== "IDLE") return null;
        return typeof p.workerId === "string" ? p.workerId : null;
      },
    },
    gate(ctx) {
      const row = deps.workers.findById(ctx.entityId);
      if (!row) return false;
      // is_orchestrator is a 0/1 column (not a boolean — the directive's `=== true`
      // would never match), so compare against 1. Only the random default name is
      // eligible; 'user'/'auto'/legacy-NULL rows are left alone.
      return row.is_orchestrator === 1 && row.name_source === "default";
    },
    async extract(ctx) {
      const limit = deps.cfg().charLimit;
      const rows = deps.events.list({ workerId: ctx.entityId, since: 0, limit: EVENT_SCAN_LIMIT, order: "asc" });
      const userInput = firstUserMessage(rows);
      if (userInput == null) return null; // nothing to name from → abort
      return {
        USER_INPUT: truncate(userInput, limit),
        FIRST_OUTPUT: truncate(firstAssistantText(rows), limit),
      };
    },
    async apply(ctx: MicroTaskContext, output: string) {
      const name = sanitizeName(output);
      if (!name) return; // empty/garbage → leave the default in place
      if (deps.workers.updateNameIfSource(ctx.entityId, name, "default", "auto")) {
        deps.bus.publish("worker:change", { workerId: ctx.entityId });
      }
    },
  };
}

function parsePayload(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function firstUserMessage(rows: WorkerEventRow[]): string | null {
  for (const r of rows) {
    if (r.type !== "user_message") continue;
    const p = parsePayload(r.payload) as { text?: unknown } | null;
    if (p && typeof p.text === "string" && p.text.trim()) return p.text;
  }
  return null;
}

// The opening assistant text — from a claude-sdk row (agent_event: a message with
// text blocks) or a claude-cli row (jsonl: kind 'assistant_text'). Returns "" when
// the worker hasn't produced output yet (the prompt tolerates an empty FIRST_OUTPUT).
function firstAssistantText(rows: WorkerEventRow[]): string {
  for (const r of rows) {
    if (r.type === "agent_event") {
      const p = parsePayload(r.payload) as { type?: unknown; role?: unknown; blocks?: unknown } | null;
      if (p && p.type === "message" && p.role === "assistant" && Array.isArray(p.blocks)) {
        const text = p.blocks
          .filter((b): b is { type: string; text: string } =>
            !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
          .map((b) => b.text)
          .join("");
        if (text.trim()) return text;
      }
    } else if (r.type === "jsonl") {
      const p = parsePayload(r.payload) as { kind?: unknown; text?: unknown } | null;
      if (p && p.kind === "assistant_text" && typeof p.text === "string" && p.text.trim()) return p.text;
    }
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

// Normalize a raw model line into a safe "<Topic> Orchestrator" name, or "" if
// there's nothing usable (caller then leaves the default). Defensive against
// quotes, markdown, control chars, trailing punctuation, and a missing/duplicate
// suffix — a safety net atop the prompt's own output contract.
function sanitizeName(raw: string): string {
  // First non-empty line only (ignore any trailing explanation the prompt forbids).
  let s = (raw.replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l.length > 0)) ?? "";
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  // Strip wrapping quotes / backticks / markdown emphasis, repeatedly.
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^["'`*_#>\s]+/, "").replace(/["'`*_\s]+$/, "");
  }
  s = s.replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim();
  if (!s) return "";

  const words = clampWords(s.split(" ").filter(Boolean).map(titleCaseWord), MAX_TOPIC_CHARS);
  if (words.length === 0) return "";

  // Ensure exactly one trailing "Orchestrator".
  if (words[words.length - 1].toLowerCase() === SUFFIX.toLowerCase()) {
    words[words.length - 1] = SUFFIX;
  } else {
    words.push(SUFFIX);
  }
  const name = words.join(" ");
  // The model gave nothing but the suffix → not a real name.
  return name === SUFFIX ? "" : name;
}

// Capitalize the first letter of each word (and hyphenated sub-word), preserving
// the rest — so a correctly-cased acronym ("API") survives instead of becoming "Api".
function titleCaseWord(w: string): string {
  return w.split("-").map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join("-");
}

// Keep whole words up to maxChars (word-boundary truncation). A single first word
// longer than the cap is hard-sliced so a runaway output can't become a giant name.
function clampWords(words: string[], maxChars: number): string[] {
  const out: string[] = [];
  let len = 0;
  for (const w of words) {
    const add = (out.length ? 1 : 0) + w.length;
    if (len + add > maxChars) break;
    out.push(w);
    len += add;
  }
  if (out.length === 0 && words.length) out.push(words[0].slice(0, maxChars));
  return out;
}
