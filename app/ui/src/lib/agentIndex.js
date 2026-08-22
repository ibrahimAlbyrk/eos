// agentIndex — module map of agent id -> parent_id, refreshed from useLive's
// worker snapshots, so non-React code (pane transitions, browser session
// stores, toolbar badges) can resolve which SESSION an agent belongs to: the
// root of its parent chain (same walk as lib/breadcrumb.js, ids only). A
// dashboard "session" IS that root worker id; "global" is the no-session key
// (empty pane / nothing selected).

export const GLOBAL_SESSION = "global";

let parents = new Map(); // id -> parent_id | null
let names = new Map(); // id -> display label (see updateAgentNames)

export function updateAgentIndex(workers) {
  if (!Array.isArray(workers)) return;
  const next = new Map();
  for (const w of workers) if (w?.id) next.set(w.id, w.parent_id ?? null);
  parents = next;
}

// Keep id -> display name in step with the same snapshot, so non-React code can
// label a SESSION by its root (e.g. the present-fallback toast). The label is the
// sidebar/breadcrumb name (agentName.js nameOf): w.name, else "Orchestrator" for
// an orchestrator. A nameless worker is left OUT so callers fall back to a generic
// phrase rather than showing a raw id.
export function updateAgentNames(workers) {
  if (!Array.isArray(workers)) return;
  const next = new Map();
  for (const w of workers) {
    if (!w?.id) continue;
    const label = w.name || (w.is_orchestrator ? "Orchestrator" : null);
    if (label) next.set(w.id, label);
  }
  names = next;
}

// Human-readable label of the SESSION an agent belongs to (its parent-chain root),
// or null when the root has no known name — callers then use a generic fallback.
export function sessionNameOf(agentId) {
  return names.get(sessionRootOf(agentId)) ?? null;
}

// Root of the agent's parent chain — cycle-guarded, stopping at the last
// RESOLVABLE node exactly like breadcrumb.js (a parent id the index doesn't
// know ends the walk at its child). An unknown id resolves to itself (the
// daemon's rule); no agent resolves to the global session.
export function sessionRootOf(agentId) {
  if (!agentId) return GLOBAL_SESSION;
  const seen = new Set();
  let cur = agentId;
  while (!seen.has(cur)) {
    seen.add(cur);
    const parent = parents.get(cur);
    if (parent == null || !parents.has(parent)) return cur;
    cur = parent;
  }
  return cur;
}

// Test-only: reset the module singleton between cases.
export function _resetAgentIndex() {
  parents = new Map();
  names = new Map();
}
