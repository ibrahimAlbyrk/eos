// auto-name MicroTask — names a freshly-spawned ORCHESTRATOR once, from its
// first request, via the one-shot Haiku path. Fires on the orchestrator's first
// WORKING transition (the runner's seen-guard keeps it to once); gated to
// is_orchestrator rows whose name is still the random default (name_source=
// 'default'); CAS-writes so it can NEVER clobber a human ('user') name —
// invariant I1. Fail-closed: a non-nameable request skips the LLM call, and any
// sentinel/refusal/echo/garbage model output aborts — in every case the default
// name stays.

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

// The in-band sentinel the model emits when a request can't be named; treated as
// "no name" by interpretModelOutput (the default survives).
export const NO_TITLE_SENTINEL = "NO_TITLE";

// Pre-call nameability thresholds. A request below any of these is unnameable —
// extract returns null so the runner never spends an LLM call on it.
export const MIN_CHARS = 6;
export const MIN_WORDS = 2;
export const MIN_DISTINCT_LETTERS = 3;
// A first line longer than this many words is answer-shaped, not a topic label.
export const MAX_TOPIC_WORDS = 6;
// Below this word count, a model line matches the prompt's requested 2-4 word
// shape and is exempt from the echo check below — a short distilled topic can
// legitimately open with the same words as the request (e.g. "Pending
// Permission Tool" from a request that leads with "pending permission
// tool'u..."). Only the 5-6 word parrot-shaped zone (lines >MAX_TOPIC_WORDS
// are already rejected separately) is subject to the common-prefix check.
export const ECHO_CHECK_MIN_WORDS = 5;

const SUFFIX = "Orchestrator";
const MAX_TOPIC_CHARS = 48;
// First-turn events are few; cap the scan so a long-lived orchestrator's history
// is never fully loaded just to read its opening request.
const EVENT_SCAN_LIMIT = 500;

// Refusal / preamble openings that mean the model answered instead of naming.
const REFUSAL_RE = /\b(sorry|i can'?t|i am unable|as an ai|here'?s|sure,)\b/i;

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
      const userInput = readUserInput(deps, ctx.entityId);
      if (userInput == null) return null; // nothing to name from → abort
      if (!isNameable(userInput)) return null; // unnameable → skip the LLM call
      return { USER_INPUT: truncate(userInput, deps.cfg().charLimit) };
    },
    async apply(ctx: MicroTaskContext, output: string) {
      // Re-derive the request the model saw, from the same path extract used, so
      // the echo check can reject a model that just parroted the input back.
      const userInput = readUserInput(deps, ctx.entityId) ?? "";
      const name = interpretModelOutput(output, userInput);
      if (!name) return; // sentinel / refusal / echo / garbage → leave the default
      if (deps.workers.updateNameIfSource(ctx.entityId, name, "default", "auto")) {
        deps.bus.publish("worker:change", { workerId: ctx.entityId });
      }
    },
  };
}

// The opening request, read from the same events.list + firstUserMessage path
// extract and apply both use. null when the worker has no user message yet.
function readUserInput(deps: AutoNameDeps, entityId: string): string | null {
  const rows = deps.events.list({ workerId: entityId, since: 0, limit: EVENT_SCAN_LIMIT, order: "asc" });
  return firstUserMessage(rows);
}

// Deterministic pre-call gate: is this request substantial enough to name at all?
// Rejects greetings, single-word prompts, gibberish, and symbol-only input before
// any LLM call. \p{L} counts non-ASCII letters so Turkish input is nameable.
export function isNameable(userInput: string): boolean {
  const trimmed = userInput.trim();
  if (trimmed.length < MIN_CHARS) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  const words = trimmed.match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  if (words.length < MIN_WORDS) return false;
  const distinct = new Set((trimmed.toLowerCase().match(/\p{L}/gu) ?? []));
  if (distinct.size < MIN_DISTINCT_LETTERS) return false;
  return true;
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

// Validate an untrusted model line into a safe "<Topic> Orchestrator" name, or
// null when it isn't a real topic. Layers, in order: (1) first non-empty line +
// control/quote/markdown scrub; (2) the NO_TITLE sentinel; (3) a refusal/preamble
// opener; (4) for lines at/above ECHO_CHECK_MIN_WORDS, a near-verbatim echo of
// the request; (5) an answer-shaped (too many words) line; (6) the structural
// title-case + suffix + clamp step.
export function interpretModelOutput(raw: string, userInput: string): string | null {
  const line = firstScrubbedLine(raw);
  if (!line) return null;
  if (line === NO_TITLE_SENTINEL) return null;
  if (REFUSAL_RE.test(line)) return null;
  const wordCount = line.split(/\s+/).filter(Boolean).length;
  if (wordCount >= ECHO_CHECK_MIN_WORDS && isEcho(line, userInput)) return null;
  if (wordCount > MAX_TOPIC_WORDS) return null;
  return structureName(line) || null;
}

// First non-empty line, stripped of control chars, wrapping quotes/backticks/
// markdown emphasis, and trailing punctuation. "" when nothing usable remains.
function firstScrubbedLine(raw: string): string {
  let s = (raw.replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l.length > 0)) ?? "";
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  // Strip wrapping quotes / backticks / markdown emphasis, repeatedly.
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^["'`*_#>\s]+/, "").replace(/["'`*_\s]+$/, "");
  }
  return s.replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim();
}

// Structural step: title-case the scrubbed line, clamp to 48 chars on a word
// boundary, and guarantee exactly one trailing "Orchestrator". "" if the line
// carries no real topic (e.g. the bare suffix).
function structureName(s: string): string {
  const words = clampWords(s.split(" ").filter(Boolean).map(titleCaseWord), MAX_TOPIC_CHARS);
  if (words.length === 0) return "";
  if (words[words.length - 1].toLowerCase() === SUFFIX.toLowerCase()) {
    words[words.length - 1] = SUFFIX;
  } else {
    words.push(SUFFIX);
  }
  const name = words.join(" ");
  // The model gave nothing but the suffix → not a real name.
  return name === SUFFIX ? "" : name;
}

// True when the model line is a near-verbatim echo of the request rather than a
// distilled topic — compared on lowercased alphanumerics, flagged when they share
// a long common prefix (the model reproduced the request from its start). Only
// called for lines at/above ECHO_CHECK_MIN_WORDS: a short (≤4 word) line is the
// requested distilled-topic shape and may legitimately open with the request's
// own words when the request itself leads with the topic, so it's exempt.
// (Substring containment is deliberately NOT an echo signal: a real distilled
// topic like "Kafka Consumer" often appears verbatim inside the request.)
function isEcho(line: string, userInput: string): boolean {
  const a = normalizeAlnum(line);
  const b = normalizeAlnum(userInput);
  if (!a || !b) return false;
  return commonPrefixLen(a, b) > 12;
}

function normalizeAlnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
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
