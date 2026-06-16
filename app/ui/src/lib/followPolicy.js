// Pure policy for "Follow" mode — which orchestrator the split fans out and which
// of its children fill the panes. No React, no DOM: a function of the flat
// WorkerRow[] (live.workers), so it's fully unit-testable. The pane provider's
// reconcileFollow turns this into a layout via fanoutLayout + reuseLeafIds.
import { isRunning } from "./agentActivity.js";

// The orchestrator whose fanout should show for this selection: the selection
// itself when it's an orchestrator, or its DIRECT parent when that's one. null
// otherwise (a grandchild, or a child of a non-orchestrator) — follow-mode then
// goes DORMANT and shows that agent alone instead of snapping to a distant
// ancestor. One level only (not a full climb) on purpose: picking a deep
// descendant means "take me there", not "fan out its grandparent".
export function followAnchorId(workers, selectedId) {
  if (!selectedId) return null;
  const byId = new Map(workers.map((w) => [w.id, w]));
  const w = byId.get(selectedId);
  if (!w) return null;
  if (w.is_orchestrator) return selectedId;
  const parent = w.parent_id ? byId.get(w.parent_id) : null;
  return parent && parent.is_orchestrator ? parent.id : null;
}

// A child is showable while it's alive enough to have a live transcript. DONE /
// SUSPENDED / ENDING / KILLING are "closed" → dropped from the split.
const ELIGIBLE = new Set(["SPAWNING", "WORKING", "IDLE"]);

// The ordered, capped child ids that should occupy the panes. Priority-fill with
// stable slots:
//   - keep currently-shown children in their slot (minimal reflow);
//   - a running newcomer RECYCLES a shown idle slot in place (from the end, so
//     the earliest panes stay put) instead of growing the grid — this is why a
//     fresh worker reuses an idle pane rather than opening a new split;
//   - only then append leftover newcomers running-first, then by started_at;
//   - when over capacity, keep the highest-priority `capacity` (running beats
//     idle, stable tiebreak on slot order) so a newly-running child evicts the
//     lowest-priority idle one — never a running one;
//   - `pinnedId` (the agent you're viewing) is never recycled and always kept if
//     eligible, so a background spawn can't evict it from under you.
// A pure-state flip that recycles nothing yields the SAME list as currentChildIds,
// which lets the reconciler no-op (no rebuild, no remount).
export function selectFollowChildren(workers, orchId, currentChildIds, capacity, pinnedId, includeIdle = true) {
  if (!orchId || capacity <= 0) return [];
  const byId = new Map(workers.map((w) => [w.id, w]));
  const isEligible = (w) => !!w && w.parent_id === orchId && ELIGIBLE.has(w.state);

  const eligible = workers.filter(isEligible);
  const eligibleIds = new Set(eligible.map((w) => w.id));

  const kept = currentChildIds.filter((id) => eligibleIds.has(id));
  const keptSet = new Set(kept);
  // Idle children JOIN the fanout only on a (re)populate (includeIdle) — when the
  // anchor changes or follow is (re)engaged. On steady-state ticks includeIdle is
  // false, so an idle child the user already recycled OUT of a slot does NOT
  // re-enter as a newcomer and re-grow the grid (it's still a live IDLE worker, so
  // without this it would reappear every tick). Running children always join.
  const newcomers = eligible
    .filter((w) => !keptSet.has(w.id))
    .filter((w) => includeIdle || isRunning(w))
    .sort((a, b) => (isRunning(a) ? 0 : 1) - (isRunning(b) ? 0 : 1)
      || (a.started_at ?? 0) - (b.started_at ?? 0))
    .map((w) => w.id);

  // Recycle idle slots in place: a running newcomer takes the slot of a shown
  // IDLE child instead of opening a new pane (no grid growth). Walk slots from
  // the end so the earliest panes stay put; never recycle the pinned (viewed)
  // slot, and only running newcomers recycle (idle→idle would be pointless churn).
  const slots = [...kept];
  const queue = [...newcomers];
  for (let i = slots.length - 1; i >= 0 && queue.length; i--) {
    const occupant = byId.get(slots[i]);
    if (occupant?.state === "IDLE" && slots[i] !== pinnedId && isRunning(byId.get(queue[0]))) {
      slots[i] = queue.shift();
    }
  }

  const candidates = [...slots, ...queue];
  let result;
  if (candidates.length <= capacity) {
    result = candidates;
  } else {
    // Over capacity: keep the top `capacity` by priority (running 0, idle 1) with
    // a stable tiebreak on slot index, then restore candidates order.
    const priority = (id) => (isRunning(byId.get(id)) ? 0 : 1);
    const keep = new Set(
      candidates
        .map((id, i) => ({ id, p: priority(id), i }))
        .sort((a, b) => a.p - b.p || a.i - b.i)
        .slice(0, capacity)
        .map((x) => x.id),
    );
    result = candidates.filter((id) => keep.has(id));
  }

  if (pinnedId && eligibleIds.has(pinnedId) && !result.includes(pinnedId)) {
    result = [...result.slice(0, capacity - 1), pinnedId];
  }
  return result;
}
