import { fmtElapsedShort } from "../../lib/format.js";

function ScopeMini() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d="M1.5 8 H4 l1.4 -3.4 l2 6.8 l1.4 -4.8 l1.3 2.2 H14.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function TermMini() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6 L7 8 L4.5 10 M8.5 10.2 H11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// One background process. The whole row is clickable — selecting the owning
// agent and closing the panel. Shows what it watches/runs and how long it has
// been running ("started Nm ago", not a claim of liveness — the daemon only
// reliably knows the start; see BackgroundActivityService).
export function MonitorRow({ item, now, onSelect }) {
  const elapsed = fmtElapsedShort((now ?? Date.now()) - item.startedAt);
  return (
    <button
      type="button"
      className="mon-row"
      onClick={() => onSelect(item.workerId)}
      title={`Open ${item.workerName}`}
    >
      <span className={"mon-kind mon-kind--" + item.kind} aria-hidden="true">
        {item.kind === "monitor" ? <ScopeMini /> : <TermMini />}
      </span>
      <div className="mon-row-body">
        <div className="mon-row-top">
          <span className="mon-agent">{item.workerName}</span>
          <span className="mon-elapsed" title="elapsed since started">{elapsed}</span>
        </div>
        <div className="mon-label" title={item.label}>{item.label}</div>
      </div>
      <span className="mon-live-dot" title="running" />
    </button>
  );
}
