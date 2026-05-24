// Compute context-window usage given a worker row + UI config models map.
// We don't have authoritative per-model max-tokens in the daemon config; use
// a model-name heuristic mapped to known Claude context windows.

const FALLBACK_MAX = 200_000;

const MAX_BY_FAMILY = {
  opus:   1_000_000,
  sonnet: 200_000,
  haiku:  200_000,
};

export function maxForModel(model) {
  if (!model) return FALLBACK_MAX;
  const m = String(model).toLowerCase();
  if (m.includes("1m") || m.includes("-1m")) return 1_000_000;
  if (m.includes("opus"))   return MAX_BY_FAMILY.opus;
  if (m.includes("sonnet")) return MAX_BY_FAMILY.sonnet;
  if (m.includes("haiku"))  return MAX_BY_FAMILY.haiku;
  return FALLBACK_MAX;
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
