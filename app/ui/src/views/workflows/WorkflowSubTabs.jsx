// The Workflows-tab view switcher: a sliding-pill tabbar reusing the app's
// .tabbar / .tabbar__indicator / .tabbar__tab classes verbatim. Unlike the
// sidebar TabBar this one never remounts on switch, so the indicator is a plain
// measured slide (no module-scope last-slot memory needed). Tabs are data-driven —
// adding the Runs view next phase is flipping its `disabled` flag.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function WorkflowSubTabs({ tabs, active, onChange }) {
  const tabRefs = useRef([]);
  const [rect, setRect] = useState(null);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === active));

  const measure = () => {
    const el = tabRefs.current[activeIndex];
    if (el) setRect({ left: el.offsetLeft, width: el.offsetWidth });
  };

  useLayoutEffect(measure, [activeIndex, tabs.length]);

  // Tab widths shift when the web font swaps in / the pane resizes — re-measure so
  // the pill stays pinned to the active tab.
  useEffect(() => {
    const id = setTimeout(measure, 160);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(id); window.removeEventListener("resize", measure); };
  }, [activeIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tabbar wfe-subtabs" role="tablist" aria-label="Workflow views">
      {rect && <div className="tabbar__indicator" style={{ left: rect.left, width: rect.width }} />}
      {tabs.map((t, i) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={t.disabled}
            title={t.disabled ? "Coming next phase" : undefined}
            className={"tabbar__tab" + (isActive ? " is-active" : "") + (t.disabled ? " is-disabled" : "")}
            onClick={() => { if (!t.disabled) onChange(t.id); }}
          >
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
