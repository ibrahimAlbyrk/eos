import { useUi } from "../../../state/ui.jsx";

function SpawnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function SidebarHead({ total, variant }) {
  const ui = useUi();
  const full = variant === "full";

  const handleSpawn = (e) => {
    e.stopPropagation();
    ui.setSelectedId(null);
  };

  return (
    <>
      <div className="sb-head">
        <div className="sb-head__title">
          Agents <span className="sb-head__count">{total}</span>
        </div>
        <div className="sb-head__actions">
          <button className="sb-iconbtn" title="New orchestrator" onClick={handleSpawn}>
            <SpawnIcon />
          </button>
          {full && (
            <>
              <button className="sb-iconbtn" title="Collapse sidebar" onClick={() => ui.setSideCollapsed(true)}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="2" y="3" width="12" height="10" rx="1.5" />
                  <line x1="6" y1="3" x2="6" y2="13" />
                </svg>
              </button>
              <button className="sb-iconbtn" title="Search (⌘K)" onClick={() => ui.openSearch()}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="7" cy="7" r="5" />
                  <path d="m13 13-2.5-2.5" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sb-divider"></div>

      {full && (
        <div className="sb-section">
          <span className="sb-section__title">Agents</span>
          <button className="sb-iconbtn" title="New orchestrator" onClick={handleSpawn}>
            <SpawnIcon />
          </button>
        </div>
      )}
    </>
  );
}
