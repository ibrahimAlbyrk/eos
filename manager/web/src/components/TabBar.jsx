import { useEffect, useState } from "react";
import { useNavigation } from "../state/navigation.jsx";
import { TABS } from "../views/tabs.js";

// Each view renders its own TabBar (inside its first sidebar card), so switching
// tabs remounts it — a pure-CSS transition can't span the remount. We remember
// the last rendered slot at module scope so the fresh instance starts the
// selection outline at the previous tab and slides it to the active one.
let prevIndex = null;

export function TabBar() {
  const { activeViewId, setActiveView } = useNavigation();
  const activeIndex = Math.max(0, TABS.findIndex((t) => t.id === activeViewId));
  const [pos, setPos] = useState(prevIndex ?? activeIndex);

  // Slide from the previous slot to the active one after mount.
  useEffect(() => {
    if (pos !== activeIndex) {
      const id = requestAnimationFrame(() => setPos(activeIndex));
      return () => cancelAnimationFrame(id);
    }
  }, [pos, activeIndex]);

  useEffect(() => { prevIndex = activeIndex; }, [activeIndex]);

  return (
    <div className="tabbar" role="tablist" aria-label="Workspace">
      <div
        className="tabbar__indicator"
        style={{
          width: `calc(100% / ${TABS.length})`,
          transform: `translateX(calc(${pos} * 100%))`,
        }}
      />
      {TABS.map((t) => {
        const active = t.id === activeViewId;
        return (
          <button
            key={t.id}
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
