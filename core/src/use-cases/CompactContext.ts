// CompactContext — replace an idle agent's context with a summary of it.
//
//   1. WORKING (reason "compaction") so dashboard sends queue behind it, and a
//      compaction_started marker so the UI can begin its animation.
//   2. Read the live transcript, render it within the summarizer's budget and
//      ask a tool-less summarizer (on the agent's own model) for a summary.
//   3. Only once a summary exists: restart the session seeded with it (the seed
//      runs no turn; it rides along with the next real message), set the
//      occupancy estimate, append compaction_completed.
//   4. IDLE — the IDLE edge drains anything queued meanwhile.
//
// Any failure before step 3 leaves the old session untouched and records
// compaction_failed; the worker still returns to IDLE.

import type { CompactionTrigger, WorkerEventType } from "../../../contracts/src/events.ts";
import type { AgentBackendRegistry, AgentSession } from "../ports/AgentBackend.ts";
import type { ConversationSummarizer } from "../ports/ConversationSummarizer.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { Logger } from "../ports/Logger.ts";
import { transitionState, type TransitionStateDeps } from "./TransitionState.ts";
import { computeContextPct } from "../domain/context-usage.ts";
import { estimateTokens, extractSummary, transcriptCharBudget } from "../domain/compaction.ts";
import { renderTranscript } from "../domain/transcript.ts";

export interface CompactContextDeps extends TransitionStateDeps {
  backends: AgentBackendRegistry;
  summarizer: ConversationSummarizer;
  prompts: PromptRenderer;
  contextWindowFor(model: string | null | undefined): number | null;
  timeoutMs(): number;
  /** Re-arm the 90%/95% context watcher latches — occupancy just dropped. */
  rearmContextMarks?(workerId: string): void;
  log: Logger;
}

export interface CompactContextInput {
  workerId: string;
  trigger: CompactionTrigger;
  /** Free text after `/compact` — what the summary should focus on. */
  instructions?: string;
}

export type CompactContextResult =
  | { ok: true; beforeTokens: number; afterTokens: number; turns: number }
  | { ok: false; error: string };

export function compactionSession(deps: Pick<CompactContextDeps, "backends">, workerId: string, backendKind: string | null): AgentSession | null {
  const kind = backendKind ?? "claude";
  if (!deps.backends.has(kind)) return null;
  const backend = deps.backends.get(kind);
  if (backend.descriptor.processModel !== "in-process") return null;
  const session = backend.attach(workerId, { kind: "inproc", ref: workerId });
  return session.capabilities.contextCompaction === true && session.isAlive() ? session : null;
}

export async function compactContext(deps: CompactContextDeps, input: CompactContextInput): Promise<CompactContextResult> {
  const { workerId, trigger } = input;
  const instructions = input.instructions?.trim() || undefined;
  const w = deps.workers.findById(workerId);
  if (!w) return { ok: false, error: "worker not found" };
  const session = compactionSession(deps, workerId, w.backend_kind ?? null);
  if (!session?.readTranscript || !session.replaceContext) return { ok: false, error: "this agent cannot be compacted" };
  if (transitionState(deps, { workerId, next: "WORKING", reason: "compaction" }) === "rejected") {
    return { ok: false, error: `cannot compact from state ${w.state}` };
  }

  const started = deps.clock.now();
  const beforeTokens = w.last_context_tokens ?? 0;
  const limit = deps.contextWindowFor(w.model);
  const pct = computeContextPct(beforeTokens, limit);
  record(deps, workerId, "compaction_started", { trigger, beforeTokens, pct, ...(instructions ? { instructions } : {}) });

  try {
    const transcript = await session.readTranscript();
    if (!transcript || transcript.entries.length === 0) throw new Error("nothing to compact yet");
    const rendered = renderTranscript(transcript.entries, { maxChars: transcriptCharBudget(limit) });
    const raw = await deps.summarizer.summarize({
      system: deps.prompts.render("compaction/summarizer-system"),
      prompt: deps.prompts.render("compaction/summarize", { TRANSCRIPT: rendered.text, INSTRUCTIONS: instructions ?? "" }),
      model: w.model ?? null,
      timeoutMs: deps.timeoutMs(),
    });
    const summary = extractSummary(raw);
    if (!summary) throw new Error("the summarizer returned an empty summary");

    // The agent may have been stopped while the summarizer ran — never revive it.
    const now = deps.workers.findById(workerId);
    if (!now || String(now.state).toUpperCase() !== "WORKING" || !session.isAlive()) throw new Error("agent stopped during compaction");

    const seed = deps.prompts.render("compaction/continuation", { SUMMARY: summary, TRANSCRIPT_PATH: transcript.path ?? "" });
    const replaced = await session.replaceContext(seed);
    if (!replaced.ok) throw new Error(replaced.reason ?? "could not restart the session");

    const afterTokens = estimateTokens(seed);
    deps.workers.setContextTokens(workerId, afterTokens);
    deps.rearmContextMarks?.(workerId);
    record(deps, workerId, "compaction_completed", {
      trigger, beforeTokens, afterTokens, pct, turns: rendered.turns, summary,
      durationMs: deps.clock.now() - started, ...(instructions ? { instructions } : {}),
    });
    deps.log.info("context compacted", { workerId, trigger, beforeTokens, afterTokens, turns: rendered.turns, omitted: rendered.omitted });
    return { ok: true, beforeTokens, afterTokens, turns: rendered.turns };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record(deps, workerId, "compaction_failed", { trigger, error });
    deps.log.warn("context compaction failed", { workerId, trigger, error });
    return { ok: false, error };
  } finally {
    // Only settle what we lifted: a stop/kill mid-compaction owns the state now.
    if (String(deps.workers.findById(workerId)?.state ?? "").toUpperCase() === "WORKING") {
      transitionState(deps, { workerId, next: "IDLE", reason: "compaction" });
    }
  }
}

function record(deps: CompactContextDeps, workerId: string, type: WorkerEventType, payload: Record<string, unknown>): void {
  const rowId = deps.events.append(workerId, deps.clock.now(), type, payload);
  deps.bus.publish("worker:change", { workerId, rowId });
}
