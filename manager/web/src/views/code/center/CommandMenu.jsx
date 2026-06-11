import { useLayoutEffect, useRef, useState } from "react";
import { CommandInfo } from "./CommandInfo.jsx";

function HighlightedName({ name, query }) {
  if (!query) return <span>{name}</span>;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span>{name}</span>;
  return (
    <span>
      {name.slice(0, idx)}
      <b>{name.slice(idx, idx + query.length)}</b>
      {name.slice(idx + query.length)}
    </span>
  );
}

export function CommandMenu({ commands, selectedIndex, onSelect, query }) {
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tooltipStyle, setTooltipStyle] = useState({});
  const selected = commands[selectedIndex] ?? null;

  useLayoutEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".cmd-item.active");
    if (!active) return;
    active.scrollIntoView({ block: "nearest" });

    const menuEl = menuRef.current;
    if (!menuEl) return;

    const menuH = menuEl.querySelector(".cmd-names")?.offsetHeight ?? menuEl.offsetHeight;
    const tooltipEl = tooltipRef.current;
    const tooltipH = tooltipEl ? tooltipEl.offsetHeight : 0;
    const raw = active.offsetTop;

    if (raw + tooltipH > menuH) {
      setTooltipStyle({ bottom: 0, top: "auto" });
    } else {
      setTooltipStyle({ top: raw });
    }
  }, [selectedIndex, selected?.description]);

  if (!commands.length) return null;

  return (
    <div className="cmd-menu" ref={menuRef}>
      <div className="cmd-names">
        <div className="cmd-names-inner" ref={listRef}>
          {commands.map((cmd, i) => (
            <button
              key={`${cmd.source ?? "cmd"}:${cmd.name}`}
              className={"cmd-item" + (i === selectedIndex ? " active" : "")}
              onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
            >
              <HighlightedName name={cmd.name} query={query} />
            </button>
          ))}
        </div>
      </div>
      {(selected?.description || selected?.source) && (
        <div className="cmd-tooltip" ref={tooltipRef} style={tooltipStyle}>
          <CommandInfo cmd={selected} />
        </div>
      )}
    </div>
  );
}
