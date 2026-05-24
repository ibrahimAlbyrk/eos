import { useEffect, useRef } from "react";

export function CommandMenu({ commands, selectedIndex, onSelect }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".cmd-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!commands.length) return null;

  return (
    <div className="cmd-menu">
      <div className="cmd-list" ref={listRef}>
        {commands.map((cmd, i) => (
          <button
            key={cmd.name}
            className={"cmd-item" + (i === selectedIndex ? " active" : "")}
            onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
          >
            <span className="cmd-name">{cmd.name}</span>
            <span className="cmd-right">
              <span className="cmd-desc">{cmd.description}</span>
              <span className="cmd-source">({cmd.source})</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
