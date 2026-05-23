import { useUi } from "../../state/ui.jsx";

export function SideHandle() {
  const ui = useUi();
  if (!ui.sideCollapsed) return null;
  return (
    <button className="side-handle" onClick={() => ui.setSideCollapsed(false)} title="Show sidebar">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <line x1="6" y1="3" x2="6" y2="13" />
      </svg>
    </button>
  );
}
