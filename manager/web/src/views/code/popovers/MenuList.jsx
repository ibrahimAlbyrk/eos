import { useEffect, useRef, useState } from "react";

// Data-driven menu pane. Items are "sep" or
//   { id, label, kbd?, danger?, run?, submenu?: item[] }
// — a submenu item opens a right-side flyout of the same row shape. Keyboard:
// ↑/↓ navigate, →/← open/close the flyout, Enter runs, and a single keypress
// matching a visible item's `kbd` runs it directly. Outside-click and Escape
// dismissal are owned by the shared popover plumbing (data-popover +
// closeAllPops); this component only calls onClose after running an item.
export function MenuList({ items, onClose }) {
  const paneRef = useRef(null);
  const rowRefs = useRef({});
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState(null);
  const [subActive, setSubActive] = useState(-1);

  useEffect(() => { paneRef.current?.focus(); }, []);

  const isItem = (it) => it !== "sep";
  const subItems = sub
    ? items.find((it) => isItem(it) && it.id === sub)?.submenu ?? null
    : null;

  const run = (it) => {
    if (!it || !it.run) return;
    it.run();
    onClose();
  };

  const select = (it) => {
    if (!it || !isItem(it)) return;
    if (it.submenu) { setSub(it.id); setSubActive(0); }
    else run(it);
  };

  const step = (from, dir, list) => {
    const n = list.length;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (isItem(list[i])) return i;
    }
    return from;
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") {
      if (subItems) setSubActive((i) => step(i, 1, subItems));
      else setActive((i) => step(i, 1, items));
    } else if (e.key === "ArrowUp") {
      if (subItems) setSubActive((i) => step(i, -1, subItems));
      else setActive((i) => step(i, -1, items));
    } else if (e.key === "ArrowRight") {
      const it = items[active];
      if (it && isItem(it) && it.submenu) { setSub(it.id); setSubActive(0); }
      else handled = false;
    } else if (e.key === "ArrowLeft") {
      if (sub) { setSub(null); setSubActive(-1); }
      else handled = false;
    } else if (e.key === "Enter") {
      if (subItems) run(subItems[subActive]);
      else select(items[active]);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const pool = subItems ?? items.filter(isItem);
      const hit = pool.find((it) => it.kbd?.toLowerCase() === e.key.toLowerCase());
      if (hit) run(hit);
      else handled = false;
    } else {
      handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  // The flyout is a SIBLING of the pane, not a child: WebKit won't apply a
  // backdrop-filter nested inside another backdrop-filtered element, which
  // made the nested version render flat. Positioned against the shared
  // .head-menu wrapper using the parent row's offsetTop.
  const flyTop = sub ? Math.max(0, (rowRefs.current[sub]?.offsetTop ?? 4) - 4) : 0;

  return (
    <>
      <div
        className="ctx-menu glass-pop open menu-pane"
        ref={paneRef}
        tabIndex={-1}
        role="menu"
        onKeyDown={onKeyDown}
      >
        {items.map((it, i) => {
          if (!isItem(it)) return <div key={`sep-${i}`} className="menu-sep" />;
          const cls = ["menu-item"];
          if (it.danger) cls.push("danger");
          if (i === active) cls.push("active");
          if (!it.submenu) {
            return (
              <button
                key={it.id}
                className={cls.join(" ")}
                onMouseEnter={() => { setActive(i); setSub(null); }}
                onClick={() => select(it)}
              >
                {it.label}
                {it.kbd && <span className="kbd">{it.kbd}</span>}
              </button>
            );
          }
          return (
            <button
              key={it.id}
              ref={(el) => { rowRefs.current[it.id] = el; }}
              className={cls.join(" ")}
              onMouseEnter={() => { setActive(i); setSub(it.id); }}
              onClick={() => setSub(sub === it.id ? null : it.id)}
            >
              {it.label}
              <svg className="sub-chev" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="m6 4 4 4-4 4" />
              </svg>
            </button>
          );
        })}
      </div>
      {subItems && (
        <div className="ctx-menu glass-pop open menu-flyout" style={{ top: flyTop }}>
          {subItems.map((s, si) => (
            <button
              key={s.id}
              className={`menu-item${si === subActive ? " active" : ""}${s.danger ? " danger" : ""}`}
              onMouseEnter={() => setSubActive(si)}
              onClick={() => run(s)}
            >
              {s.label}
              {s.kbd && <span className="kbd">{s.kbd}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
