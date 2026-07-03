// Single source of truth for context-window occupancy as a percentage. Mirrors
// the client-side math in app/ui/src/lib/contextWindow.js so the server-computed
// `context.pct` and the web usage ring can never disagree. Both the route
// enrichment and the threshold watcher read this.

export function computeContextPct(used: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}
