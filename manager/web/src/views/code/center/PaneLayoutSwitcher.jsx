import { useUi } from "../../../state/ui.jsx";
import { MAX_PANES } from "../../../state/pane.jsx";

// Header control for the split layout. Each glyph mirrors the real arrangement:
// 1 full · 2 side-by-side · 3 left-one + right-two · 4 quad. Data-driven by
// MAX_PANES so a future 5th layout is one array entry + one CSS rule.
const COUNTS = Array.from({ length: MAX_PANES }, (_, i) => i + 1);

export function PaneLayoutSwitcher() {
  const ui = useUi();
  return (
    <div className="pane-switch" role="group" aria-label="Split layout">
      {COUNTS.map((n) => {
        const active = ui.paneCount === n;
        return (
          <button
            key={n}
            className={"pane-switch__btn" + (active ? " is-active" : "")}
            onClick={() => ui.setPaneCount(n)}
            aria-pressed={active}
            title={n === 1 ? "Single pane" : `Split into ${n} panes`}
          >
            <LayoutGlyph n={n} />
          </button>
        );
      })}
    </div>
  );
}

// Rounded-rect tiles laid out exactly like the live grid. r=1.4 / strokeWidth
// 1.2 keep the 16px glyph crisp at the header's small size.
function LayoutGlyph({ n }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      {n === 1 && <rect x="2.5" y="2.5" width="11" height="11" rx="1.4" />}
      {n === 2 && (
        <>
          <rect x="2.5" y="2.5" width="5" height="11" rx="1.4" />
          <rect x="8.5" y="2.5" width="5" height="11" rx="1.4" />
        </>
      )}
      {n === 3 && (
        <>
          <rect x="2.5" y="2.5" width="5" height="11" rx="1.4" />
          <rect x="8.5" y="2.5" width="5" height="5" rx="1.4" />
          <rect x="8.5" y="8.5" width="5" height="5" rx="1.4" />
        </>
      )}
      {n === 4 && (
        <>
          <rect x="2.5" y="2.5" width="5" height="5" rx="1.4" />
          <rect x="8.5" y="2.5" width="5" height="5" rx="1.4" />
          <rect x="2.5" y="8.5" width="5" height="5" rx="1.4" />
          <rect x="8.5" y="8.5" width="5" height="5" rx="1.4" />
        </>
      )}
    </svg>
  );
}
