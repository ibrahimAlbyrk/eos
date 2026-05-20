import { memo, useState } from "react";
import { Icon } from "../icons.jsx";

// Re-export Icon so other components in this folder can `import { Icon } from "./primitives.jsx"`.
export { Icon };

// Tiny clipboard button with a short "copied" feedback. Used on user bubbles,
// agent text blocks, and tool input/output panes.
export const CopyBtn = memo(function CopyBtn({ text, title = "Copy", className = "" }) {
  const [done, setDone] = useState(false);
  const click = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(text ?? ""));
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {}
  };
  return (
    <button className={`vb-copybtn ${done ? "is-done" : ""} ${className}`} onClick={click} title={done ? "Copied!" : title}>
      <Icon name={done ? "check" : "copy"} size={11} />
    </button>
  );
});

export const Avatar = memo(function Avatar({ agent, size = 28 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  return (
    <div className={`vb-avatar vb-avatar--${agent.role}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {agent.role === "main" ? (
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="currentColor"><path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/></svg>
      ) : initial}
    </div>
  );
});

export const StatusBadge = memo(function StatusBadge({ status }) {
  const labels = { running: "running", thinking: "thinking", waiting: "idle", queued: "queued", done: "done", error: "error", killed: "killed" };
  return (
    <span className={`vb-statbadge vb-statbadge--${status}`}>
      <span className="vb-statbadge__dot" />
      <span>{labels[status] || status}</span>
    </span>
  );
});

export const RingAvatar = memo(function RingAvatar({ agent, ctxPct: pct, size = 34 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  const cx = size / 2;
  const cy = size / 2;
  return (
    <div className="vb-ring-av" style={{ width: size, height: size }}>
      <svg className="vb-ring-av__svg" viewBox={`0 0 ${size} ${size}`}>
        <rect className="vb-ring-av__track" x="1.5" y="1.5" width={size - 3} height={size - 3} rx="7.5" fill="none" />
        <rect className={`vb-ring-av__fill vb-ring-av__fill--${agent.role}`}
              x="1.5" y="1.5" width={size - 3} height={size - 3} rx="7.5"
              fill="none" pathLength="100"
              strokeDasharray={`${pct} 100`}
              transform={`rotate(-90 ${cx} ${cy})`} />
      </svg>
      <div className={`vb-ring-av__face vb-ring-av__face--${agent.role}`}>
        {agent.role === "main" ? (
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/>
          </svg>
        ) : initial}
      </div>
    </div>
  );
});

export const SpawnChip = memo(function SpawnChip({ parent }) {
  if (!parent) return null;
  const initial = parent.role === "main" ? "★" : (parent.name?.[0] || "?").toUpperCase();
  return (
    <span className="vb-spawnchip" title={`Spawned by ${parent.name}`}>
      <span className="vb-spawnchip__arrow">↳</span>
      <span className={`vb-spawnchip__av vb-spawnchip__av--${parent.role}`}>{initial}</span>
      <span className="vb-spawnchip__name">{parent.name}</span>
    </span>
  );
});

export const LeftPanelHandle = memo(function LeftPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--left" onClick={onExpand} title="Show agents panel">
      <Icon name="panelLeft" size={14} />
    </button>
  );
});

export const RightPanelHandle = memo(function RightPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--right" onClick={onExpand} title="Show details panel">
      <Icon name="panelRight" size={14} />
    </button>
  );
});
