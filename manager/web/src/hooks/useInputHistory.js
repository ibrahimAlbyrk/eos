import { useState } from "react";
import { parseHistory, recallUp, recallDown, commit } from "../lib/inputHistory.js";

const STORAGE_KEY = "cm:inputHistory";

function loadEntries() {
  try {
    return parseHistory(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function useInputHistory() {
  const [entries, setEntries] = useState(loadEntries);
  const [index, setIndex] = useState(null);

  const up = (currentText) => {
    const r = recallUp({ entries, index }, currentText);
    setIndex(r.index);
    return r.recalled;
  };

  const down = (currentText) => {
    const r = recallDown({ entries, index }, currentText);
    setIndex(r.index);
    return r.recalled;
  };

  const push = (text) => {
    const next = commit(entries, text);
    if (next !== entries) {
      setEntries(next);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota/private mode */ }
    }
    setIndex(null);
  };

  // pos counts down toward the oldest entry: newest = total/total, oldest = 1/total
  const nav = index === null
    ? null
    : { pos: entries.length - index, total: entries.length, entry: entries[index] };

  return { up, down, push, nav };
}
