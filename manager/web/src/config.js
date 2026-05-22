// Centralized UI configuration. Defaults below are used at module load. The
// daemon publishes a subset at GET /api/ui-config; data.jsx fetches that on
// startup and `Object.assign`s the relevant fields into CONFIG so the running
// UI picks up server-side tuning without a rebuild.

export const CONFIG = {
  // Live data layer
  pollFallbackMs: 4000,           // safety-net poll when SSE quiet
  refetchDebounceMs: 80,          // coalesce SSE bursts before refetching
  // Per-request page size for the forward-pagination loop in data.jsx. The
  // loop keeps requesting pages while the previous page was full, so a small
  // value just means more round trips on first load — never lost events.
  eventsPerWorkerLimit: 2000,
  // Upper bound on cached events PER worker. Once exceeded, the oldest
  // entries are dropped FIFO. Long-running orchestrators would otherwise
  // grow unbounded across hours/days of work, eventually burning RAM and
  // making the global flatten in data.jsx degenerate quadratic-ish.
  maxCachedEventsPerWorker: 10_000,

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
