import { useState } from "react";
import { parseHistory, recallUp, recallDown, commit, HISTORY_MAX } from "../lib/inputHistory.js";

const STORAGE_KEY = "cm:inputHistory";
const LEGACY_TERM_KEY = "cm:termHistory";

// One-time merge of the pre-unification terminal pool. Relative chronology
// across the two pools is unknown, so term entries append below (treated as
// older); the old key is removed after the merged write.
function loadEntries() {
  try {
    const entries = parseHistory(localStorage.getItem(STORAGE_KEY));
    const legacyRaw = localStorage.getItem(LEGACY_TERM_KEY);
    if (legacyRaw === null) return entries;
    const term = parseHistory(legacyRaw).map((e) => ({ ...e, mode: "term" }));
    const merged = [...entries, ...term].slice(0, HISTORY_MAX);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      localStorage.removeItem(LEGACY_TERM_KEY);
    } catch { /* quota/private mode — merge retries next load */ }
    return merged;
  } catch {
    return [];
  }
}

export function useInputHistory() {
  const [entries, setEntries] = useState(loadEntries);
  const [cursor, setCursor] = useState({ index: null, origin: null });

  const up = (current) => {
    const r = recallUp({ entries, ...cursor }, current);
    setCursor({ index: r.index, origin: r.origin });
    return r.recalled;
  };

  const down = (current) => {
    const r = recallDown({ entries, ...cursor }, current);
    setCursor({ index: r.index, origin: r.origin });
    return r.recalled;
  };

  const push = (entry) => {
    const next = commit(entries, entry);
    if (next !== entries) {
      setEntries(next);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota/private mode */ }
    }
    setCursor({ index: null, origin: null });
  };

  // pos counts down toward the oldest entry: newest = total/total, oldest = 1/total
  const nav = cursor.index === null
    ? null
    : { pos: entries.length - cursor.index, total: entries.length, entry: entries[cursor.index] };

  return { up, down, push, nav };
}
