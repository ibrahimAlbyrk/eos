// Context compaction — the pure decisions: when an idle worker is due, how much
// transcript the summarizer may read, and what text survives from its answer.

import { computeContextPct } from "./context-usage.ts";

/** Rough chars-per-token for mixed prose/code; only used for budgets and estimates. */
const CHARS_PER_TOKEN = 3.5;
/** Share of the summarizer model's window the rendered transcript may take — the
 *  rest is left for the instructions and the summary it writes. */
const TRANSCRIPT_WINDOW_SHARE = 0.6;
const FALLBACK_WINDOW = 200_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function transcriptCharBudget(contextWindow: number | null): number {
  return Math.floor((contextWindow ?? FALLBACK_WINDOW) * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN);
}

/** Auto-compaction is due when enabled and the occupancy is at/over threshold.
 *  An unknown window never triggers (fail-open, like the threshold watcher). */
export function isCompactionDue(input: { enabled: boolean; threshold: number; used: number; limit: number | null }): boolean {
  if (!input.enabled || input.used <= 0) return false;
  const pct = computeContextPct(input.used, input.limit);
  return pct != null && pct >= input.threshold * 100;
}

/**
 * The summary the agent continues from. The summarizer is asked for an
 * <analysis> scratchpad followed by a <summary> block; only the summary is kept.
 * A missing <summary> tag falls back to the whole answer minus any analysis.
 */
export function extractSummary(raw: string): string {
  const tagged = [...raw.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].at(-1)?.[1];
  if (tagged != null) return tagged.trim();
  return raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
}
