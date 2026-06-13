// Collapsed activity indicator: a small oscilloscope glyph whose trace sweeps
// while background processes run, with a live count. Clicking expands the panel.
function ScopeIcon() {
  return (
    <svg className="mon-scope" viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
      <path
        className="mon-scope-wave"
        d="M3.5 12 H7 l1.8 -4.6 l2.4 9.2 l1.8 -6 l1.4 2.4 H20.5"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function MonitorBeacon({ count, open, onClick }) {
  const label = `${count} background ${count === 1 ? "process" : "processes"} running`;
  return (
    <button
      type="button"
      className={"mon-beacon" + (open ? " mon-beacon--open" : "")}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <ScopeIcon />
      {count > 0 && <span className="mon-count">{count}</span>}
    </button>
  );
}
