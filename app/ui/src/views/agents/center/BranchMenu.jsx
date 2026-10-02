import { useLayoutEffect, useRef } from "react";
import { HighlightedName } from "./FileMenu.jsx";

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
    </svg>
  );
}

// `#` completion: the repo's local branches. Shares the @-menu's look.
export function BranchMenu({ branches, current, selectedIndex, onSelect, query }) {
  const listRef = useRef(null);

  useLayoutEffect(() => {
    const active = listRef.current?.querySelector(".file-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!branches.length) return null;

  return (
    <div className="cmd-menu file-menu">
      <div className="cmd-names">
        <div className="cmd-names-inner" ref={listRef}>
          {branches.map((name, i) => (
            <button
              key={name}
              className={"file-item" + (i === selectedIndex ? " active" : "")}
              onMouseDown={(e) => { e.preventDefault(); onSelect(name); }}
            >
              <span className="file-icon"><BranchIcon /></span>
              <span className="file-name">
                <HighlightedName name={name} query={query} />
              </span>
              {name === current && <span className="file-path">current</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
