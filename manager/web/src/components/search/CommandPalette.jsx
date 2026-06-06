import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useTemplates } from "../../hooks/useTemplates.js";
import { searchRegistry } from "../../search/index.js";
import { ResultIcon } from "./ResultIcon.jsx";

// Centered ⌘K command palette. Global (mounted once in the Shell) so it works
// on any tab. Aggregation + ranking live in the search registry; this component
// only renders groups and handles keyboard/mouse navigation.
export function CommandPalette({ live }) {
  const ui = useUi();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const templates = useTemplates();

  const ctx = useMemo(
    () => ({
      workers: live?.workers ?? [],
      workflows: live?.workflows ?? [],
      templates,
      setActiveView: ui.setActiveView,
      setSelectedId: ui.setSelectedId,
      updateComposer: ui.updateComposer,
      openSettings: ui.openSettings,
    }),
    [live?.workers, live?.workflows, templates, ui.setActiveView, ui.setSelectedId, ui.updateComposer, ui.openSettings],
  );

  const groups = useMemo(
    () => (ui.searchOpen ? searchRegistry.search(query, ctx) : []),
    [ui.searchOpen, query, ctx],
  );

  // Flat, ordered list mirrors the rendered order for arrow-key navigation.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => { setActive(0); }, [query, ui.searchOpen]);

  useEffect(() => {
    if (!ui.searchOpen) { setQuery(""); return; }
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [ui.searchOpen]);

  const choose = (item) => {
    if (!item) return;
    item.onSelect?.(ctx);
    ui.closeSearch();
  };

  // Capture phase + stopPropagation so Escape/Enter/arrows don't reach the
  // app-wide handlers (e.g. selection.jsx's Escape) while the palette is open.
  useEffect(() => {
    if (!ui.searchOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        ui.closeSearch();
      } else if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        choose(flat[active]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui.searchOpen, flat, active, ui.closeSearch]);

  useEffect(() => {
    listRef.current?.querySelector(".cmdk__item.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!ui.searchOpen) return null;

  let idx = -1;
  return (
    <div className="cmdk-overlay" onMouseDown={() => ui.closeSearch()}>
      <div
        className="cmdk glass-pop"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk__head">
          <svg className="cmdk__search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <path d="m13 13-2.5-2.5" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, workflows and templates…"
            spellCheck={false}
          />
          <button className="cmdk__close" title="Close (Esc)" onClick={() => ui.closeSearch()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="cmdk__list" ref={listRef}>
          {flat.length === 0 ? (
            <div className="cmdk__empty">
              {query ? "No results" : "Start typing to search…"}
            </div>
          ) : (
            groups.map((g) => (
              <div className="cmdk__group" key={g.id}>
                <div className="cmdk__group-label">{g.label}</div>
                {g.items.map((item) => {
                  idx += 1;
                  const i = idx;
                  const isActive = i === active;
                  return (
                    <button
                      key={item.id}
                      className={"cmdk__item" + (isActive ? " is-active" : "")}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(item)}
                    >
                      <span className="cmdk__item-icon"><ResultIcon name={item.icon} /></span>
                      <span className="cmdk__item-title">{item.title}</span>
                      {item.subtitle && <span className="cmdk__item-sub">{item.subtitle}</span>}
                      {isActive && (
                        <svg className="cmdk__enter" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13 4v3a2 2 0 0 1-2 2H4" />
                          <path d="M6.5 6.5 4 9l2.5 2.5" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
