// Centralized UI configuration. Defaults below are used at module load. The
// daemon publishes a subset at GET /api/ui-config; data.jsx fetches that on
// startup and `Object.assign`s the relevant fields into CONFIG so the running
// UI picks up server-side tuning without a rebuild.

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

// Best-effort merge from daemon's /api/ui-config. Failures are silent — the
// UI keeps the built-in defaults if the endpoint isn't there yet.
export async function hydrateConfigFromDaemon() {
  try {
    const r = await fetch(`${location.origin}/api/ui-config`);
    if (!r.ok) return;
    const remote = await r.json();
    if (Array.isArray(remote.models) && remote.models.length > 0) {
      CONFIG.spawnModels = remote.models;
    }
    if (remote.budgets && typeof remote.budgets === "object") {
      Object.assign(CONFIG.modelBudgets, remote.budgets);
    }
  } catch {
    // Endpoint may be missing on older daemons — keep defaults.
  }
}
