import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../../state/settings.jsx";
import { useProfile, ensureProfileLoaded } from "../../state/profileStore.js";
import { useProjects, refreshProjects } from "../../state/projectsStore.js";
import { useUserMemories, ensureUserMemoriesLoaded, pendingMemories } from "../../state/userMemoryStore.js";
import { setMemoryViewing } from "../../state/memoryViewStore.js";
import { memoryFilters, memoryGroups, projectLabel } from "../../lib/memoryGroups.js";
import { ProfileAvatar } from "../../components/profile/ProfileAvatar.jsx";
import { SuggestionInbox } from "./SuggestionInbox.jsx";
import { MemoryItem } from "./MemoryItem.jsx";
import { MemoryComposer } from "./MemoryComposer.jsx";
import { MemoryRail } from "./MemoryRail.jsx";

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// The Memory view — what agents know about the user. Takes over the Agents main
// area like Archive does; the panes underneath stay as they were.
export function MemoryView() {
  const memState = useUserMemories();
  const { memories, error } = memState;
  const { profile } = useProfile();
  const { projects, loaded: projectsLoaded } = useProjects();
  const { openSettings } = useSettings();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);

  useEffect(() => { ensureUserMemoriesLoaded(); ensureProfileLoaded(); }, []);
  useEffect(() => { if (!projectsLoaded) void refreshProjects(); }, [projectsLoaded]);

  const pending = pendingMemories(memState);
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
    <div className="mem-view">
      <div className="pane-head pane-head--topleft">
        <span className="pane-head-inset" aria-hidden="true" />
        <div className="crumb"><span className="cur">Memory</span></div>
        <button type="button" className="pane-close mem-view__close" aria-label="Close memory" title="Close" onClick={() => setMemoryViewing(false)}>
          <CloseIcon />
        </button>
      </div>

      <div className="mem-view__scroll">
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

          {error && <div className="mem-error">{error}</div>}
          {adding && <MemoryComposer projects={projectChoices} onDone={() => setAdding(false)} />}
          <SuggestionInbox pending={pending} />

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
        </div>
      </div>
    </div>
  );
}
