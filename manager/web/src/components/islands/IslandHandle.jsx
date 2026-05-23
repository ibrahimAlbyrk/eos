import { useUi } from "../../state/ui.jsx";

// Always render the handle button — visibility is driven by the CSS rule
// `.islands.hidden + .island-handle { display: inline-flex }`. Conditional
// rendering would break the adjacent-sibling combinator.
export function IslandHandle() {
  const ui = useUi();
  return (
    <button className="island-handle" onClick={() => ui.setIslandsHidden(false)} title="Show agent details">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <line x1="10" y1="3" x2="10" y2="13" />
      </svg>
    </button>
  );
}
