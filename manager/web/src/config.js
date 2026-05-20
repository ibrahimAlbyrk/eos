// Centralized UI configuration. Tweak here instead of hunting through code.
// Future: load overrides from /api/ui-config so the daemon can ship defaults
// and the user can override via ~/.claude-mgr/ui.json.

export const CONFIG = {
  // Live data layer
  pollFallbackMs: 4000,           // safety-net poll when SSE quiet
  refetchDebounceMs: 80,          // coalesce SSE bursts before refetching
  eventsPerWorkerLimit: 400,      // max events fetched per worker per poll
  maxEventHistory: 300,           // global event list cap shown in UI
  cachePerWorkerCap: 800,         // in-memory event cache cap per worker

  // Activity histogram
  activityBuckets: 24,            // 24 buckets × 60s = 24 minute window
  activityBucketMs: 60_000,

  // UI tick — drives elapsed/cost counters between polls
  elapsedTickMs: 500,

  // Model & budget defaults (mirror daemon's price table)
  defaultModel: "claude-opus-4.5",
  modelBudgets: {
    opus: 1_000_000,
    sonnet: 1_000_000,
    haiku: 200_000,
    default: 200_000,
  },

  // Spawn modal presets
  spawnModels: ["opus", "sonnet", "haiku"],

  // Max depth walk when computing agent tree role
  maxAgentTreeDepth: 8,
};
