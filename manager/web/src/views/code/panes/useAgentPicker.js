import { useCallback, useEffect, useMemo, useState } from "react";
import { nameOf } from "../../../lib/agentName.js";
import { statusFromState } from "../../../lib/format.js";

// Picker-local UI model for the empty-pane agent picker: shapes the candidate
// list from the live workers and owns the filter query + keyboard highlight.
// Deliberately knows nothing about panes — the overlay turns a chosen item into
// an action. State is component-local (never hoisted to the global UI store).
export function useAgentPicker(workers, excludeIds) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (workers ?? []).map((w) => ({
      id: w.id,
      label: nameOf(w),
      status: statusFromState(w.state),
      isOrchestrator: !!w.is_orchestrator,
      shown: excludeIds?.has(w.id) ?? false,
    }));
    const filtered = q
      ? list.filter((it) => it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
      : list;
    // Predictable order: orchestrators first, then alphabetical.
    return filtered.sort(
      (a, b) => Number(b.isOrchestrator) - Number(a.isOrchestrator) || a.label.localeCompare(b.label),
    );
  }, [workers, excludeIds, query]);

  // Keep the highlight in range as the list grows/shrinks with the filter.
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(i, 0), Math.max(items.length - 1, 0)));
  }, [items.length]);

  const moveBy = useCallback((delta) => {
    setActiveIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length));
  }, [items.length]);

  return { query, setQuery, items, activeIndex, setActiveIndex, moveBy };
}
