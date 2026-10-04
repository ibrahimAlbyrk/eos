import { useEffect } from "react";
import { useUserMemories, ensureUserMemoriesLoaded, pendingMemories } from "../../state/userMemoryStore.js";
import { useOpenMemory } from "../../hooks/useOpenMemory.js";

// Settings › Profile → the Memory view: how many memories are kept and waiting.
export function MemoryGroup() {
  const state = useUserMemories();
  const openMemory = useOpenMemory();
  useEffect(() => { ensureUserMemoriesLoaded(); }, []);
  const kept = (state.memories ?? []).filter((m) => m.status === "active").length;
  const waiting = pendingMemories(state).length;

  return (
    <div className="stg-group">
      <div className="stg-group__title">Memory</div>
      <button type="button" className="stg-row prof-memory-link" onClick={openMemory}>
        <div className="stg-row__text">
          <div className="stg-row__label">Memories</div>
          <div className="stg-row__desc">
            {kept} kept{waiting ? ` · ${waiting} waiting for review` : ""} — facts agents remember about you
          </div>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}
