import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigation } from "../state/navigation.jsx";
import { TABS } from "../views/tabs.js";

// Each view renders its own TabBar (inside its first sidebar card), so switching
// tabs remounts it — a pure-CSS transition can't span the remount. We remember
// the last active slot at module scope so the fresh instance starts the
// indicator at the previous tab and slides it to the active one.
//
// Keyed by variant: while collapsed the full sidebar stays mounted (just
// translated off-screen) AND the hover popup mounts a second TabBar, so both
// are live at once. A single shared slot let whichever committed first overwrite
// it, leaving the visible popup unable to detect a change and snapping without a
// slide — so each variant keeps its own last-active slot.
//
// The indicator is MEASURED from the active tab's real geometry (offsetLeft/
// offsetWidth), not an even-thirds assumption — the tabs are content-sized
// (e.g. "Workflows" is wider), so equal-thirds math misaligns the highlight.
const prevIndexByVariant = new Map();

export function TabBar({ variant = "full" }) {
  const { activeViewId, setActiveView } = useNavigation();
  const activeIndex = Math.max(0, TABS.findIndex((t) => t.id === activeViewId));
  const rootRef = useRef(null);
  const tabRefs = useRef([]);
  const [rect, setRect] = useState(null);

  const measure = (i) => {
    const el = tabRefs.current[i];
    return el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
  };

  useLayoutEffect(() => {
    const to = measure(activeIndex);
    if (!to) return;
    const prevIndex = prevIndexByVariant.get(variant);
    // Slide from the previous slot (set on the fresh mount) to the active one.
    if (prevIndex != null && prevIndex !== activeIndex) {
      const from = measure(prevIndex);
      prevIndexByVariant.set(variant, activeIndex);
      if (from) {
        setRect(from);
        const id = requestAnimationFrame(() => setRect(to));
        return () => cancelAnimationFrame(id);
      }
    }
    prevIndexByVariant.set(variant, activeIndex);
    setRect(to);
  }, [activeIndex]);

  // Tab widths shift when the web font swaps in or the sidebar is resized —
  // re-measure so the highlight stays pinned to the active tab. The
  // ResizeObserver also catches collapse→expand: while collapsed the sidebar
  // grid column is 0px, so this off-screen full TabBar measured its tabs at ~0
  // width; expanding snaps the column back to 280px but leaves activeIndex
  // unchanged, so the layout effect above won't re-fire — the observer does.
  useEffect(() => {
    const remeasure = () => setRect(measure(activeIndex));
    const id = setTimeout(remeasure, 160);
    window.addEventListener("resize", remeasure);
    const ro = new ResizeObserver(remeasure);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => { clearTimeout(id); window.removeEventListener("resize", remeasure); ro.disconnect(); };
  }, [activeIndex]);

  return (
    <div ref={rootRef} className="tabbar" role="tablist" aria-label="Workspace">
      {rect && <div className="tabbar__indicator" style={{ left: rect.left, width: rect.width }} />}
      {TABS.map((t, i) => {
        const active = t.id === activeViewId;
        return (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[i] = el; }}
            role="tab"
            aria-selected={active}
            className={"tabbar__tab" + (active ? " is-active" : "")}
            onClick={() => setActiveView(t.id)}
          >
            <t.Icon />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
