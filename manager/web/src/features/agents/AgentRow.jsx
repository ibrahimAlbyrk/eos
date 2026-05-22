import { memo } from "react";
import { ctxPct, modelShort, liveElapsed } from "../../lib/format.js";
import { RingAvatar, StatusBadge, SpawnChip } from "../../components/primitives.jsx";

export const AgentRow = memo(function AgentRow({ agent, agents, selected, onSelect, onContextMenu }) {
  const pct = ctxPct(agent);
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : null;
  return (
    <div
      className={`vb-agentcard vb-agentcard--${agent.role} ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(agent.id)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu && onContextMenu(agent.id, e.clientX, e.clientY); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(agent.id); } }}
      role="option"
      aria-selected={selected}
      aria-current={selected ? "true" : undefined}
      aria-label={`${agent.name} — ${agent.status}, ${modelShort(agent.model)}`}
      tabIndex={0}
    >
      <RingAvatar agent={agent} ctxPct={pct} size={34} />
      <div className="vb-agentcard__main">
        <div className="vb-agentcard__name-row">
          <span className="vb-agentcard__name">{agent.name}</span>
          <StatusBadge status={agent.status} />
        </div>
        <div className="vb-agentcard__meta">
          <span>{modelShort(agent.model)}</span>
          <span className="vb-dot-sep">·</span>
          <span className="vb-mono">{liveElapsed(agent)}</span>
          <span className="vb-dot-sep">·</span>
          <span className="vb-mono vb-agentcard__ctx">{pct}% ctx</span>
        </div>
        {parent && <SpawnChip parent={parent} />}
      </div>
    </div>
  );
});
