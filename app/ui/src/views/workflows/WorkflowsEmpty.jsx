export function WorkflowsEmpty() {
  return (
    <div className="view-empty">
      <div className="view-empty__icon">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="6.5" height="6.5" rx="1.6" />
          <rect x="14.5" y="14.5" width="6.5" height="6.5" rx="1.6" />
          <path d="M9.5 6.25H15a2.5 2.5 0 0 1 2.5 2.5v5.75" />
        </svg>
      </div>
      <div className="view-empty__title">Workflows</div>
      <div className="view-empty__sub">Coming soon.</div>
    </div>
  );
}
