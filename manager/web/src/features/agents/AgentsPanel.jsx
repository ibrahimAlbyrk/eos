// Left-rail agent list. Owns the filter input + Cmd+K shortcut + the
// hierarchical multi-root walk that orders agents by orchestrator → its
// workers → next orchestrator. Empty states (no orchestrator yet, filter
// no match) are inline; the spawn flow is a separate feature.

import { memo, useState, useEffect, useMemo, useRef } from "react";
import { fmtCost } from "../../lib/format.js";
import { Icon } from "../../components/primitives.jsx";
import { AgentRow } from "./AgentRow.jsx";

export const AgentsPanel = memo(function AgentsPanel({ agents, selectedId, onSelect, onCollapse, online, onSpawnClick, session, onContextMenu }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);

  // ⌘K focuses the filter input.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) =>
      (a.name || "").toLowerCase().includes(q) ||
      (a.model || "").toLowerCase().includes(q) ||
      (a.id || "").toLowerCase().includes(q),
    );
  }, [agents, query]);

  const flat = useMemo(() => {
    if (query.trim()) return filtered;
    const out = [];
    // Multi-root walk: orchestrators are the roots (no parent), each
    // followed by its worker subtree. Orphan parent_id chains (worker whose
    // root isn't in this list) fall through to the leftovers loop below.
    const walk = (parentId) => {
      const kids = agents
        .filter((a) => (a.parent || null) === parentId)
        .sort((a, b) => (a.startedTs || 0) - (b.startedTs || 0));
      for (const k of kids) { out.push(k); walk(k.id); }
    };
    walk(null);
    for (const a of agents) if (!out.includes(a)) out.push(a);
    return out;
  }, [agents, filtered, query]);

  const hasOrch = agents.some((a) => a.isOrchestrator);

  return (
    <aside className="vb-agents">
      <div className="vb-agents__head">
        <div className="vb-agents__title-col">
          <div className="vb-agents__title">Agents</div>
          <div className="vb-agents__sub">{agents.length} in this session</div>
        </div>
        <div className="vb-agents__head-actions">
          <button className="vb-pillbtn vb-pillbtn--primary" onClick={onSpawnClick} title="Spawn a new agent (orchestrator or worker)">
            <Icon name="plus" size={13} />
            <span>Agent</span>
          </button>
          <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel" aria-label="Collapse agents panel">
            <Icon name="panelLeft" size={14} />
          </button>
        </div>
      </div>

      <div className="vb-agents__search">
        <Icon name="search" size={13} />
        <input
          ref={searchRef}
          placeholder="Filter by name or model…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="vb-agents__search-clear" onClick={() => setQuery("")} title="Clear" aria-label="Clear search">
            <Icon name="cross" size={11} />
          </button>
        )}
      </div>

      <div className="vb-agents__list" role="listbox" aria-label="Agents">
        {!hasOrch && agents.length === 0 && (
          <div className="vb-agents__empty" style={{ padding: "32px 16px", lineHeight: 1.7 }}>
            <Icon name="orchestrator" size={28} />
            <div style={{ marginTop: 10 }}>No orchestrator yet.</div>
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>
              Create one to pick a project directory and start dispatching workers.
            </div>
            <button className="vb-pillbtn vb-pillbtn--primary" style={{ marginTop: 14 }} onClick={onSpawnClick}>
              <Icon name="play" size={12} /> <span>Spawn orchestrator</span>
            </button>
          </div>
        )}
        {flat.length === 0 && hasOrch && (
          <div className="vb-agents__empty">
            <span>No agents match “{query}”</span>
          </div>
        )}
        {flat.map((a) => (
          <AgentRow key={a.id} agent={a} agents={agents} selected={selectedId === a.id} onSelect={onSelect} onContextMenu={onContextMenu} />
        ))}
      </div>

      <div className="vb-agents__foot">
        <div className="vb-footrow">
          <span className="vb-footrow__label">Session cost</span>
          <span className="vb-footrow__value">{fmtCost(session?.totalCost || 0)}</span>
        </div>
        <div className="vb-footrow">
          <span className="vb-footrow__label">Daemon</span>
          <span className={`vb-footrow__value ${online ? "vb-footrow__value--ok" : ""}`} style={online ? {} : { color: "var(--vb-err)" }}>
            <span className="vb-dot" style={online ? { background: "var(--vb-sage)", boxShadow: "0 0 6px var(--vb-sage)" } : { background: "var(--vb-err)", boxShadow: "0 0 6px var(--vb-err)" }} />
            {online ? "online" : "offline"}
          </span>
        </div>
      </div>
    </aside>
  );
});
