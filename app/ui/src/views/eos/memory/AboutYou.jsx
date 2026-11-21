import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../../../state/settings.jsx";
import { useProfile, ensureProfileLoaded } from "../../../state/profileStore.js";
import { useProjects, refreshProjects } from "../../../state/projectsStore.js";
import { useUserMemories, ensureUserMemoriesLoaded, pendingMemories } from "../../../state/userMemoryStore.js";
import { setMemoryPage, useMemoryPage } from "../../../state/memoryViewStore.js";
import { useDreams, ensureDreamStatusLoaded } from "../../../state/dreamStore.js";
import { memoryFilters, memoryGroups, projectLabel } from "../../../lib/memoryGroups.js";
import { dreamProposals, isAgentSuggestion } from "../../../lib/dreamProposals.js";
import { SuggestionInbox } from "../../memory/SuggestionInbox.jsx";
import { MemoryItem } from "../../memory/MemoryItem.jsx";
import { MemoryComposer } from "../../memory/MemoryComposer.jsx";
import { MemoryRail } from "../../memory/MemoryRail.jsx";
import { DreamJournal } from "../../memory/DreamJournal.jsx";
import { DreamingNow } from "../../memory/DreamingCard.jsx";
import { DreamLog } from "../../memory/DreamLog.jsx";

// What agents know about the user: the memories kept in About you, what waits
// for a yes, dreaming, and the prompt budget. The Agents takeover
// (views/memory/MemoryView.jsx) and Eos › Memory › About you both draw it;
// each owns the search and the "Add memory" button above it.
export function AboutYou({ query, adding, onAddDone }) {
  const memState = useUserMemories();
  const { memories, error } = memState;
  const { profile } = useProfile();
  const { projects, loaded: projectsLoaded } = useProjects();
  const { openSettings } = useSettings();
  const [filter, setFilter] = useState("all");
  const { status: dreamStatus } = useDreams();

  useEffect(() => { ensureUserMemoriesLoaded(); ensureProfileLoaded(); ensureDreamStatusLoaded(); }, []);
  useEffect(() => { if (!projectsLoaded) void refreshProjects(); }, [projectsLoaded]);

  const pending = pendingMemories(memState);
  const proposals = useMemo(() => dreamProposals(memories), [memories]);
  const suggestions = useMemo(() => pending.filter(isAgentSuggestion), [pending]);
  const groups = useMemo(() => memoryGroups(memories, { query, filter }), [memories, query, filter]);
  const filters = useMemo(() => memoryFilters(memories), [memories]);
  const keptCount = filters[0].count;
  const projectChoices = useMemo(() => {
    const folders = new Set([
      ...projects.map((p) => p.folders?.[0]).filter(Boolean),
      ...(memories ?? []).filter((m) => m.scope.kind === "project").map((m) => m.scope.path),
    ]);
    return [...folders].sort().map((f) => ({ value: f, label: projectLabel(f) }));
  }, [projects, memories]);
  const stamp = `${profile?.rev}|${(memories ?? []).map((m) => `${m.id}${m.rev}${m.status}`).join()}`;

  return (
    <>
      {error && <div className="mem-error">{error}</div>}
      {adding && <MemoryComposer projects={projectChoices} onDone={onAddDone} />}
      <DreamingNow />
      <DreamJournal proposals={proposals} memories={memories} lastRun={dreamStatus?.lastRun} />
      <SuggestionInbox pending={suggestions} />

      {keptCount > 0 && (
        <nav className="stg-chips mem-filters" aria-label="Filter">
          {filters.map((f) => (
            <button key={f.key} type="button" className={`stg-chip${filter === f.key ? " is-on" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} <span className="mono mem-filters__count">{f.count}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="mem-body">
        <div className="mem-groups">
          {memories && keptCount === 0 && !pending.length && (
            <div className="mem-empty">
              <b>Nothing remembered yet.</b>
              <span>Add what agents should always know, or let them suggest it as you work — you approve each one.</span>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.key} className="mem-group">
              <header className="mem-group__head">
                <h2>{g.label}</h2>
                {g.project && <span className="mem-group__scope mono" title={g.project}>project</span>}
                <span className="mem-group__count mono">{g.items.length}</span>
              </header>
              <ul className="mem-group__list">
                {g.items.map((m) => <MemoryItem key={m.id} memory={m} />)}
              </ul>
            </section>
          ))}
        </div>
        <MemoryRail rev={stamp} onOpenProfile={() => openSettings("profile")} />
      </div>
    </>
  );
}

// Eos › Memory › About you: the memories with a search and "Add memory", or
// the dream log the journal opens. Leaving it goes back to the memories.
export function AboutYouTab() {
  const page = useMemoryPage();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  useEffect(() => () => setMemoryPage("memory"), []);

  if (page === "log") {
    return (
      <div className="mem-view__inner eos-mem-about">
        <button type="button" className="eos-link" onClick={() => setMemoryPage("memory")}>Back to About you</button>
        <h2 className="eos-label">Dream log</h2>
        <DreamLog />
      </div>
    );
  }
  return (
    <div className="mem-view__inner eos-mem-about">
      <div className="eos-mem-about__bar">
        <input className="eos-mem-search" aria-label="Search memories" placeholder="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="eos-btn" onClick={() => setAdding(true)}>Add memory</button>
      </div>
      <AboutYou query={query} adding={adding} onAddDone={() => setAdding(false)} />
    </div>
  );
}
