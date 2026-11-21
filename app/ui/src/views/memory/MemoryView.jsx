import { useEffect, useMemo, useState } from "react";
import { useProfile, ensureProfileLoaded } from "../../state/profileStore.js";
import { useUserMemories, ensureUserMemoriesLoaded, pendingMemories } from "../../state/userMemoryStore.js";
import { setMemoryViewing, setMemoryPage, useMemoryPage } from "../../state/memoryViewStore.js";
import { memoryFilters } from "../../lib/memoryGroups.js";
import { ProfileAvatar } from "../../components/profile/ProfileAvatar.jsx";
import { AboutYou } from "../eos/memory/AboutYou.jsx";
import { DreamLog } from "./DreamLog.jsx";

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// The Memory view — what agents know about the user. Takes over the Agents main
// area like Archive does, while Eos is hidden (hooks/useOpenMemory.js); the
// panes underneath stay as they were.
export function MemoryView() {
  const memState = useUserMemories();
  const { memories } = memState;
  const { profile } = useProfile();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const page = useMemoryPage();

  useEffect(() => { ensureUserMemoriesLoaded(); ensureProfileLoaded(); }, []);

  const pending = pendingMemories(memState);
  const keptCount = useMemo(() => memoryFilters(memories)[0].count, [memories]);

  return (
    <div className="mem-view">
      <div className="pane-head pane-head--topleft pane-head--topright">
        <span className="pane-head-inset" aria-hidden="true" />
        <div className="crumb">
          {page === "log"
            ? <><button type="button" className="mem-crumb-link" onClick={() => setMemoryPage("memory")}>Memory</button><span className="scope">/</span><span className="cur">Dream log</span></>
            : <span className="cur">Memory</span>}
        </div>
        <button type="button" className="pane-close mem-view__close" aria-label="Close memory" title="Close" onClick={() => setMemoryViewing(false)}>
          <CloseIcon />
        </button>
      </div>

      <div className="mem-view__scroll">
        {page === "log" ? (
          <div className="mem-view__inner"><h1 className="mem-head__title">Dream log</h1><DreamLog /></div>
        ) : (
        <div className="mem-view__inner">
          <header className="mem-head">
            <div className="mem-head__text">
              <span className="mem-head__crumb"><ProfileAvatar profile={profile} size={20} />Profile · Memory</span>
              <h1 className="mem-head__title">What your agents know about you</h1>
              <span className="mem-head__stats">
                <span><b>{keptCount}</b> kept</span>
                {pending.length > 0 && <span><b>{pending.length}</b> waiting for you</span>}
              </span>
            </div>
            <div className="mem-head__actions">
              <label className="mem-search">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
                <input aria-label="Search memories" placeholder="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <button type="button" className="mem-btn mem-btn--solid" onClick={() => setAdding(true)}>Add memory</button>
            </div>
          </header>

          <AboutYou query={query} adding={adding} onAddDone={() => setAdding(false)} />
        </div>
        )}
      </div>
    </div>
  );
}
