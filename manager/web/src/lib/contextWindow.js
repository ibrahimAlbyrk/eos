// Compute context-window usage given a worker row. Window sizes come from
// the model catalog (lib/models.js, fed by GET /v1/models) — the same source
// the picker's "200k"/"1M" label uses, so the two can never disagree.

import { modelCtxTokens } from "./models.js";

const FALLBACK_MAX = 200_000;

export function maxForModel(model) {
  return modelCtxTokens(model) ?? FALLBACK_MAX;
}

export function contextUsage(worker, model) {
  // Context window = last turn's full prompt footprint, daemon-stamped on the
  // worker row (in + cacheRead + cacheCreate; cache-cold turns report the
  // whole context as cacheCreate, not cacheRead). No event-scan fallback —
  // a busy turn's hook/jsonl tail used to push usage events out of any
  // fixed fetch window and collapse the ring to a garbage value.
  const used = worker?.last_context_tokens ?? 0;
  const total = maxForModel(model ?? worker?.model);
  const pct = Math.min(100, Math.round((used / total) * 100));
  return { used, total, pct };
}
