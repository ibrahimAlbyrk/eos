// Compute context-window usage given a worker row. Window sizes come from
// the model catalog (lib/models.js, fed by GET /v1/models) — the same source
// the picker's "200k"/"1M" label uses, so the two can never disagree.

import { modelCtxTokens } from "./models.js";

const FALLBACK_MAX = 200_000;

export function maxForModel(model) {
  return modelCtxTokens(model) ?? FALLBACK_MAX;
}

export function contextUsage(worker, model, lastUsage) {
  // Context window = last turn's input tokens (Claude re-reads the full
  // context each turn). Falls back to cumulative tokens_in if no usage
  // event is available yet.
  const used = lastUsage
    ? (lastUsage.in ?? 0) + (lastUsage.cacheRead ?? 0)
    : (worker?.tokens_in ?? 0);
  const total = maxForModel(model ?? worker?.model);
  const pct = Math.min(100, Math.round((used / total) * 100));
  return { used, total, pct };
}
